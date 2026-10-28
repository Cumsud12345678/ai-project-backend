// AI servisinin (car-advisor) /v1/service/* endpoint-lərinin müştərisi.
export class AiError extends Error {
  constructor(public status: number, message: string, public code?: string, public body?: Record<string, unknown>) { super(message); }
}

export type AiResult = Record<string, any>;

export type AiClient = {
  testConfig(config: object): Promise<AiResult>;
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
  chat(tenantId: string, message: string, history: unknown[], opts?: { test?: boolean; sid?: string; identity?: string; /** canlı operator açıqdır: AI operatora ötürmə qərarı verə bilər */ live?: boolean; /** base64 şəkil (şəkilli sual) */ image?: string; /** əməliyyat təsdiqi hansı kanaldadır */ channel?: "widget" | "telegram" | "whatsapp" }): Promise<AiResult>;
  privateData(tenantId: string): Promise<AiResult>;
  setPrivateData(tenantId: string, body: object): Promise<AiResult>;
  deletePrivateData(tenantId: string): Promise<AiResult>;
  newIdentitySecret(tenantId: string): Promise<AiResult>;
  testPrivateData(tenantId: string, body: { kind: string; userId: string }): Promise<AiResult>;
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
  queries(tenantId: string, query: string): Promise<AiResult>;
  queryStats(tenantId: string, days?: number): Promise<AiResult>;
  queryTrend(tenantId: string, days?: number): Promise<AiResult>;
  /** Sualları mövzulara bölür və biliyə nə əlavə olunmalı olduğunu təklif edir (AI, balansdan çıxılır) */
  insights(tenantId: string, body: { days?: number; fresh?: boolean; disliked?: string[] }): Promise<AiResult>;
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
  kbLeads(tenantId: string): Promise<AiResult>;
  kbAddLead(tenantId: string, lead: { name: string; contact: string; question: string; conversation?: { role: string; text: string }[] }): Promise<AiResult>;
  kbHandleLead(tenantId: string, id: string, handled: boolean): Promise<AiResult>;
  kbDeleteLead(tenantId: string, id: string): Promise<AiResult>;
  billing(tenantId: string, admin?: boolean): Promise<AiResult>;
  billingTopupRequest(tenantId: string, amountAzn: number): Promise<AiResult>;
  billingTopup(tenantId: string, body: { amountAzn: number; note?: string; by?: string }): Promise<AiResult>;
  billingSettings(tenantId: string, body: { markup?: number | null; creditLimitAzn?: number }): Promise<AiResult>;
  billingRequests(status: string): Promise<AiResult>;
  billingResolve(requestId: string, action: "approve" | "reject", by: string): Promise<AiResult>;
  billingAccounts(): Promise<AiResult>;
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
    chat: (id, message, history, opts) => request("POST", `${t(id)}/chat`, { message, history, ...(opts?.test && { test: true }), ...(opts?.sid && { sid: opts.sid }), ...(opts?.identity && { identity: opts.identity }), ...(opts?.live && { live: true }), ...(opts?.image && { image: { data: opts.image } }), ...(opts?.channel && { channel: opts.channel }) }, 75_000),
    privateData: (id) => request("GET", `${t(id)}/private-data`),
    setPrivateData: (id, body) => request("PUT", `${t(id)}/private-data`, body),
    deletePrivateData: (id) => request("DELETE", `${t(id)}/private-data`),
    newIdentitySecret: (id) => request("POST", `${t(id)}/private-data/identity-secret`),
    draft: (id, body) => request("POST", `${t(id)}/draft`, body, 60_000),
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
    conversations: (id, query) => request("GET", `${t(id)}/conversations${query ? `?${query}` : ""}`),
    conversation: (id, sid) => request("GET", `${t(id)}/conversations/${encodeURIComponent(sid)}`),
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
    kbLeads: (id) => request("GET", `${t(id)}/kb/leads`),
    kbAddLead: (id, lead) => request("POST", `${t(id)}/kb/leads`, lead),
    kbHandleLead: (id, x, handled) => request("PATCH", `${t(id)}/kb/leads/${encodeURIComponent(x)}`, { handled }),
    kbDeleteLead: (id, x) => request("DELETE", `${t(id)}/kb/leads/${encodeURIComponent(x)}`),
    billing: (id, admin) => request("GET", `${t(id)}/billing${admin ? "?admin=1" : ""}`),
    billingTopupRequest: (id, amountAzn) => request("POST", `${t(id)}/billing/topup-request`, { amountAzn }),
    billingTopup: (id, body) => request("POST", `${t(id)}/billing/topup`, body),
    billingSettings: (id, body) => request("PATCH", `${t(id)}/billing/settings`, body),
    billingRequests: (status) => request("GET", `/billing/requests?status=${encodeURIComponent(status)}`),
    billingResolve: (rid, action, by) => request("POST", `/billing/requests/${encodeURIComponent(rid)}/${action}`, { by }),
    billingAccounts: () => request("GET", "/billing/accounts"),
  };
}
