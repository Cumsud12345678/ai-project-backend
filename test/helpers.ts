import { invalidateEntitlements } from "../src/plans.js";
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

export type FakeAi = AiClient & { calls: { fn: string; args: unknown[] }[]; failNext?: AiError; nextChat?: Record<string, unknown>; nextDraft?: Record<string, unknown>; heard?: string; aiState: Record<string, unknown>; pingFail: boolean; providerState: Record<string, unknown>; ent: Record<string, any>; reminders: Record<string, unknown>[]; payments: Record<string, { id: string; at: string; amountAzn: number }[]> | null };

/** Saxta AI servisi: çağırışları qeyd edir, istənilsə xəta qaytarır. */
export function fakeAi(): FakeAi {
  const calls: FakeAi["calls"] = [];
  let n = 0;
  const ai: FakeAi = {
    calls,
    async fetchSample(...a) { return rec("fetchSample", a, { ok: true, json: { data: [{ id: 1, title: "A", price: 10 }] }, ms: 5 }); },
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
    async queryTrend(...a) { return rec("queryTrend", a, { enabled: true, days: 7, daily: Array.from({ length: 7 }, (_, i) => ({ day: `2026-10-${String(22 + i).padStart(2, "0")}`, total: i, unanswered: i % 2 })) }); },
    async insights(...a) { return rec("insights", a, { asked: 12, topics: [{ name: "Çatdırılma", count: 8, unanswered: 2, examples: ["çatdırılma var?"] }], gaps: [{ title: "Çatdırılma qaydası", why: "Cavabsız qalıb", count: 2, examples: ["çatdırılma var?"] }], cached: false, analyzedAt: new Date().toISOString() }); },
    async queryStats(...a) { return rec("queryStats", a, { enabled: true, days: 30, total: 1, noResults: 0, errors: 0, cached: 0, top: [{ message: "toyota", count: 1 }], topNoResults: [] }); },
    async conversations(...a) { return rec("conversations", a, { enabled: true, hasMore: false, nextCursor: null, conversations: [{ sid: "aaaaaaaa11", startedAt: "2026-10-17T00:00:00.000Z", lastAt: "2026-10-17T00:01:00.000Z", messages: 2, first: "salam", unanswered: 0, costAzn: 0.01 }] }); },
    async kbUpdateLead(...a) { return rec("kbUpdateLead", a, { lead: { id: a[1], status: "open" } }); },
    async recordClick(...a) { return rec("recordClick", a, { ok: true }); },
    async conversation(...a) { return rec("conversation", a, { sid: "aaaaaaaa11", messages: [{ id: "1", at: "2026-10-17T00:00:00.000Z", message: "salam", answer: "Salam!", results: 1 }] }); },
    async privateData(...a) { return rec("privateData", a, { configured: false, identity: { configured: false } }); },
    async setPrivateData(...a) { return rec("setPrivateData", a, { configured: true, ready: false, identity: { configured: false } }); },
    async deletePrivateData(...a) { return rec("deletePrivateData", a, { ok: true }); },
    async newIdentitySecret(...a) { return rec("newIdentitySecret", a, { identitySecret: "cais_test" }); },
    async summarize(...a) { return rec("summarize", a, { summary: { summary: "Müştəri qiymət soruşur.", intent: "Qiymət öyrənmək", mood: "neutral", objections: ["Bahadır"], nextStep: "Endirim təklif et", temperature: "warm" } }); },
    async draft(...a) { const o = ai.nextDraft; ai.nextDraft = undefined; return rec("draft", a, o ?? { draft: "Salam, sizə necə kömək edə bilərəm?", usage: { tokens: 20 } }); },
    async actions(...a) { return rec("actions", a, { configured: false, items: [], signing: { configured: false } }); },
    async setActions(...a) { return rec("setActions", a, { configured: true, items: [], signing: { configured: true }, signingSecret: "casig_test" }); },
    async deleteActions(...a) { return rec("deleteActions", a, { ok: true }); },
    async newSigningSecret(...a) { return rec("newSigningSecret", a, { signingSecret: "casig_new" }); },
    async testAction(...a) { return rec("testAction", a, { preview: { method: "POST", url: "https://x", headers: {}, body: null } }); },
    async actionConfirm(...a) { return rec("actionConfirm", a, { status: "done", message: "Əməliyyat icra olundu." }); },
    async actionLog(...a) { return rec("actionLog", a, { entries: [] }); },
    async actionStats(...a: unknown[]) { return rec("actionStats", a, { items: [], done30: 0 }); },
    async clearActionLog(...a) { return rec("clearActionLog", a, { ok: true }); },
    async testOrderLookup(...a) { return rec("testOrderLookup", a, { found: true, title: "Sifariş", orderId: "10452", record: { Status: "Yoldadır" } }); },
    async testPrivateData(...a) { return rec("testPrivateData", a, { ok: true, records: [] }); },
    async clearQueries(...a) { return rec("clearQueries", a, { ok: true }); },
    async kbInfo(...a) { return rec("kbInfo", a, { mode: "support", sources: [], limits: { sources: 30, chunks: 2500, fileBytes: 6291456 }, totals: { sources: 0, chunks: 0 } }); },
    async kbAddFile(...a) { return rec("kbAddFile", a, { source: { id: "s1", status: "processing" } }); },
    async kbAddUrl(...a) { return rec("kbAddUrl", a, { source: { id: "s2", status: "processing" } }); },
    async kbAddText(...a) { return rec("kbAddText", a, { source: { id: "s3", status: "processing" } }); },
    async kbRefresh(...a) { return rec("kbRefresh", a, { source: { id: "s2", status: "processing" } }); },
    async transcribe(...a) { return rec("transcribe", a, { text: this.heard ?? "qara motosiklet axtarıram", unclear: false }); },
    async kbAddProc(...a) { return rec("kbAddProc", a, { source: { id: "pr1", type: "proc", status: "ready" } }); },
    async kbUpdateProc(...a) { return rec("kbUpdateProc", a, { source: { id: "pr1", type: "proc", status: "ready" } }); },
    async kbAddQa(...a) { return rec("kbAddQa", a, { source: { id: "qa1", type: "qa", status: "ready" } }); },
    async kbUpdateQa(...a) { return rec("kbUpdateQa", a, { source: { id: "qa1", type: "qa", status: "ready" } }); },
    async kbDelete(...a) { return rec("kbDelete", a, { ok: true }); },
    async kbUnanswered(...a) { return rec("kbUnanswered", a, { total: 0, items: [] }); },
    async kbDeleteUnanswered(...a) { return rec("kbDeleteUnanswered", a, { ok: true }); },
    async kbLeads(...a) { return rec("kbLeads", a, { total: 0, open: 0, items: [] }); },
    async kbAddLead(...a) { return rec("kbAddLead", a, { ok: true }); },
    async orderForm(...a) { return rec("orderForm", a, { form: null }); },
    async setOrderForm(...a) { return rec("setOrderForm", a, { form: a[1] }); },
    async deleteOrderForm(...a) { return rec("deleteOrderForm", a, { ok: true }); },
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
    async billingFinance(...a) { return rec("billingFinance", a, { months: [{ month: "2026-11", cashIn: { paidAzn: 10, manualAzn: 2, adjustAzn: 0, totalAzn: 12 }, billedAzn: 3, freeAzn: 1, revenueAzn: 2, costAzn: 1.2, profitAzn: 0.8, marginPct: 40, requests: 90 }], models: [{ model: "claude-haiku-5-5", provider: "anthropic", costAzn: 1, calls: 80, tokens: 1000, months: { "2026-11": 1 } }], tenants: [{ tenantId: "tenant-1", requests: 90, billedAzn: 3, freeAzn: 1, revenueAzn: 2, costAzn: 1.2, profitAzn: 0.8, markup: 1.5, customMarkup: false, balanceAzn: 6.2 }], totals: { cashInAzn: 40, cashInMonthAzn: 12, outstandingPaidAzn: 5, creditUsedAzn: 0, defaultMarkup: 1.5, usdAzn: 1.7 } }); },
    async suspendTenant(...a) { return rec("suspendTenant", a, { ok: true, suspended: a[1] }); },
    async billingRequestsQuery(q) { return rec("billingRequestsQuery", [q], { requests: [{ id: "r1", tenantId: "tenant-1", amountAzn: 10, status: "approved", provider: "manual", at: "2026-11-01T10:00:00.000Z", resolvedAt: "2026-11-01T11:00:00.000Z", resolvedBy: "boss@example.com" }], nextBefore: null }); },
    payments: null as Record<string, { id: string; at: string; amountAzn: number }[]> | null,
    async billingLedger(q) {
      // Partnyor testləri: müştəri üzrə ödənişlər (since/until süzgəci ilə)
      if (ai.payments && q.kind === "payment" && q.tenantId) {
        const list = (ai.payments[q.tenantId] ?? []).filter((e) => (!q.since || e.at >= q.since) && (!q.until || e.at < q.until));
        return rec("billingLedger", [q], { entries: list.map((e) => ({ ...e, tenantId: q.tenantId, kind: "payment", type: "topup", note: "", by: "" })), nextBefore: null });
      }
      return rec("billingLedger", [q], { entries: [{ id: "req:r1", tenantId: "tenant-1", at: "2026-11-01T11:00:00.000Z", kind: "payment", type: "topup", amountAzn: 10, note: "Yükləmə təsdiqləndi", by: "boss@example.com" }, { id: "x2", tenantId: "tenant-1", at: "2026-10-30T09:00:00.000Z", kind: "manual", type: "topup", amountAzn: 2, note: "=hədiyyə", by: "boss@example.com" }], nextBefore: null }); },
    aiState: { paused: false } as Record<string, unknown>,
    async aiControl() { return rec("aiControl", [], ai.aiState); },
    async setAiControl(b) { ai.aiState = b.paused ? { ...b, at: new Date().toISOString() } : { paused: false }; return rec("setAiControl", [b], ai.aiState); },
    ent: { source: "trial", plan: null, features: { channels: true, live: true, automations: true, campaigns: true, actions: true, customerData: true, noBranding: false }, seats: 6 } as Record<string, any>,
    reminders: [] as Record<string, unknown>[],
    async entitlements() { return ai.ent; }, // calls/failNext-ə yazılmır: hər çatda keşdən əvvəl çağırılır
    async billingOrder(id, body, dryRun) { return rec("billingOrder", [id, body, dryRun], dryRun ? { quote: { kind: body.kind, type: "new", plan: body.plan, cycle: body.cycle, amountAzn: 15 } } : { request: { id: "o1", tenantId: id, kind: body.kind, plan: body.plan, cycle: body.cycle, amountAzn: 15, status: "pending", provider: "manual", at: "2026-11-10T00:00:00.000Z" }, provider: "manual", instructions: "Kartdan karta" }); },
    async billingBonusReplies(id, body) { return rec("billingBonusReplies", [id, body], { duplicate: false, replies: body.replies }); },
    async billingPlanNext(id, plan) { return rec("billingPlanNext", [id, plan], { subscription: { plan: "business", next: plan } }); },
    async billingPlanAssign(id, body) { return rec("billingPlanAssign", [id, body], { subscription: body.plan ? { plan: body.plan } : null }); },
    async billingPlans() { return rec("billingPlans", [], { plans: [{ id: "start", name: "Start", priceAzn: 15, replies: 1000, seats: 1, features: { channels: true } }], packs: [{ id: "p500", replies: 500, priceAzn: 10 }], yearlyMonths: 10, graceDays: 3, packDays: 365 }); },
    async setBillingPlans(body) { return rec("setBillingPlans", [body], body as Record<string, unknown>); },
    async planReminders() { const r = ai.reminders; ai.reminders = []; return { reminders: r }; },
    providerState: {} as Record<string, unknown>,
    async providers() { return rec("providers", [], { providers: ai.providerState }); },
    pingFail: false,
    async ping() { rec("ping", [], null); if (ai.pingFail) throw new Error("AI servisinə qoşulmaq olmur"); },
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
        async sendMessage(jid, c, o) { if ("image" in c) { s.images.push({ jid, bytes: c.image.length, caption: c.caption }); return { key: { id: o?.messageId } }; } if ("document" in c) { s.images.push({ jid, bytes: c.document.length, caption: c.caption }); return { key: { id: o?.messageId } }; } s.sent.push({ jid, text: c.text, id: o?.messageId }); return { key: { id: o?.messageId } }; },
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
  invalidateEntitlements(); // plan imkanları keşi testlər arasında daşınmasın
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
