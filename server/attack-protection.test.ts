import { beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import { createServer } from "node:http";

const fake = vi.hoisted(() => {
  const rows = new Map<string, { id: string; data: any }>();
  const key = (table: string, id: string) => `${table}:${id}`;
  const from = (table: string) => {
    const query: any = {
      select: () => query,
      eq: (_column: string, id: string) => {
        query.id = id;
        return query;
      },
      maybeSingle: async () => ({
        data: query.id ? rows.get(key(table, query.id)) ?? null : null,
        error: null,
      }),
      upsert: async (row: { id: string; data: any }) => {
        rows.set(key(table, row.id), row);
        return { error: null };
      },
      delete: () => ({
        eq: async (_col: string, id: string) => {
          rows.delete(key(table, id));
          return { error: null };
        },
      }),
    };
    return query;
  };
  return {
    rows,
    from,
    auth: {
      signInWithPassword: vi.fn(),
      getUser: vi.fn(),
    },
  };
});

vi.mock("./supabase", () => ({ serverSupabase: fake }));

import { registerRoutes } from "./routes";
import { normalizeChallengeAnswer, resetBlockedSecurityStats } from "./security";

function extractCookieValue(setCookieHeaders: string[] | string | undefined, name: string): string {
  const list = Array.isArray(setCookieHeaders)
    ? setCookieHeaders
    : setCookieHeaders
      ? [setCookieHeaders]
      : [];
  for (const h of list) {
    const first = h.split(";")[0];
    if (first?.startsWith(`${name}=`)) return first;
  }
  return "";
}

function solveSvgMath(svgDataUri: string): string {
  const svg = decodeURIComponent(svgDataUri.replace("data:image/svg+xml;utf8,", ""));
  const matches = Array.from(svg.matchAll(/<text[^>]*>([^<]+)<\/text>/g)).map((m) =>
    m[1].trim(),
  );
  const a = Number(matches[0]);
  const b = Number(matches[2]);
  return String(a + b);
}

describe("Attack Protection Mode", () => {
  beforeEach(() => {
    fake.rows.clear();
    resetBlockedSecurityStats();
    fake.auth.getUser.mockResolvedValue({
      data: {
        user: {
          id: "admin-1",
          email: "admin@example.com",
          app_metadata: { role: "admin" },
        },
      },
      error: null,
    });
  });

  async function bootServer() {
    const app = express();
    app.use(express.json());
    const server = createServer(app);
    registerRoutes(server, app);
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : 0;
    return { server, base: `http://127.0.0.1:${port}` };
  }

  it("rejects unauthenticated access to attack-mode controls", async () => {
    const { server, base } = await bootServer();
    try {
      const statsRes = await fetch(`${base}/api/security/admin`);
      expect(statsRes.status).toBe(401);

      const toggleRes = await fetch(`${base}/api/security/attack-mode`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ enabled: true }),
      });
      expect(toggleRes.status).toBe(401);
    } finally {
      server.close();
    }
  });

  it("blocks unverified form floods when attack mode is active, allows verified humans, and caps flood rate", async () => {
    const { server, base } = await bootServer();
    const adminHeaders = {
      "content-type": "application/json",
      cookie: "sb-access-token=admin-token",
    };
    const browserHeaders = {
      "content-type": "application/json",
      "user-agent":
        "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148",
    };

    try {
      // Enable Attack Protection Mode as admin
      const enableRes = await fetch(`${base}/api/security/attack-mode`, {
        method: "POST",
        headers: adminHeaders,
        body: JSON.stringify({ enabled: true }),
      });
      expect(enableRes.status).toBe(200);
      expect((await enableRes.json()).data.enabled).toBe(true);

      // Direct unverified POST to pays must be rejected
      const botId = "visitor_123e4567-e89b-12d3-a456-426614174001";
      const unverifiedRes = await fetch(`${base}/api/db/pays/${botId}`, {
        method: "POST",
        headers: browserHeaders,
        body: JSON.stringify({
          payload: { name: "Fake Bot", phone: "+966500000001" },
          merge: true,
        }),
      });
      expect(unverifiedRes.status).toBe(403);
      expect(await unverifiedRes.json()).toMatchObject({
        error: "HUMAN_VERIFICATION_REQUIRED",
        code: "ATTACK_PROTECTION",
      });

      // Curl/automated UA is also blocked
      const curlRes = await fetch(`${base}/api/visitor/session`, {
        headers: { "user-agent": "curl/8.4.0" },
      });
      expect(curlRes.status).toBe(403);

      // Legitimate human fetches and solves SVG challenge
      const chRes = await fetch(`${base}/api/security/challenge`, {
        headers: browserHeaders,
      });
      expect(chRes.status).toBe(200);
      const { challengeToken, challengeSvg } = (await chRes.json()).data;
      const answer = solveSvgMath(challengeSvg);

      // Instant automated solve (< 900ms) is rejected as too fast
      const tooFastRes = await fetch(`${base}/api/security/verify`, {
        method: "POST",
        headers: browserHeaders,
        body: JSON.stringify({ challengeToken, answer }),
      });
      expect(tooFastRes.status).toBe(403);

      // Fetch fresh challenge and wait > 950ms like a real human
      const chRes2 = await fetch(`${base}/api/security/challenge`, {
        headers: browserHeaders,
      });
      const ch2 = (await chRes2.json()).data;
      const answer2 = solveSvgMath(ch2.challengeSvg);
      await new Promise((r) => setTimeout(r, 980));

      const verifyRes = await fetch(`${base}/api/security/verify`, {
        method: "POST",
        headers: browserHeaders,
        body: JSON.stringify({ challengeToken: ch2.challengeToken, answer: answer2 }),
      });
      expect(verifyRes.status).toBe(200);
      const humanCookie = extractCookieValue(
        verifyRes.headers.getSetCookie(),
        "human-verified",
      );
      expect(humanCookie).toContain("human-verified=");

      // Now creating up to 3 new pays records from same IP works, 4th gets rate-limited (429)
      for (let i = 1; i <= 3; i++) {
        const vid = `visitor_123e4567-e89b-12d3-a456-42661417401${i}`;
        const okRes = await fetch(`${base}/api/db/pays/${vid}`, {
          method: "POST",
          headers: { ...browserHeaders, cookie: humanCookie },
          body: JSON.stringify({
            payload: { name: `User ${i}`, phone: `+96650000001${i}` },
            merge: true,
          }),
        });
        expect(okRes.status).toBe(200);
      }

      const floodRes = await fetch(
        `${base}/api/db/pays/visitor_123e4567-e89b-12d3-a456-426614174099`,
        {
          method: "POST",
          headers: { ...browserHeaders, cookie: humanCookie },
          body: JSON.stringify({
            payload: { name: "Flood 4", phone: "+966500000099" },
            merge: true,
          }),
        },
      );
      expect(floodRes.status).toBe(429);

      // Admin sees incremented blockedCount & recentBlocked
      const adminStatsRes = await fetch(`${base}/api/security/admin`, {
        headers: adminHeaders,
      });
      expect(adminStatsRes.status).toBe(200);
      const adminStats = (await adminStatsRes.json()).data;
      expect(adminStats.enabled).toBe(true);
      expect(adminStats.blockedCount).toBeGreaterThanOrEqual(4);
      expect(adminStats.recentBlocked.length).toBeGreaterThan(0);

      // Turn attack mode OFF -> unverified access allowed again
      const disableRes = await fetch(`${base}/api/security/attack-mode`, {
        method: "POST",
        headers: adminHeaders,
        body: JSON.stringify({ enabled: false }),
      });
      expect(disableRes.status).toBe(200);
      expect((await disableRes.json()).data.enabled).toBe(false);

      const normalRes = await fetch(
        `${base}/api/db/pays/visitor_123e4567-e89b-12d3-a456-426614174088`,
        {
          method: "POST",
          headers: browserHeaders,
          body: JSON.stringify({ payload: { name: "Normal User" }, merge: true }),
        },
      );
      expect(normalRes.status).toBe(200);
    } finally {
      server.close();
    }
  });

  it("enforces server-side IP blocklist via __arrayUnion and normalizes Arabic numerals", async () => {
    expect(normalizeChallengeAnswer("١٢")).toBe("12");
    expect(normalizeChallengeAnswer(" ٩ ")).toBe("9");

    const { server, base } = await bootServer();
    const adminHeaders = {
      "content-type": "application/json",
      cookie: "sb-access-token=admin-token",
    };

    try {
      const banRes = await fetch(`${base}/api/db/settings/blockedIps`, {
        method: "POST",
        headers: adminHeaders,
        body: JSON.stringify({
          payload: { ips: { __arrayUnion: ["203.0.113.77"] } },
          merge: true,
        }),
      });
      expect(banRes.status).toBe(200);

      const blockedAttempt = await fetch(
        `${base}/api/db/pays/visitor_123e4567-e89b-12d3-a456-426614174055`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-forwarded-for": "203.0.113.77",
          },
          body: JSON.stringify({ payload: { name: "Attacker" }, merge: true }),
        },
      );
      expect(blockedAttempt.status).toBe(403);
      expect((await blockedAttempt.json()).error).toBe("IP_BLOCKED");
    } finally {
      server.close();
    }
  });
});
