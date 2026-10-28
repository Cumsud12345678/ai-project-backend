import type { Deps } from "../src/deps.js";
import type { AddressInfo } from "node:net";
import { createApp } from "../src/app.js";
import { attachRealtime } from "../src/realtime.js";
import { AiError, type AiClient } from "../src/ai.js";
import type { Config } from "../src/config.js";
import { TelegramError, type TelegramApi } from "../src/telegram.js";
import { EventEmitter } from "node:events";
import { createWhatsAppManager, type WaSocket } from "../src/whatsapp/manager.js";
import { createLimiter } from "../src/security.js";
import { createMemoryStore } from "../src/store/memory.js";

export const config: Config = {
  port: 0, mongoUri: "", dbName: "", aiServiceUrl: "http://ai.test", aiServiceToken: "t", publicAdvisorUrl: "https://advisor.test", publicPortalUrl: "https://portal.test", brandName: "Car Advisor", brandUrl: "https://advisor.example",
  adminEmails: ["boss@example.com"], allowedOrigins: ["http://localhost:3001"], cookieSecure: false, sessionDays: 30,
  resendApiKey: undefined, mailFrom: "x", mailReplyTo: undefined, trustProxy: 1, secretKey: "test-secret-key-test-secret-key-0000", isProd: false,
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
    async feedPreview(b) { return rec("feedPreview", [b], { ok: true, format: "csv", count: 3, columns: [], suggestion: { fields: { title: "ad", id: "kod" }, defaults: {} }, sample: [], rawSample: [] }); },
    async feedStatus(id) { return rec("feedStatus", [id], { enabled: true, feed: { format: "csv", count: 3, updatedAt: "2026-10-28T00:00:00.000Z", refreshHours: 0 } }); },
    async feedRefresh(id, b) { return rec("feedRefresh", [id, b], { ok: true, count: 4 }); },
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
    async kbAddQa(...a) { return rec("kbAddQa", a, { source: { id: "qa1", type: "qa", status: "ready" } }); },
    async kbUpdateQa(...a) { return rec("kbUpdateQa", a, { source: { id: "qa1", type: "qa", status: "ready" } }); },
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

export type FakeWaSocket = WaSocket & { media?: Buffer | null; sent: { jid: string; text: string; id?: string }[]; images: { jid: string; bytes: number; caption: string }[]; presence: string[]; read: number; loggedOut: boolean; ended: boolean; emit(event: string, arg: unknown): void; tenantId: string };
/** Saxta WhatsApp: socketlər yadda saxlanır, hadisələr əl ilə göndərilir. */
export function fakeWhatsApp(batchMs = 0) {
  const sockets: FakeWaSocket[] = [];
  const manager = createWhatsAppManager({
    delay: () => 0, reconnectMs: () => 5, batchMs,
    async factory({ tenantId }) {
      const ev = new EventEmitter();
      const s: FakeWaSocket = {
        tenantId, sent: [], images: [], presence: [], read: 0, loggedOut: false, ended: false, user: { id: "994501234567:7@s.whatsapp.net" },
        ev: { on: (e, fn) => ev.on(e, fn) },
        async sendMessage(jid, c, o) { if ("image" in c) { s.images.push({ jid, bytes: c.image.length, caption: c.caption }); return { key: { id: o?.messageId } }; } s.sent.push({ jid, text: c.text, id: o?.messageId }); return { key: { id: o?.messageId } }; },
        async sendPresenceUpdate(t) { s.presence.push(t); },
        async readMessages() { s.read++; },
        async downloadMedia() { return s.media ?? null; },
        async logout() { s.loggedOut = true; },
        end() { s.ended = true; },
        emit: (e, a) => { ev.emit(e, a); },
      };
      sockets.push(s);
      return s;
    },
  });
  return { manager, sockets, last: () => sockets[sockets.length - 1]! };
}

export type FakeTelegram = TelegramApi & { sent: { token: string; chatId: string; text: string }[]; hooks: Map<string, { url: string; secret: string }>; actions: number; files: Map<string, Buffer>; photos: { chatId: string; url: string; caption: string }[]; failPhoto?: boolean; badToken?: string; failSend?: boolean };
/** Saxta Telegram: göndərilən mesajları və webhook-ları yadda saxlayır. */
export function fakeTelegram(): FakeTelegram {
  const tg: FakeTelegram = {
    sent: [], photos: [], files: new Map(), hooks: new Map(), actions: 0,
    async getMe(token) { if (token === tg.badToken) throw new TelegramError(401, "Unauthorized"); return { id: Number(token.split(":")[0]), username: `bot_${token.split(":")[0]}` }; },
    async setWebhook(token, o) { tg.hooks.set(token, o); },
    async deleteWebhook(token) { tg.hooks.delete(token); },
    async sendMessage(token, chatId, text) { if (tg.failSend) throw new TelegramError(500, "boom"); tg.sent.push({ token, chatId, text }); },
    async sendPhoto(_t, chatId, url, caption) { if (tg.failPhoto) throw new TelegramError(400, "bad url"); tg.photos.push({ chatId, url, caption }); },
    async downloadFile(_t, fileId) { return tg.files.get(fileId) ?? null; },
    async sendChatAction() { tg.actions++; },
  };
  return tg;
}

export async function startPortal(overrides: Partial<Config> = {}, waBatchMs = 0) {
  const store = createMemoryStore();
  const mails: { to: string; subject: string; text: string }[] = [];
  const ai = fakeAi();
  const telegram = fakeTelegram();
  const wa = fakeWhatsApp(waBatchMs);
  const deps: Deps = {
    config: { ...config, ...overrides }, store, ai, limiter: createLimiter(), telegramBatchMs: 0, telegram, whatsapp: wa.manager,
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

  return { base, store, mails, ai, telegram, wa, deps, client, signedIn, lastCode, close: () => new Promise<void>((r) => server.close(() => r())) };
}
