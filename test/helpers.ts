import type { AddressInfo } from "node:net";
import { createApp } from "../src/app.js";
import { attachRealtime } from "../src/realtime.js";
import { AiError, type AiClient } from "../src/ai.js";
import type { Config } from "../src/config.js";
import { createLimiter } from "../src/security.js";
import { createMemoryStore } from "../src/store/memory.js";

export const config: Config = {
  port: 0, mongoUri: "", dbName: "", aiServiceUrl: "http://ai.test", aiServiceToken: "t", publicAdvisorUrl: "https://advisor.test", publicPortalUrl: "https://portal.test",
  adminEmails: ["boss@example.com"], allowedOrigins: ["http://localhost:3001"], cookieSecure: false, sessionDays: 30,
  smtpUrl: undefined, mailFrom: "x", trustProxy: 1, isProd: false,
};

export type FakeAi = AiClient & { calls: { fn: string; args: unknown[] }[]; failNext?: AiError; nextChat?: Record<string, unknown> };

/** Saxta AI servisi: çağırışları qeyd edir, istənilsə xəta qaytarır. */
export function fakeAi(): FakeAi {
  const calls: FakeAi["calls"] = [];
  let n = 0;
  const ai: FakeAi = {
    calls,
    async testConfig(...a) { return rec("testConfig", a, { ok: true, sampleCount: 2, sampleListings: [{ id: "1", title: "A", price: 1 }], supportedFilters: ["maxPrice"], debug: { dropped: [] } }); },
    async createTenant(...a) { return rec("createTenant", a, { ok: true, tenantId: `tenant-${++n}`, apiKey: `ca_live_key${n}`, sampleCount: 2, sampleListings: [] }); },
    async updateConfig(...a) { return rec("updateConfig", a, { ok: true, sampleCount: 2, sampleListings: [] }); },
    async patchProfile(id, p) { return rec("patchProfile", [id, p], { ok: true, profile: { language: "az", maxResults: 5, ...(p as object) } }); },
    async rotateKey(...a) { return rec("rotateKey", a, { ok: true, apiKey: `ca_live_rotated${++n}` }); },
    async deleteTenant(...a) { return rec("deleteTenant", a, { ok: true }); },
    async usage(...a) { return rec("usage", a, { month: "2026-10", requests: 3, tokens: 100, limits: { monthlyRequests: 500, ratePerMinute: 20 } }); },
    async usageSummary(...a) { return rec("usageSummary", a, { today: { date: "2026-10-19", requests: 2, tokens: 60 }, thisMonth: { month: "2026-10", requests: 5, tokens: 150 }, lastMonth: { month: "2026-09", requests: 0, tokens: 0 }, daily: [], monthly: [], tenants: [{ tenantId: "tenant-1", requests: 5, tokens: 150 }, { tenantId: "gone", requests: 1, tokens: 1 }] }); },
    async listings(...a) { return rec("listings", a, { count: 0, listings: [] }); },
    async queries(...a) { return rec("queries", a, { enabled: true, retentionDays: 90, total: 1, queries: [{ id: "1", at: "2026-10-17T00:00:00.000Z", message: "toyota", results: 2, tokens: 30, cached: false, error: false }] }); },
    async queryStats(...a) { return rec("queryStats", a, { enabled: true, days: 30, total: 1, noResults: 0, errors: 0, cached: 0, top: [{ message: "toyota", count: 1 }], topNoResults: [] }); },
    async conversations(...a) { return rec("conversations", a, { enabled: true, hasMore: false, nextCursor: null, conversations: [{ sid: "aaaaaaaa11", startedAt: "2026-10-17T00:00:00.000Z", lastAt: "2026-10-17T00:01:00.000Z", messages: 2, first: "salam", unanswered: 0, costAzn: 0.01 }] }); },
    async conversation(...a) { return rec("conversation", a, { sid: "aaaaaaaa11", messages: [{ id: "1", at: "2026-10-17T00:00:00.000Z", message: "salam", answer: "Salam!", results: 1 }] }); },
    async privateData(...a) { return rec("privateData", a, { configured: false, identity: { configured: false } }); },
    async setPrivateData(...a) { return rec("setPrivateData", a, { configured: true, ready: false, identity: { configured: false } }); },
    async deletePrivateData(...a) { return rec("deletePrivateData", a, { ok: true }); },
    async newIdentitySecret(...a) { return rec("newIdentitySecret", a, { identitySecret: "cais_test" }); },
    async testPrivateData(...a) { return rec("testPrivateData", a, { ok: true, records: [] }); },
    async clearQueries(...a) { return rec("clearQueries", a, { ok: true }); },
    async kbInfo(...a) { return rec("kbInfo", a, { mode: "support", sources: [], limits: { sources: 30, chunks: 2500, fileBytes: 6291456 }, totals: { sources: 0, chunks: 0 } }); },
    async kbAddFile(...a) { return rec("kbAddFile", a, { source: { id: "s1", status: "processing" } }); },
    async kbAddUrl(...a) { return rec("kbAddUrl", a, { source: { id: "s2", status: "processing" } }); },
    async kbAddText(...a) { return rec("kbAddText", a, { source: { id: "s3", status: "processing" } }); },
    async kbRefresh(...a) { return rec("kbRefresh", a, { source: { id: "s2", status: "processing" } }); },
    async kbDelete(...a) { return rec("kbDelete", a, { ok: true }); },
    async kbUnanswered(...a) { return rec("kbUnanswered", a, { total: 0, items: [] }); },
    async kbDeleteUnanswered(...a) { return rec("kbDeleteUnanswered", a, { ok: true }); },
    async kbLeads(...a) { return rec("kbLeads", a, { total: 0, open: 0, items: [] }); },
    async kbAddLead(...a) { return rec("kbAddLead", a, { ok: true }); },
    async kbHandleLead(...a) { return rec("kbHandleLead", a, { lead: {} }); },
    async kbDeleteLead(...a) { return rec("kbDeleteLead", a, { ok: true }); },
    async chat(...a) { const o = ai.nextChat; ai.nextChat = undefined; return rec("chat", a, o ?? { answer: "Salam", listings: [], usage: { tokens: 5 } }); },
    async billing(...a) { return rec("billing", a, { balance: { freeAzn: 1.2, paidAzn: 5, totalAzn: 6.2 }, state: "ok", enforced: true, allowance: { freeAzn: 2, period: "monthly" }, minTopupAzn: 10, maxTopupAzn: 1000, lowAzn: 1,
      spend: { monthAzn: 0.8, monthRequests: 30, last30Azn: 0.8, last30Requests: 30, avgPerRequestAzn: 0.0267, defaultAvgAzn: 0.035, projectedMonthAzn: 2.4 }, pendingRequests: [], days: [], ledger: [], ...(a[1] ? { admin: { markup: null, defaultMarkup: 1.5, creditLimitAzn: 0, costAzn30: 0.53, lifetimeSpentAzn: 0.8 } } : {}) }); },
    async billingTopupRequest(id, amt) { return rec("billingTopupRequest", [id, amt], { request: { id: "r1", tenantId: id, amountAzn: amt, status: "pending", provider: "manual", at: "2026-10-22T00:00:00.000Z" }, provider: "manual", instructions: "Kartdan karta" }); },
    async billingTopup(id, b) { return rec("billingTopup", [id, b], { duplicate: false, balance: { freeAzn: 0, paidAzn: b.amountAzn, totalAzn: b.amountAzn } }); },
    async billingSettings(id, b) { return rec("billingSettings", [id, b], { admin: { markup: b.markup ?? null, defaultMarkup: 1.5, creditLimitAzn: b.creditLimitAzn ?? 0 } }); },
    async billingRequests(status) { return rec("billingRequests", [status], { requests: [{ id: "r1", tenantId: "tenant-1", amountAzn: 10, status, provider: "manual", at: "2026-10-22T00:00:00.000Z" }, { id: "r2", tenantId: "gone", amountAzn: 20, status, provider: "manual", at: "2026-10-21T00:00:00.000Z" }] }); },
    async billingResolve(id, action, by) { return rec("billingResolve", [id, action, by], { request: { id, tenantId: "tenant-1", amountAzn: 10, status: action === "approve" ? "approved" : "rejected" }, ...(action === "approve" && { duplicate: false, balance: { totalAzn: 16.2 } }) }); },
    async billingAccounts() { return rec("billingAccounts", [], { accounts: [{ tenantId: "tenant-1", totalAzn: 6.2, paidAzn: 5, spentAzn: 0.8 }] }); },
  };
  function rec<T>(fn: string, args: unknown[], value: T): T {
    calls.push({ fn, args });
    if (ai.failNext) { const e = ai.failNext; ai.failNext = undefined; throw e; }
    return value;
  }
  return ai;
}

export async function startPortal(overrides: Partial<Config> = {}) {
  const store = createMemoryStore();
  const mails: { to: string; subject: string; text: string }[] = [];
  const ai = fakeAi();
  const deps = {
    config: { ...config, ...overrides }, store, ai, limiter: createLimiter(),
    mailer: { async send(to: string, subject: string, text: string) { mails.push({ to, subject, text }); } },
  };
  const app = createApp(deps);
  const server = await new Promise<import("node:http").Server>((res) => { const s = app.listen(overrides.port ?? 0, () => res(s)); });
  attachRealtime(server, deps);
  const base = `http://localhost:${(server.address() as AddressInfo).port}`;
  const lastCode = (to: string) => {
    const m = [...mails].reverse().find((x) => x.to === to);
    return m?.text.match(/\b(\d{6})\b/)?.[1] ?? "";
  };

  /** Cookie saxlayan sadə müştəri (brauzer kimi). Hər müştərinin öz IP-si var (X-Forwarded-For). */
  let ipCounter = 0;
  function client() {
    let cookie = "";
    const ip = `10.0.${Math.floor(ipCounter / 250)}.${(ipCounter++ % 250) + 1}`;
    const call = async (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) => {
      const res = await fetch(base + path, {
        method,
        headers: { "content-type": "application/json", origin: "http://localhost:3001", "x-forwarded-for": ip, ...(cookie && { cookie }), ...headers },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const set = res.headers.get("set-cookie");
      if (set) cookie = set.split(";")[0]!.endsWith("=") ? "" : set.split(";")[0]!;
      return { status: res.status, body: (await res.json().catch(() => ({}))) as any, setCookie: set };
    };
    return { call, get cookie() { return cookie; } };
  }

  /** Hesab açır, təsdiqləyir, daxil olmuş müştəri qaytarır. */
  async function signedIn(email = "user@example.com", password = "parol12345") {
    const c = client();
    const reg = await c.call("POST", "/auth/register", { email, password });
    if (reg.status !== 201) throw new Error(`register ${reg.status} ${JSON.stringify(reg.body)}`);
    const v = await c.call("POST", "/auth/verify", { email, code: lastCode(email) });
    if (v.status !== 200) throw new Error(`verify ${v.status} ${JSON.stringify(v.body)}`);
    return c;
  }

  return { base, store, mails, ai, client, signedIn, lastCode, close: () => new Promise<void>((r) => server.close(() => r())) };
}
