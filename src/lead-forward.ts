// Yeni müraciəti sahibkarın istifadə etdiyi yerə ötürür: Telegram qrupu, Bitrix24 CRM, istənilən webhook (Google Sheets, Make, Zapier, n8n).
// Heç biri rəsmi icazə tələb etmir: sahibkar linki özü yaradıb panelə yapışdırır (Telegram-da isə botu qrupa bir kliklə əlavə edir).
// Bitrix24 və webhook linkləri sirr daşıyır (Bitrix linkində açar var): şifrəli saxlanır, panelə yalnız domen qayıdır.
// Göndərmə SSRF qorumalıdır: yalnız https, daxili şəbəkə IP-ləri qoşulma anında bloklanır, yönləndirmə izlənmir, 8 saniyə limit.
// Ötürmə alınmasa müraciət yenə paneldə qalır və sahibə e-poçt gedir: ötürmə əlavə rahatlıqdır, yeganə yol deyil.
import { Router } from "express";
import type { Deps } from "./deps.js";
import { recordError } from "./errorlog.js";
import { HttpError } from "./http.js";
import { currentUser, requireAuth } from "./middleware.js";
import { groupLinkUrl, notifyAvailable, sendNotify } from "./operator-notify.js";
import { guardedFetch } from "./safe-image.js";
import { decryptSecret, encryptSecret } from "./secrets.js";
import type { LeadForward, TenantRecord } from "./store/types.js";
import { runAutomations } from "./automations.js";

export type Lead = { source: string; name: string; contact: string; question: string; conversation?: { role: string; text: string }[]; page?: string; /** API-siz sifariş: forma sahələri */ order?: { title: string; fields: { label: string; value: string }[] } };
export type PostResult = { ok: boolean; status: number; json: unknown };
export type HttpPost = (url: string, body: unknown) => Promise<PostResult>;

/** Təhlükəsiz POST: https, SSRF qorunması, yönləndirmə izlənmir (Google Apps Script 302 qaytarır: bu da uğur sayılır), cavabdan ən çox 64 KB. */
export const safePost: HttpPost = async (url, body) => {
  const u = new URL(url);
  if (u.protocol !== "https:" || u.username || u.password) throw new Error("Yalnız https ünvan");
  const res = await guardedFetch(u, { method: "POST", redirect: "manual", signal: AbortSignal.timeout(8000), headers: { "content-type": "application/json", "user-agent": "Hazircavab-Leads/1.0" }, body: JSON.stringify(body) });
  const text = res.body ? (await res.text()).slice(0, 65_536) : "";
  let json: unknown = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = null; }
  return { ok: (res.status >= 200 && res.status < 400), status: res.status, json };
};

const BITRIX_RE = /^https:\/\/[a-z0-9.-]+\.[a-z]{2,}(:\d+)?\/rest\/\d+\/[A-Za-z0-9]+\/?$/;
export const isBitrixUrl = (v: string) => BITRIX_RE.test(v);
export const bitrixMethod = (base: string, method: string) => `${base.replace(/\/?$/, "/")}${method}.json`;
const isEmail = (v: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v);

export function leadText(t: TenantRecord, l: Lead): string {
  const conv = (l.conversation ?? []).slice(-6).map((m) => `${m.role === "user" ? "Ziyarətçi" : "Çat"}: ${m.text.slice(0, 200)}`).join("\n");
  if (l.order) return [`🛒 Yeni sifariş: ${l.order.title} (${l.source}) · ${t.businessName}`, "", ...l.order.fields.map((f) => `${f.label}: ${f.value}`), ...(conv ? ["", "Söhbətin son hissəsi:", conv] : [])].join("\n");
  return [`📩 Yeni müraciət (${l.source}) · ${t.businessName}`, "", `Ad: ${l.name || "-"}`, `Əlaqə: ${l.contact}`, `Sual: ${l.question || "-"}`, ...(l.page ? [`Səhifə: ${l.page}`] : []), ...(conv ? ["", "Söhbətin son hissəsi:", conv] : [])].join("\n");
}
export function bitrixFields(t: TenantRecord, l: Lead) {
  const conv = (l.conversation ?? []).slice(-10).map((m) => `${m.role === "user" ? "Ziyarətçi" : "Çat"}: ${m.text.slice(0, 300)}`).join("\n");
  return {
    TITLE: l.order ? `Çat sifarişi: ${l.order.title}${l.name ? ` · ${l.name}` : ""}`.slice(0, 120) : `Çat müraciəti: ${(l.question || l.name || l.contact).slice(0, 80)}`,
    NAME: l.name || "",
    ...(isEmail(l.contact) ? { EMAIL: [{ VALUE: l.contact, VALUE_TYPE: "WORK" }] } : { PHONE: [{ VALUE: l.contact, VALUE_TYPE: "WORK" }] }),
    COMMENTS: [`Mənbə: ${t.businessName} saytının AI çatı (${l.source})`, l.order ? `Sifariş: ${l.order.title}\n${l.order.fields.map((f) => `${f.label}: ${f.value}`).join("\n")}` : l.question ? `Sual: ${l.question}` : "", l.page ? `Səhifə: ${l.page}` : "", conv ? `\nSöhbət:\n${conv}` : ""].filter(Boolean).join("\n"),
    SOURCE_ID: "WEB",
    SOURCE_DESCRIPTION: `AI çat (${l.source})`,
  };
}
const webhookBody = (t: TenantRecord, l: Lead, test = false) => ({
  event: test ? "test" : "lead", at: new Date().toISOString(), site: t.domain, business: t.businessName,
  source: l.source, name: l.name, contact: l.contact, question: l.question, page: l.page ?? "", conversation: l.conversation ?? [], ...(l.order && { order: l.order }),
});

type Target = "telegram" | "bitrix" | "webhook";
/** Bir yerə göndərir. Qaytarır: "ok" | "gone" (Telegram qrupu artıq yoxdur) | xəta mətni. */
export async function sendTo(deps: Deps, t: TenantRecord, target: Target, l: Lead, test = false): Promise<"ok" | "gone" | string> {
  const f = t.leadForward ?? {};
  const post = deps.httpPost ?? safePost;
  try {
    if (target === "telegram") {
      if (!f.telegram) return "qoşulmayıb";
      const r = await sendNotify(deps, f.telegram.chatId, test ? `✅ Sınaq: ${t.businessName} müraciətləri bu qrupa gələcək.` : leadText(t, l));
      return r === "ok" ? "ok" : r === "gone" ? "gone" : "Telegram-a göndərilmədi";
    }
    const box = target === "bitrix" ? f.bitrix : f.webhook;
    if (!box) return "qoşulmayıb";
    const url = decryptSecret(box.urlEnc, deps.config.secretKey);
    if (target === "bitrix") {
      const r = await post(bitrixMethod(url, test ? "crm.lead.fields" : "crm.lead.add"), test ? {} : { fields: bitrixFields(t, l), params: { REGISTER_SONET_EVENT: "Y" } });
      const j = (r.json ?? {}) as { result?: unknown; error?: string; error_description?: string };
      if (r.ok && j.result !== undefined) return "ok";
      return `Bitrix24: ${String(j.error_description || j.error || `HTTP ${r.status}`).slice(0, 160)}`;
    }
    const r = await post(url, webhookBody(t, l, test));
    return r.ok ? "ok" : `Webhook HTTP ${r.status} qaytardı`;
  } catch (e) {
    return e instanceof Error && e.name === "TimeoutError" ? "8 saniyədə cavab gəlmədi" : `Qoşulmaq alınmadı${e instanceof Error ? ` (${e.message.slice(0, 80)})` : ""}`;
  }
}

/** Yeni müraciət: avtomatlaşdırmalar işə düşür (köhnə hesablarda: bütün qoşulmuş yerlərə göndərilir). Ziyarətçini gözlətmir. */
export async function forwardLead(deps: Deps, t: TenantRecord, l: Lead): Promise<void> {
  const src = l.source.toLowerCase();
  const channel = src.includes("telegram") ? "telegram" : src.includes("whatsapp") ? "whatsapp" : "site";
  await runAutomations(deps, t, { trigger: "lead", lead: l, channel });
}

export const forwardView = (deps: Deps, f: LeadForward = {}) => ({
  telegram: f.telegram ? { title: f.telegram.title } : null, telegramAvailable: notifyAvailable(deps),
  bitrix: f.bitrix ? { host: f.bitrix.host } : null, webhook: f.webhook ? { host: f.webhook.host } : null,
  keyReady: Boolean(deps.config.secretKey),
});
const SAMPLE: Lead = { source: "sınaq", name: "Sınaq Müştəri", contact: "+994501234567", question: "Bu, bağlantının yoxlanması üçün sınaq müraciətidir.", conversation: [] };

/** Panel: /tenant/lead-forward (yalnız sahib; komanda üzvləri görmür). */
export function leadForwardRoutes(deps: Deps) {
  const { store, limiter, config } = deps;
  const r = Router();
  r.use("/lead-forward", requireAuth);
  const mine = async (res: Parameters<typeof currentUser>[0]) => {
    const t = await store.findTenantByUser(currentUser(res).id);
    if (!t) throw new HttpError(404, "Əvvəlcə qurulumu tamamla", "NO_TENANT");
    return t;
  };
  const save = async (t: TenantRecord, patch: Partial<LeadForward>) => {
    const next = { ...(t.leadForward ?? {}), ...patch };
    await store.updateTenant(t.tenantId, { leadForward: next });
    return next;
  };
  const needKey = () => { if (!config.secretKey) throw new HttpError(503, "Serverdə CHANNEL_SECRET_KEY təyin edilməyib: linki şifrəli saxlamaq mümkün deyil", "NO_SECRET_KEY"); };
  const rate = (res: Parameters<typeof currentUser>[0]) => { if (!limiter.hit(`leadfw:${currentUser(res).id}`, 20, 10 * 60_000)) throw new HttpError(429, "Çox tez-tez sorğu, bir az gözlə", "RATE_LIMITED"); };

  r.get("/lead-forward", async (_req, res) => { res.json(forwardView(deps, (await mine(res)).leadForward)); });

  r.post("/lead-forward/telegram", async (_req, res) => {
    const t = await mine(res); rate(res);
    if (!notifyAvailable(deps)) throw new HttpError(503, "Telegram bildiriş botu serverdə qoşulmayıb (NOTIFY_TELEGRAM_TOKEN)", "NOTIFY_OFF");
    res.json(groupLinkUrl(t.tenantId));
  });
  r.delete("/lead-forward/telegram", async (_req, res) => {
    const t = await mine(res);
    if (t.leadForward?.telegram) await sendNotify(deps, t.leadForward.telegram.chatId, "Müraciətlər artıq bu qrupa göndərilməyəcək. Botu qrupdan çıxara bilərsən.");
    res.json(forwardView(deps, await save(t, { telegram: null })));
  });

  // Bitrix24: link yoxlanılır (crm.lead.fields: heç nə yaratmır, yalnız CRM icazəsini yoxlayır), sonra şifrəli saxlanır
  r.put("/lead-forward/bitrix", async (req, res) => {
    const t = await mine(res); rate(res); needKey();
    const url = typeof req.body?.url === "string" ? req.body.url.trim() : "";
    if (!isBitrixUrl(url)) throw new HttpError(400, "Bitrix24 webhook linki belə olmalıdır: https://sənin.bitrix24.az/rest/1/abc123xyz/", "BAD_URL");
    const probe = { ...t, leadForward: { ...(t.leadForward ?? {}), bitrix: { urlEnc: encryptSecret(url, config.secretKey), host: new URL(url).hostname } } };
    const r = await sendTo(deps, probe, "bitrix", SAMPLE, true);
    if (r !== "ok") throw new HttpError(400, `${r}. Webhook yaradanda “CRM” icazəsini seçdiyini yoxla.`, "BITRIX_FAILED");
    res.json(forwardView(deps, await save(t, { bitrix: probe.leadForward.bitrix })));
  });
  r.delete("/lead-forward/bitrix", async (_req, res) => { res.json(forwardView(deps, await save(await mine(res), { bitrix: null }))); });

  // Webhook: sınaq göndərişi (event: "test") uğurlu olsa saxlanır
  r.put("/lead-forward/webhook", async (req, res) => {
    const t = await mine(res); rate(res); needKey();
    const url = typeof req.body?.url === "string" ? req.body.url.trim() : "";
    let u: URL | null = null;
    try { u = new URL(url); } catch { u = null; }
    if (!u || u.protocol !== "https:" || url.length > 500) throw new HttpError(400, "Webhook https ilə başlayan ünvan olmalıdır", "BAD_URL");
    const probe = { ...t, leadForward: { ...(t.leadForward ?? {}), webhook: { urlEnc: encryptSecret(url, config.secretKey), host: u.hostname } } };
    const r = await sendTo(deps, probe, "webhook", SAMPLE, true);
    if (r !== "ok") throw new HttpError(400, `${r}. Ünvanı və onun hamıya açıq olduğunu yoxla.`, "WEBHOOK_FAILED");
    res.json(forwardView(deps, await save(t, { webhook: probe.leadForward.webhook })));
  });
  r.delete("/lead-forward/webhook", async (_req, res) => { res.json(forwardView(deps, await save(await mine(res), { webhook: null }))); });

  // Bütün qoşulmuş yerlərə sınaq müraciəti (Bitrix-də real lid yaranır, adında "Sınaq" yazılır)
  r.post("/lead-forward/test", async (_req, res) => {
    const t = await mine(res); rate(res);
    const f = t.leadForward ?? {};
    const out: Record<string, string> = {};
    for (const k of ["telegram", "bitrix", "webhook"] as const) if (f[k]) out[k] = await sendTo(deps, t, k, SAMPLE, k === "telegram");
    res.json({ results: out });
  });
  return r;
}
