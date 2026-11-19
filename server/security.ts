import { createHash, randomInt, randomUUID, timingSafeEqual } from "node:crypto";
import { SignJWT, jwtVerify } from "jose";

export interface AttackProtectionSettings {
  enabled: boolean;
  enabledAt: string | null;
  updatedAt: string;
}

export interface BlockedAttemptEntry {
  ip: string;
  reason: string;
  path: string;
  at: string;
}

const HUMAN_VERIFIED_COOKIE = "human-verified";
const HUMAN_VERIFIED_AUDIENCE = "diriyah-human";
const HUMAN_CHALLENGE_AUDIENCE = "diriyah-human-challenge";
const HUMAN_VERIFIED_TTL_SECONDS = 60 * 60 * 2; // 2 hours
const MIN_HUMAN_SOLVE_MS = 900;
const MAX_RECENT_BLOCKED = 30;
const MAX_TRACKED_IPS = 1000;

const usedChallengeNonces = new Map<string, number>();
const sessionCreationHits = new Map<string, number[]>();
const paysCreationHits = new Map<string, number[]>();
const paysWriteHits = new Map<string, number[]>();
const challengeFetchHits = new Map<string, number[]>();

let blockedAttemptsCount = 0;
let recentBlockedAttempts: BlockedAttemptEntry[] = [];

const BOT_USER_AGENT_RE =
  /(curl\/|python-requests|python-urllib|aiohttp|httpx|postmanruntime|insomnia|go-http-client|scrapy|libwww-perl|wget|okhttp|headlesschrome|phantomjs|slimerjs|selenium|webdriver)/i;

export function extractClientIp(req: any): string {
  const forwarded = req?.headers?.["x-forwarded-for"];
  let ip = "";
  if (typeof forwarded === "string") {
    ip = forwarded.split(",")[0]?.trim() || "";
  } else if (Array.isArray(forwarded) && forwarded.length > 0) {
    ip = String(forwarded[0] || "").split(",")[0]?.trim() || "";
  }
  if (!ip && req?.headers?.["cf-connecting-ip"]) {
    ip = String(req.headers["cf-connecting-ip"]).trim();
  }
  if (!ip) ip = String(req?.ip || "").trim();
  if (ip.startsWith("::ffff:")) ip = ip.slice(7);
  return ip || "unknown";
}

export function isAutomatedUserAgent(req: any): boolean {
  const ua = String(req?.headers?.["user-agent"] || "").trim();
  if (!ua) return true;
  return BOT_USER_AGENT_RE.test(ua);
}

function hashIp(ip: string): string {
  return createHash("sha256").update(ip || "unknown").digest("hex").slice(0, 24);
}

function hashChallengeAnswer(jti: string, answer: string, secretBytes: Uint8Array): string {
  return createHash("sha256")
    .update(secretBytes)
    .update(`:${jti}:${answer}`)
    .digest("hex");
}

function getCookieFromReq(req: any, name: string): string {
  const rawCookie = String(req?.headers?.cookie || "");
  const match = rawCookie.match(new RegExp(`(?:^|;\\s*)${name}=([^;]+)`));
  return match?.[1] ? decodeURIComponent(match[1]) : "";
}

function pruneSlidingWindow(
  store: Map<string, number[]>,
  ip: string,
  windowMs: number,
  now: number,
): number[] {
  if (store.size > MAX_TRACKED_IPS) {
    for (const [key, stamps] of Array.from(store.entries())) {
      const fresh = stamps.filter((ts: number) => now - ts < windowMs);
      if (fresh.length === 0) store.delete(key);
      else store.set(key, fresh);
    }
  }
  const existing = store.get(ip) || [];
  const valid = existing.filter((ts) => now - ts < windowMs);
  store.set(ip, valid);
  return valid;
}

export function checkSlidingRateLimit(
  store: Map<string, number[]>,
  ip: string,
  maxHits: number,
  windowMs: number,
): boolean {
  const now = Date.now();
  const valid = pruneSlidingWindow(store, ip, windowMs, now);
  if (valid.length >= maxHits) {
    return false;
  }
  valid.push(now);
  store.set(ip, valid);
  return true;
}

export function checkChallengeFetchRateLimit(ip: string): boolean {
  return checkSlidingRateLimit(challengeFetchHits, ip, 25, 60_000);
}

export function checkNewSessionRateLimit(ip: string, attackModeEnabled: boolean): boolean {
  const maxSessions = attackModeEnabled ? 3 : 60;
  return checkSlidingRateLimit(sessionCreationHits, ip, maxSessions, 10 * 60_000);
}

export function checkPaysWriteRateLimit(
  ip: string,
  isNewDoc: boolean,
  attackModeEnabled: boolean,
): boolean {
  if (attackModeEnabled && isNewDoc) {
    const allowedNew = checkSlidingRateLimit(paysCreationHits, ip, 3, 10 * 60_000);
    if (!allowedNew) return false;
  }
  const maxWritesPerMin = attackModeEnabled ? 35 : 200;
  return checkSlidingRateLimit(paysWriteHits, ip, maxWritesPerMin, 60_000);
}

export function recordBlockedAttempt(ip: string, reason: string, path: string): void {
  blockedAttemptsCount += 1;
  const nowIso = new Date().toISOString();
  const last = recentBlockedAttempts[0];
  if (
    last &&
    last.ip === ip &&
    last.reason === reason &&
    Date.now() - new Date(last.at).getTime() < 3000
  ) {
    last.at = nowIso;
    return;
  }
  recentBlockedAttempts = [
    { ip, reason, path, at: nowIso },
    ...recentBlockedAttempts,
  ].slice(0, MAX_RECENT_BLOCKED);
}

export function getBlockedSecurityStats() {
  return {
    blockedCount: blockedAttemptsCount,
    recentBlocked: recentBlockedAttempts,
  };
}

export function resetBlockedSecurityStats() {
  blockedAttemptsCount = 0;
  recentBlockedAttempts = [];
  sessionCreationHits.clear();
  paysCreationHits.clear();
  paysWriteHits.clear();
  challengeFetchHits.clear();
}

export function normalizeChallengeAnswer(raw: unknown): string {
  const str = String(raw ?? "").trim();
  const normalizedDigits = str
    .replace(/[\u0660-\u0669]/g, (ch) => String(ch.charCodeAt(0) - 0x0660))
    .replace(/[\u06F0-\u06F9]/g, (ch) => String(ch.charCodeAt(0) - 0x06F0));
  return normalizedDigits.replace(/\s+/g, "");
}

function buildChallengeSvg(a: number, b: number): string {
  const rot1 = randomInt(-10, 11);
  const rot2 = randomInt(-8, 9);
  const rot3 = randomInt(-10, 11);
  const y1 = 36 + randomInt(-4, 5);
  const y2 = 36 + randomInt(-4, 5);
  const y3 = 36 + randomInt(-4, 5);
  const lineY1 = randomInt(12, 48);
  const lineY2 = randomInt(12, 48);

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="210" height="60" viewBox="0 0 210 60">
  <rect width="210" height="60" rx="12" fill="#FAF5F1" stroke="#E4D2C7" stroke-width="1.5"/>
  <path d="M12 ${lineY1} Q 105 ${randomInt(8, 52)}, 198 ${lineY2}" stroke="#C98A68" stroke-width="1.3" fill="none" opacity="0.45"/>
  <path d="M18 ${randomInt(12, 48)} Q 95 ${randomInt(8, 52)}, 190 ${randomInt(12, 48)}" stroke="#A85734" stroke-width="1" stroke-dasharray="4 4" fill="none" opacity="0.35"/>
  <circle cx="${randomInt(25, 65)}" cy="${randomInt(12, 48)}" r="2" fill="#C98A68" opacity="0.4"/>
  <circle cx="${randomInt(130, 185)}" cy="${randomInt(12, 48)}" r="2" fill="#A85734" opacity="0.35"/>
  <text x="34" y="${y1}" font-family="Arial, sans-serif" font-size="25" font-weight="700" fill="#3D2318" transform="rotate(${rot1} 34 ${y1})">${a}</text>
  <text x="72" y="${y2}" font-family="Arial, sans-serif" font-size="24" font-weight="700" fill="#A85734" transform="rotate(${rot2} 72 ${y2})">+</text>
  <text x="108" y="${y3}" font-family="Arial, sans-serif" font-size="25" font-weight="700" fill="#3D2318" transform="rotate(${rot3} 108 ${y3})">${b}</text>
  <text x="145" y="37" font-family="Arial, sans-serif" font-size="23" font-weight="700" fill="#6B5A52">=</text>
  <text x="172" y="38" font-family="Arial, sans-serif" font-size="24" font-weight="700" fill="#A85734">?</text>
</svg>`;
  return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
}

function pruneExpiredNonces(now: number) {
  if (usedChallengeNonces.size < 500) return;
  for (const [jti, exp] of Array.from(usedChallengeNonces.entries())) {
    if (exp <= now) usedChallengeNonces.delete(jti);
  }
}

export async function createHumanChallenge(
  req: any,
  secretBytes: Uint8Array,
): Promise<{ challengeToken: string; challengeSvg: string }> {
  const a = randomInt(2, 10);
  const b = randomInt(1, 10);
  const expected = String(a + b);
  const jti = randomUUID();
  const ipHash = hashIp(extractClientIp(req));
  const ansHash = hashChallengeAnswer(jti, expected, secretBytes);

  const challengeToken = await new SignJWT({
    scope: "human-challenge",
    ansHash,
    iatMs: Date.now(),
  })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(ipHash)
    .setJti(jti)
    .setAudience(HUMAN_CHALLENGE_AUDIENCE)
    .setIssuedAt()
    .setExpirationTime("5m")
    .sign(secretBytes);

  return {
    challengeToken,
    challengeSvg: buildChallengeSvg(a, b),
  };
}

export async function verifyHumanChallenge(
  req: any,
  body: { challengeToken?: unknown; answer?: unknown; honeypot?: unknown },
  secretBytes: Uint8Array,
): Promise<{ ok: true; verifiedToken: string } | { ok: false; status: number; error: string }> {
  const ip = extractClientIp(req);
  if (String(body?.honeypot || "").trim().length > 0) {
    recordBlockedAttempt(ip, "honeypot", "/api/security/verify");
    return { ok: false, status: 403, error: "BOT_DETECTED" };
  }

  const token = String(body?.challengeToken || "").trim();
  const answer = normalizeChallengeAnswer(body?.answer);
  if (!token || !answer) {
    return { ok: false, status: 400, error: "CHALLENGE_ANSWER_REQUIRED" };
  }

  try {
    const { payload } = await jwtVerify(token, secretBytes, {
      audience: HUMAN_CHALLENGE_AUDIENCE,
    });
    const jti = String(payload.jti || "");
    const ipHash = hashIp(ip);
    if (
      payload.scope !== "human-challenge" ||
      payload.sub !== ipHash ||
      !jti ||
      typeof payload.ansHash !== "string"
    ) {
      return { ok: false, status: 403, error: "INVALID_CHALLENGE" };
    }

    const now = Date.now();
    pruneExpiredNonces(now);
    if (usedChallengeNonces.has(jti)) {
      return { ok: false, status: 403, error: "CHALLENGE_EXPIRED" };
    }

    const iatMs = Number(payload.iatMs || 0);
    if (!iatMs || now - iatMs < MIN_HUMAN_SOLVE_MS) {
      recordBlockedAttempt(ip, "too_fast_solve", "/api/security/verify");
      return { ok: false, status: 403, error: "TOO_FAST" };
    }

    // Single-use nonce: mark consumed immediately so a challenge cannot be brute-forced
    usedChallengeNonces.set(jti, now + 5 * 60_000);

    const candidateHash = hashChallengeAnswer(jti, answer, secretBytes);
    const aBuf = Buffer.from(candidateHash, "hex");
    const bBuf = Buffer.from(payload.ansHash, "hex");
    if (aBuf.length !== bBuf.length || !timingSafeEqual(aBuf, bBuf)) {
      recordBlockedAttempt(ip, "wrong_challenge_answer", "/api/security/verify");
      return { ok: false, status: 400, error: "INVALID_CHALLENGE_ANSWER" };
    }

    const verifiedToken = await new SignJWT({ scope: "human-verified" })
      .setProtectedHeader({ alg: "HS256" })
      .setSubject(ipHash)
      .setAudience(HUMAN_VERIFIED_AUDIENCE)
      .setIssuedAt()
      .setExpirationTime(`${HUMAN_VERIFIED_TTL_SECONDS}s`)
      .sign(secretBytes);

    return { ok: true, verifiedToken };
  } catch {
    return { ok: false, status: 403, error: "CHALLENGE_EXPIRED" };
  }
}

export async function hasHumanVerification(
  req: any,
  secretBytes: Uint8Array,
): Promise<boolean> {
  const token = getCookieFromReq(req, HUMAN_VERIFIED_COOKIE);
  if (!token) return false;
  try {
    const { payload } = await jwtVerify(token, secretBytes, {
      audience: HUMAN_VERIFIED_AUDIENCE,
    });
    return (
      payload.scope === "human-verified" &&
      payload.sub === hashIp(extractClientIp(req))
    );
  } catch {
    return false;
  }
}

export function setHumanVerifiedCookie(res: any, token: string): void {
  res.append(
    "Set-Cookie",
    `${HUMAN_VERIFIED_COOKIE}=${encodeURIComponent(token)}; Path=/; Max-Age=${HUMAN_VERIFIED_TTL_SECONDS}; HttpOnly; SameSite=Lax${process.env.NODE_ENV === "production" ? "; Secure" : ""}`,
  );
}

export function resolveFieldMutations(
  existingData: Record<string, any> | null | undefined,
  payload: Record<string, any> | null | undefined,
): Record<string, any> {
  const base = { ...(existingData || {}) };
  const incoming = payload || {};
  const merged: Record<string, any> = { ...base, ...incoming };

  for (const [key, val] of Object.entries(incoming)) {
    if (val && typeof val === "object" && !Array.isArray(val)) {
      if (Array.isArray((val as any).__arrayUnion)) {
        const current = Array.isArray(base[key]) ? [...base[key]] : [];
        for (const item of (val as any).__arrayUnion) {
          if (!current.includes(item)) current.push(item);
        }
        merged[key] = current;
      } else if (Array.isArray((val as any).__arrayRemove)) {
        const toRemove = new Set((val as any).__arrayRemove);
        const current = Array.isArray(base[key]) ? base[key] : [];
        merged[key] = current.filter((item: any) => !toRemove.has(item));
      }
    }
  }

  return merged;
}
