// AI servisinin (car-advisor) /v1/service/* endpoint-lərinin müştərisi.
export class AiError extends Error {
  constructor(public status: number, message: string, public code?: string, public body?: Record<string, unknown>) { super(message); }
}

export type AiResult = Record<string, any>;

export type AiClient = {
  testConfig(config: object): Promise<AiResult>;
  /** Qoşulma sehirbazı: API ünvanının xam cavabı (server çağırır, CORS olmur) */
  fetchSample(body: object): Promise<AiResult>;
  createTenant(config: object): Promise<AiResult>;
  updateConfig(tenantId: string, config: object): Promise<AiResult>;
  patchProfile(tenantId: string, profile: object): Promise<AiResult>;
  feedPreview(body: object): Promise<AiResult>;
  feedStatus(tenantId: string): Promise<AiResult>;
  feedRefresh(tenantId: string, body: object): Promise<AiResult>;
  rotateKey(tenantId: string): Promise<AiResult>;
  deleteTenant(tenantId: string): Promise<AiResult>;
  usage(tenantId: string): Promise<AiResult>;
  usageSummary(): Promise<AiResult>;
  listings(tenantId: string, query: string): Promise<AiResult>;
  chat(tenantId: string, message: string, history: unknown[], opts?: { test?: boolean; sid?: string; identity?: string; /** canlı operator açıqdır: AI operatora ötürmə qərarı verə bilər */ live?: boolean; /** base64 şəkil (şəkilli sual) */ image?: string; /** əməliyyat təsdiqi hansı kanaldadır */ channel?: "widget" | "telegram" | "whatsapp"; /** operatora ötürmə qaydaları (sahibin ayarı) */ handoff?: { cantHelp: boolean; upset: boolean; ready: boolean }; /** müştəriyə sonradan yazmaq üçün kanal ünvanı (sifariş/randevu ilə saxlanır) */ reach?: { type: "telegram" | "whatsapp"; chatId: string; ref?: string; lang?: string } }): Promise<AiResult>;
  privateData(tenantId: string): Promise<AiResult>;
  setPrivateData(tenantId: string, body: object): Promise<AiResult>;
  deletePrivateData(tenantId: string): Promise<AiResult>;
  newIdentitySecret(tenantId: string): Promise<AiResult>;
  testPrivateData(tenantId: string, body: { kind: string; userId: string }): Promise<AiResult>;
  testOrderLookup(tenantId: string, body: { orderId: string; phone: string }): Promise<AiResult>;
  summarize(tenantId: string, messages: { from: string; text: string }[]): Promise<AiResult>;
  draft(tenantId: string, body: { messages: { from: string; text: string }[]; context: { role: string; text: string }[] }): Promise<AiResult>;
  actions(tenantId: string): Promise<AiResult>;
  setActions(tenantId: string, body: object): Promise<AiResult>;
  deleteActions(tenantId: string): Promise<AiResult>;
  newSigningSecret(tenantId: string): Promise<AiResult>;
  testAction(tenantId: string, body: object): Promise<AiResult>;
  actionConfirm(tenantId: string, body: { id: string; decision: "confirm" | "cancel"; sid: string; identity?: string }): Promise<AiResult>;
  actionLog(tenantId: string): Promise<AiResult>;
  actionStats(tenantId: string, days?: number): Promise<AiResult>;
  clearActionLog(tenantId: string): Promise<AiResult>;
  conversations(tenantId: string, query: string): Promise<AiResult>;
  conversation(tenantId: string, sid: string): Promise<AiResult>;
  recordClick(tenantId: string, sid: string, c: { id: string; title: string }): Promise<AiResult>;
  queries(tenantId: string, query: string): Promise<AiResult>;
  queryStats(tenantId: string, days?: number): Promise<AiResult>;
  queryTrend(tenantId: string, days?: number): Promise<AiResult>;
  /** Sualları mövzulara bölür və biliyə nə əlavə olunmalı olduğunu təklif edir (AI, balansdan çıxılır) */
  insights(tenantId: string, body: { days?: number; fresh?: boolean; cachedOnly?: boolean; disliked?: string[] }): Promise<AiResult>;
  clearQueries(tenantId: string): Promise<AiResult>;
  kbInfo(tenantId: string): Promise<AiResult>;
  kbAddFile(tenantId: string, file: { name: string; mime: string; data: string }): Promise<AiResult>;
  kbAddUrl(tenantId: string, url: string, crawl: boolean): Promise<AiResult>;
  kbAddText(tenantId: string, title: string, text: string): Promise<AiResult>;
  /** Səsli mesajı mətnə çevirir (base64 audio). Xərc müştərinin balansından çıxılır. */
  transcribe(tenantId: string, audio: string): Promise<AiResult>;
  kbAddProc(tenantId: string, body: { name: string; triggers: string[]; steps: string }): Promise<AiResult>;
  kbUpdateProc(tenantId: string, sourceId: string, body: { name: string; triggers: string[]; steps: string }): Promise<AiResult>;
  kbAddQa(tenantId: string, body: { questions: string[]; answer: string }): Promise<AiResult>;
  kbUpdateQa(tenantId: string, sourceId: string, body: { questions: string[]; answer: string }): Promise<AiResult>;
  kbRefresh(tenantId: string, sourceId: string): Promise<AiResult>;
  kbDelete(tenantId: string, sourceId: string): Promise<AiResult>;
  kbUnanswered(tenantId: string): Promise<AiResult>;
  kbDeleteUnanswered(tenantId: string, id: string): Promise<AiResult>;
  kbLeads(tenantId: string, kind?: "order" | "booking"): Promise<AiResult>;
  booking(tenantId: string): Promise<AiResult>;
  kbLearn(tenantId: string, b: { messages: { from: "visitor" | "operator"; text: string }[]; chatId?: string }): Promise<AiResult>;
  kbSuggestions(tenantId: string): Promise<AiResult>;
  kbDeleteSuggestion(tenantId: string, id: string): Promise<AiResult>;
  kbAcceptSuggestion(tenantId: string, id: string, b: { questions?: string[]; answer?: string }): Promise<AiResult>;
  setBooking(tenantId: string, b: object): Promise<AiResult>;
  deleteBooking(tenantId: string): Promise<AiResult>;
  orderForm(tenantId: string): Promise<AiResult>;
  setOrderForm(tenantId: string, form: object): Promise<AiResult>;
  deleteOrderForm(tenantId: string): Promise<AiResult>;
  kbAddLead(tenantId: string, lead: { name: string; contact: string; question: string; conversation?: { role: string; text: string }[] }): Promise<AiResult>;
  kbHandleLead(tenantId: string, id: string, handled: boolean): Promise<AiResult>;
  kbUpdateLead(tenantId: string, id: string, patch: Record<string, unknown>): Promise<AiResult>;
  kbDeleteLead(tenantId: string, id: string): Promise<AiResult>;
  billing(tenantId: string, admin?: boolean): Promise<AiResult>;
  billingTopupRequest(tenantId: string, amountAzn: number): Promise<AiResult>;
  /** ref: təkrar-qoruma açarı (eyni ref ikinci dəfə pul əlavə etmir) */
  billingTopup(tenantId: string, body: { amountAzn: number; note?: string; by?: string; ref?: string }): Promise<AiResult>;
  billingSettings(tenantId: string, body: { markup?: number | null; creditLimitAzn?: number; dailyLimitAzn?: number | null }): Promise<AiResult>;
  billingRequests(status: string): Promise<AiResult>;
  billingResolve(requestId: string, action: "approve" | "reject", by: string): Promise<AiResult>;
  billingAccounts(): Promise<AiResult>;
  /** Admin: ay üzrə pul girişi, AI xərci, mənfəət; model və müştəri üzrə bölgü */
  billingFinance(months?: number): Promise<AiResult>;
  /** Admin: müştərinin AI sorğularını dayandırır / bərpa edir */
  suspendTenant(tenantId: string, suspended: boolean): Promise<AiResult>;
  /** Admin "Ödənişlər": süzgəcli sorğu siyahısı (status=all, tenantId, since, until, before, limit) */
  billingRequestsQuery(q: Record<string, string>): Promise<AiResult>;
  /** Admin "Ödənişlər": balans hərəkətləri (kind, tenantId, since, until, before, limit) */
  billingLedger(q: Record<string, string>): Promise<AiResult>;
  /** Ümumi AI açarı */
  aiControl(): Promise<AiResult>;
  setAiControl(body: { paused: boolean; reason?: string; by?: string }): Promise<AiResult>;
  /** AI servisinin sadə sağlamlıq yoxlaması (/health). Xəta atırsa servis əlçatmazdır. */
  ping(): Promise<void>;
  /** Claude/Gemini hesab problemləri (balans bitib, limit, açar səhvi) */
  providers(): Promise<AiResult>;
  /** Abunə: plan/paket sifarişi (dryRun: yalnız qiymət) */
  billingOrder(tenantId: string, body: { kind: string; plan?: string; cycle?: string; pack?: string }, dryRun?: boolean): Promise<AiResult>;
  /** Növbəti dövrdən başqa plana keçid (null — ləğv) */
  billingPlanNext(tenantId: string, plan: string | null): Promise<AiResult>;
  /** Admin: plan vermək (days) və ya götürmək (plan: null) */
  billingPlanAssign(tenantId: string, body: { plan: string | null; days?: number; note?: string; by?: string }): Promise<AiResult>;
  /** Bonus cavablar (ref ilə bir dəfə) */
  billingBonusReplies(tenantId: string, body: { replies: number; ref: string; note?: string; by?: string }): Promise<AiResult>;
  /** Plan imkanları (funksiyaların açılması üçün) */
  entitlements(tenantId: string): Promise<AiResult>;
  /** Plan kataloqu (qiymət, limit, imkanlar) */
  billingPlans(): Promise<AiResult>;
  setBillingPlans(body: object): Promise<AiResult>;
  /** Bitməyə yaxın / bitmiş abunələr (hər biri bir dəfə qaytarılır) */
  planReminders(): Promise<AiResult>;
};

export function createAiClient(baseUrl: string, token: string): AiClient {
  async function request(method: string, path: string, body?: object, timeoutMs = 30_000): Promise<AiResult> {
    let res: Response;
    try {
      res = await fetch(`${baseUrl}/v1/service${path}`, {
        method,
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (e) {
      throw new AiError(502, e instanceof Error && e.name === "TimeoutError" ? "AI servisi vaxtında cavab vermədi" : "AI servisinə qoşulmaq olmur", "AI_UNREACHABLE");
    }
    const data = (await res.json().catch(() => ({}))) as AiResult;
    if (!res.ok) throw new AiError(res.status, String(data.error ?? "AI servisi xəta qaytardı"), data.code, data);
    return data;
  }
  const t = (id: string) => `/tenants/${encodeURIComponent(id)}`;
  return {
    testConfig: (config) => request("POST", "/config/test", config),
    fetchSample: (body) => request("POST", "/config/sample", body),
    createTenant: (config) => request("POST", "/tenants", config),
    updateConfig: (id, config) => request("PUT", `${t(id)}/config`, config),
    feedPreview: (body) => request("POST", "/feed/preview", body, 60_000),
    feedStatus: (id) => request("GET", `${t(id)}/feed`),
    feedRefresh: (id, body) => request("POST", `${t(id)}/feed/refresh`, body, 60_000),
    patchProfile: (id, profile) => request("PATCH", `${t(id)}/profile`, profile),
    rotateKey: (id) => request("POST", `${t(id)}/rotate-key`),
    deleteTenant: (id) => request("DELETE", t(id)),
    usage: (id) => request("GET", `${t(id)}/usage`),
    usageSummary: () => request("GET", "/usage/summary"),
    listings: (id, query) => request("GET", `${t(id)}/listings${query ? `?${query}` : ""}`),
    chat: (id, message, history, opts) => request("POST", `${t(id)}/chat`, { message, history, ...(opts?.test && { test: true }), ...(opts?.sid && { sid: opts.sid }), ...(opts?.identity && { identity: opts.identity }), ...(opts?.live && { live: true }), ...(opts?.image && { image: { data: opts.image } }), ...(opts?.channel && { channel: opts.channel }), ...(opts?.handoff && { handoff: opts.handoff }), ...(opts?.reach && { reach: opts.reach }) }, 75_000),
    privateData: (id) => request("GET", `${t(id)}/private-data`),
    setPrivateData: (id, body) => request("PUT", `${t(id)}/private-data`, body),
    deletePrivateData: (id) => request("DELETE", `${t(id)}/private-data`),
    newIdentitySecret: (id) => request("POST", `${t(id)}/private-data/identity-secret`),
    draft: (id, body) => request("POST", `${t(id)}/draft`, body, 60_000),
    summarize: (id, messages) => request("POST", `${t(id)}/summary`, { messages }, 60_000),
    actions: (id) => request("GET", `${t(id)}/actions`),
    setActions: (id, body) => request("PUT", `${t(id)}/actions`, body),
    deleteActions: (id) => request("DELETE", `${t(id)}/actions`),
    newSigningSecret: (id) => request("POST", `${t(id)}/actions/signing-secret`),
    testAction: (id, body) => request("POST", `${t(id)}/actions/test`, body, 20_000),
    actionConfirm: (id, body) => request("POST", `${t(id)}/actions/confirm`, body, 20_000),
    actionLog: (id) => request("GET", `${t(id)}/actions/log`),
    actionStats: (id, days) => request("GET", `${t(id)}/actions/stats${days ? `?days=${Math.round(days)}` : ""}`),
    clearActionLog: (id) => request("DELETE", `${t(id)}/actions/log`),
    testPrivateData: (id, body) => request("POST", `${t(id)}/private-data/test`, body, 15_000),
    testOrderLookup: (id, body) => request("POST", `${t(id)}/private-data/lookup-test`, body, 15_000),
    conversations: (id, query) => request("GET", `${t(id)}/conversations${query ? `?${query}` : ""}`),
    conversation: (id, sid) => request("GET", `${t(id)}/conversations/${encodeURIComponent(sid)}`),
    recordClick: (id, sid, c) => request("POST", `${t(id)}/conversations/${encodeURIComponent(sid)}/clicks`, c),
    queries: (id, query) => request("GET", `${t(id)}/queries${query ? `?${query}` : ""}`),
    queryTrend: (id, days) => request("GET", `${t(id)}/queries/trend${days ? `?days=${days}` : ""}`),
    insights: (id, body) => request("POST", `${t(id)}/insights`, body, 75_000),
    queryStats: (id, days) => request("GET", `${t(id)}/queries/stats${days ? `?days=${days}` : ""}`),
    clearQueries: (id) => request("DELETE", `${t(id)}/queries`),
    kbInfo: (id) => request("GET", `${t(id)}/kb`),
    kbAddFile: (id, file) => request("POST", `${t(id)}/kb/files`, file, 60_000),
    kbAddUrl: (id, url, crawl) => request("POST", `${t(id)}/kb/urls`, { url, crawl }),
    kbAddText: (id, title, text) => request("POST", `${t(id)}/kb/texts`, { title, text }),
    transcribe: (id, audio) => request("POST", `${t(id)}/transcribe`, { audio: { data: audio } }, 60_000),
    kbAddProc: (id, body) => request("POST", `${t(id)}/kb/proc`, body),
    kbUpdateProc: (id, sid, body) => request("PUT", `${t(id)}/kb/proc/${encodeURIComponent(sid)}`, body),
    kbAddQa: (id, body) => request("POST", `${t(id)}/kb/qa`, body),
    kbUpdateQa: (id, sid, body) => request("PUT", `${t(id)}/kb/qa/${encodeURIComponent(sid)}`, body),
    kbRefresh: (id, sid) => request("POST", `${t(id)}/kb/sources/${encodeURIComponent(sid)}/refresh`),
    kbDelete: (id, sid) => request("DELETE", `${t(id)}/kb/sources/${encodeURIComponent(sid)}`),
    kbUnanswered: (id) => request("GET", `${t(id)}/kb/unanswered`),
    kbDeleteUnanswered: (id, x) => request("DELETE", `${t(id)}/kb/unanswered/${encodeURIComponent(x)}`),
    kbLeads: (id, kind) => request("GET", `${t(id)}/kb/leads${kind ? `?kind=${kind}&limit=500` : ""}`),
    booking: (id) => request("GET", `${t(id)}/booking`),
    kbLearn: (id, b) => request("POST", `${t(id)}/kb/learn`, b, 60_000),
    kbSuggestions: (id) => request("GET", `${t(id)}/kb/suggestions`),
    kbDeleteSuggestion: (id, x) => request("DELETE", `${t(id)}/kb/suggestions/${encodeURIComponent(x)}`),
    kbAcceptSuggestion: (id, x, b) => request("POST", `${t(id)}/kb/suggestions/${encodeURIComponent(x)}/accept`, b),
    setBooking: (id, b) => request("PUT", `${t(id)}/booking`, b),
    deleteBooking: (id) => request("DELETE", `${t(id)}/booking`),
    kbAddLead: (id, lead) => request("POST", `${t(id)}/kb/leads`, lead),
    orderForm: (id) => request("GET", `${t(id)}/order-form`),
    setOrderForm: (id, form) => request("PUT", `${t(id)}/order-form`, form),
    deleteOrderForm: (id) => request("DELETE", `${t(id)}/order-form`),
    kbHandleLead: (id, x, handled) => request("PATCH", `${t(id)}/kb/leads/${encodeURIComponent(x)}`, { handled }),
    kbUpdateLead: (id, x, patch) => request("PATCH", `${t(id)}/kb/leads/${encodeURIComponent(x)}`, patch),
    kbDeleteLead: (id, x) => request("DELETE", `${t(id)}/kb/leads/${encodeURIComponent(x)}`),
    billing: (id, admin) => request("GET", `${t(id)}/billing${admin ? "?admin=1" : ""}`),
    billingTopupRequest: (id, amountAzn) => request("POST", `${t(id)}/billing/topup-request`, { amountAzn }),
    billingTopup: (id, body) => request("POST", `${t(id)}/billing/topup`, body),
    billingSettings: (id, body) => request("PATCH", `${t(id)}/billing/settings`, body),
    billingRequests: (status) => request("GET", `/billing/requests?status=${encodeURIComponent(status)}`),
    billingResolve: (rid, action, by) => request("POST", `/billing/requests/${encodeURIComponent(rid)}/${action}`, { by }),
    billingAccounts: () => request("GET", "/billing/accounts"),
    billingFinance: (months = 6) => request("GET", `/billing/finance?months=${Math.min(24, Math.max(1, Math.round(months)))}`),
    suspendTenant: (id, suspended) => request("PATCH", `${t(id)}/suspend`, { suspended }),
    billingRequestsQuery: (q) => request("GET", `/billing/requests?${new URLSearchParams({ status: "all", ...q })}`),
    billingLedger: (q) => request("GET", `/billing/ledger?${new URLSearchParams(q)}`),
    aiControl: () => request("GET", "/ai-control"),
    setAiControl: (body) => request("PUT", "/ai-control", body),
    providers: () => request("GET", "/providers", undefined, 8000),
    billingOrder: (id, body, dryRun) => request("POST", `${t(id)}/billing/order${dryRun ? "?dryRun=1" : ""}`, body),
    billingPlanNext: (id, plan) => request("POST", `${t(id)}/billing/plan/next`, { plan }),
    billingPlanAssign: (id, body) => request("POST", `${t(id)}/billing/plan/assign`, body),
    billingBonusReplies: (id, body) => request("POST", `${t(id)}/billing/bonus-replies`, body),
    entitlements: (id) => request("GET", `${t(id)}/billing/entitlements`, undefined, 8000),
    billingPlans: () => request("GET", "/billing/plans"),
    setBillingPlans: (body) => request("PUT", "/billing/plans", body),
    planReminders: () => request("POST", "/billing/plan-reminders"),
    async ping() {
      const res = await fetch(`${baseUrl}/health`, { signal: AbortSignal.timeout(8000) });
      if (!res.ok) throw new Error(`AI servisi ${res.status} qaytardı`);
    },
  };
}
