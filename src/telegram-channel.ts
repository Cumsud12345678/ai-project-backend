// Telegram kanalı: müştərinin öz botu portala webhook ilə bağlanır, mesajlar vidjetlə eyni AI çatından keçir.
// Panel marşrutları: /tenant/channels/telegram (token qoşmaq/çıxarmaq). İctimai marşrut: POST /telegram/:hook (yalnız Telegram).
import { randomBytes, timingSafeEqual } from "node:crypto";
import { Router } from "express";
import { AiError } from "./ai.js";
import { notifyBalance } from "./billing.js";
import type { Deps } from "./deps.js";
import { recordError } from "./errorlog.js";
import { HttpError } from "./http.js";
import { cleanContact } from "./kb.js";
import { currentUser, requireAuth } from "./middleware.js";
import { decryptSecret, encryptSecret } from "./secrets.js";
import { TelegramError } from "./telegram.js";
import type { ChannelSession, TenantRecord } from "./store/types.js";
import { DEFAULT_GREETING, DEFAULT_GREETING_SUPPORT, limitsOf, modeOf } from "./widget.js";

const TOKEN_RE = /^\d{6,12}:[A-Za-z0-9_-]{30,50}$/;
const HOOK_RE = /^[a-f0-9]{24}$/;
const MAX_TEXT = 500;
const HISTORY_KEEP = 10;
const SESSION_IDLE_MS = 12 * 60 * 60_000; // 12 saat yazılmayıbsa yeni söhbət sayılır

const MSG = {
  textOnly: "Hələlik yalnız yazılı mesajlara cavab verə bilirəm. Sualınızı yazın.",
  tooLong: `Mesaj çox uzundur (maksimum ${MAX_TEXT} simvol). Qısaldıb yenidən yazın.`,
  slowDown: "Çox tez-tez yazırsınız, bir az gözləyib yenidən yazın.",
  dayLimit: "Bu gün üçün sual limitinə çatdınız. Sabah yenidən yazın.",
  busy: "Çat müvəqqəti məşğuldur, bir azdan yenidən yazın.",
  offline: "Çat hazırda cavab verə bilmir. Bir az sonra yenidən yazın.",
  askContact: "Bu sualın cavabını tapa bilmədim. İstəsəniz operator sizinlə əlaqə saxlasın: telefon nömrənizi və ya e-poçtunuzu yazın.",
  thanks: "Təşəkkürlər, müraciətiniz qəbul edildi. Operator tezliklə sizinlə əlaqə saxlayacaq.",
} as const;

const clip = (v: unknown, n: number) => String(v ?? "").trim().slice(0, n);
const httpUrl = (v: unknown) => (typeof v === "string" && /^https?:\/\//i.test(v) && v.length < 2000 ? v : "");

/** AI cavabını Telegram üçün düz mətnə çevirir (parse_mode yoxdur: xüsusi simvolları qaçırmaq lazım olmur). */
export function formatReply(out: Record<string, any>): string {
  const parts = [clip(out.answer, 3000) || "..."];
  const items = (Array.isArray(out.listings) ? out.listings : []).slice(0, 3).map((l: Record<string, unknown>) => {
    const price = typeof l.price === "number" ? ` — ${l.price}${l.currency ? ` ${clip(l.currency, 8)}` : ""}` : "";
    const url = httpUrl(l.url);
    return `• ${clip(l.title, 120) || "Elan"}${price}${url ? `\n${url}` : ""}`;
  });
  if (items.length) parts.push(items.join("\n"));
  const src = (Array.isArray(out.sources) ? out.sources : []).slice(0, 2).map((s: Record<string, unknown>) => {
    const url = httpUrl(s.url);
    return `${clip(s.title, 100)}${url ? ` ${url}` : ""}`.trim();
  }).filter(Boolean);
  if (src.length) parts.push(`Mənbə: ${src.join(", ")}`);
  return parts.join("\n\n").slice(0, 3900);
}

type Update = { update_id?: number; message?: { text?: string; chat?: { id?: number; type?: string }; from?: { first_name?: string; username?: string; is_bot?: boolean } } };

// Telegram cavab alınmayanda eyni yeniləməni təkrar göndərir: son yeniləmələr yadda saxlanır və təkrar emal olunmur.
const seen = new Map<string, number>();
const dedupe = (key: string) => {
  const now = Date.now();
  if (seen.size > 5000) for (const [k, t] of seen) if (now - t > 600_000) seen.delete(k);
  if (seen.has(key)) return true;
  seen.set(key, now);
  return false;
};
// Eyni söhbətdən ardıcıl mesajlar sıra ilə emal olunur (tarixçə qarışmasın)
const chains = new Map<string, Promise<unknown>>();
const serial = <T,>(key: string, fn: () => Promise<T>): Promise<T> => {
  const next = (chains.get(key) ?? Promise.resolve()).catch(() => {}).then(fn);
  chains.set(key, next);
  void next.finally(() => { if (chains.get(key) === next) chains.delete(key); }).catch(() => {});
  return next;
};

/** Bir Telegram yeniləməsini emal edir. Xətalar yuxarıda jurnala yazılır, Telegram-a həmişə 200 qayıdır. */
export async function processUpdate(deps: Deps, tenant: TenantRecord, update: Update): Promise<void> {
  const { store, ai, limiter, mailer, telegram, config } = deps;
  const link = tenant.telegram;
  const msg = update.message;
  if (!link?.enabled || !msg?.chat || msg.chat.type !== "private" || msg.from?.is_bot || typeof msg.chat.id !== "number") return;
  if (typeof update.update_id === "number" && dedupe(`${tenant.tenantId}:${update.update_id}`)) return;
  const token = decryptSecret(link.tokenEnc, config.secretKey);
  const chatId = String(msg.chat.id);
  const send = (text: string) => telegram.sendMessage(token, chatId, text);
  // Eyni mesajda xəbərdarlıq spamı olmasın: dəqiqədə ən çox 1 xəbərdarlıq
  const warn = (text: string) => (limiter.hit(`tg:warn:${tenant.tenantId}:${chatId}`, 1, 60_000) ? send(text) : Promise.resolve());
  const text = typeof msg.text === "string" ? msg.text.trim() : "";

  return serial(`${tenant.tenantId}:${chatId}`, async () => {
    const mode = modeOf(tenant.config);
    const greeting = tenant.widget?.greeting || (mode === "support" ? DEFAULT_GREETING_SUPPORT : DEFAULT_GREETING);
    let session: ChannelSession = (await store.getChannelSession(tenant.tenantId, "telegram", chatId)) ?? { tenantId: tenant.tenantId, channel: "telegram", chatId, sid: randomBytes(12).toString("hex"), history: [], updatedAt: new Date() };
    if (Date.now() - new Date(session.updatedAt).getTime() > SESSION_IDLE_MS) session = { ...session, sid: randomBytes(12).toString("hex"), history: [], pending: null };

    if (/^\/start(\s|@|$)/i.test(text)) {
      await store.saveChannelSession({ ...session, history: [], pending: null, updatedAt: new Date() });
      return send(greeting);
    }
    if (!text) return warn(MSG.textOnly);
    if (text.length > MAX_TEXT) return warn(MSG.tooLong);

    // Cavab tapılmayandan sonra gələn mesaj: etibarlı kontaktdırsa müraciət olur, deyilsə adi sual kimi davam edir
    if (session.pending) {
      const contact = cleanContact(text);
      if (contact) {
        const name = clip([msg.from?.first_name, msg.from?.username ? `@${msg.from.username}` : ""].filter(Boolean).join(" "), 80);
        const question = session.pending.question;
        try { await ai.kbAddLead(tenant.tenantId, { name, contact, question, conversation: session.history.slice(-10) }); }
        catch (e) {
          if (e instanceof AiError) { await recordError(store, { source: "channel", message: `Telegram müraciəti yazıla bilmədi: ${e.message}`, tenantId: tenant.tenantId, code: e.code }); return send(MSG.offline); }
          throw e;
        }
        try {
          const owner = await store.findUserById(tenant.userId);
          if (owner) await mailer.send(owner.email, `Yeni müraciət (Telegram): ${tenant.businessName}`, `Telegram botundan yeni müraciət var.\n\nAd: ${name || "-"}\nƏlaqə: ${contact}\nSual: ${question || "-"}`);
        } catch { /* bildiriş alınmasa da müraciət paneldə qalır; mailer xətası artıq jurnala yazılıb */ }
        await store.saveChannelSession({ ...session, pending: null, updatedAt: new Date() });
        return send(MSG.thanks);
      }
      session = { ...session, pending: null };
    }

    // Limitlər vidjetlə eyni qaydadadır: müştərinin təyin etdiyi günlük və saatlıq həddlər
    const lim = limitsOf(tenant.widget);
    if (!limiter.hit(`tg:min:${tenant.tenantId}:${chatId}`, 10, 60_000)) return warn(MSG.slowDown);
    if (lim.perVisitorDay > 0 && !limiter.hit(`tg:day:${tenant.tenantId}:${chatId}`, lim.perVisitorDay, 24 * 60 * 60_000)) return warn(MSG.dayLimit);
    if (lim.siteHour > 0 && !limiter.hit(`tg:hour:${tenant.tenantId}`, lim.siteHour, 60 * 60_000)) return warn(MSG.busy);

    void telegram.sendChatAction(token, chatId).catch(() => {});
    let out: Record<string, any>;
    try { out = await ai.chat(tenant.tenantId, text, session.history.slice(-HISTORY_KEEP), { sid: session.sid }); }
    catch (e) {
      if (e instanceof AiError) {
        if (e.status !== 402) await recordError(store, { source: "channel", message: `Telegram: AI cavab vermədi (${e.status}) ${e.message}`, tenantId: tenant.tenantId, code: e.code, status: e.status });
        return send(MSG.offline);
      }
      throw e;
    }
    const notify = out.billing?.notify;
    if (notify === "low" || notify === "empty") void notifyBalance(deps, tenant, notify, out.billing?.balanceAzn);
    const answer = formatReply(out);
    const unanswered = out.unanswered === true;
    const history = [...session.history, { role: "user" as const, text: text.slice(0, 600) }, { role: "model" as const, text: clip(out.answer, 600) }].slice(-HISTORY_KEEP);
    await store.saveChannelSession({ ...session, history, pending: unanswered ? { question: text.slice(0, 500) } : null, updatedAt: new Date() });
    await send(unanswered ? `${answer}\n\n${MSG.askContact}` : answer);
  });
}

/** İctimai webhook: Telegram bura çağırır. Ünvandakı təsadüfi hissə və gizli başlıq yoxlanır, cavab dərhal 200 qayıdır. */
export function telegramWebhook(deps: Deps) {
  const r = Router();
  r.post("/telegram/:hook", async (req, res) => {
    const hook = String(req.params.hook ?? "");
    const tenant = HOOK_RE.test(hook) ? await deps.store.findTenantByTelegramHook(hook) : null;
    const got = String(req.get("x-telegram-bot-api-secret-token") ?? "");
    const want = tenant?.telegram?.secret ?? "";
    if (!tenant || got.length !== want.length || !timingSafeEqual(Buffer.from(got), Buffer.from(want))) throw new HttpError(404, "Tapılmadı");
    res.json({ ok: true });
    processUpdate(deps, tenant, (req.body ?? {}) as Update).catch((e) => {
      console.warn(`[telegram] ${tenant.tenantId}: ${e instanceof Error ? e.message : e}`);
      void recordError(deps.store, { source: "channel", message: `Telegram: ${e instanceof Error ? e.message : String(e)}`, stack: e instanceof Error ? e.stack : undefined, tenantId: tenant.tenantId, code: "TELEGRAM_UPDATE" });
    });
  });
  return r;
}

const view = (t: TenantRecord, publicUrl: string, secretKey: string) => {
  const l = t.telegram;
  return { connected: Boolean(l), enabled: Boolean(l?.enabled), botUsername: l?.botUsername ?? null, connectedAt: l?.connectedAt ?? null, httpsReady: publicUrl.startsWith("https://"), keyReady: Boolean(secretKey) };
};

/** Panel: /tenant/channels/telegram */
export function telegramPanelRoutes(deps: Deps) {
  const { store, telegram, config } = deps;
  const r = Router();
  r.use(requireAuth);
  const tenantOf = async (res: Parameters<typeof currentUser>[0]) => {
    const t = await store.findTenantByUser(currentUser(res).id);
    if (!t) throw new HttpError(404, "Əvvəlcə qurulumu tamamla", "NO_TENANT");
    return t;
  };
  const tgErr = (e: unknown) => (e instanceof TelegramError ? new HttpError(e.status === 401 || e.status === 404 ? 400 : 502, e.status === 401 || e.status === 404 ? "Token yanlışdır. @BotFather-dən tokeni yenidən kopyala." : `Telegram: ${e.message}`, "TELEGRAM") : e);

  r.get("/telegram", async (_req, res) => { res.json(view(await tenantOf(res), config.publicPortalUrl, config.secretKey)); });

  r.put("/telegram", async (req, res) => {
    const t = await tenantOf(res);
    if (!config.secretKey) throw new HttpError(503, "Serverdə CHANNEL_SECRET_KEY təyin edilməyib: Telegram tokenini şifrələmək mümkün deyil", "NO_SECRET_KEY");
    const token = clip((req.body as { token?: unknown } | undefined)?.token, 100);
    if (!TOKEN_RE.test(token)) throw new HttpError(400, "Token düzgün formatda deyil. @BotFather-in verdiyi tokeni olduğu kimi yapışdır.", "BAD_TOKEN");
    if (!config.publicPortalUrl.startsWith("https://")) throw new HttpError(400, "Telegram yalnız https ünvana göndərir: serverdə PUBLIC_PORTAL_URL https olmalıdır", "NEED_HTTPS");
    let bot;
    try { bot = await telegram.getMe(token); } catch (e) { throw tgErr(e); }
    const others = (await store.listTenants(5000)).find((x) => x.tenantId !== t.tenantId && x.telegram?.botId === bot.id);
    if (others) throw new HttpError(409, "Bu bot artıq başqa hesaba qoşulub", "BOT_IN_USE");
    const hook = t.telegram?.hook ?? randomBytes(12).toString("hex");
    const secret = randomBytes(24).toString("hex");
    try { await telegram.setWebhook(token, { url: `${config.publicPortalUrl}/telegram/${hook}`, secret }); } catch (e) { throw tgErr(e); }
    // Başqa bot qoşulurdusa köhnəsinin webhook-u götürülür (alınmasa da davam edirik)
    if (t.telegram && t.telegram.botId !== bot.id) { try { await telegram.deleteWebhook(decryptSecret(t.telegram.tokenEnc, config.secretKey)); } catch { /* köhnə token artıq etibarsız ola bilər */ } }
    const next = { tokenEnc: encryptSecret(token, config.secretKey), botId: bot.id, botUsername: bot.username, hook, secret, enabled: true, connectedAt: new Date() };
    await store.updateTenant(t.tenantId, { telegram: next });
    res.json(view({ ...t, telegram: next }, config.publicPortalUrl, config.secretKey));
  });

  r.patch("/telegram", async (req, res) => {
    const t = await tenantOf(res);
    if (!t.telegram) throw new HttpError(404, "Telegram botu qoşulmayıb", "NOT_CONNECTED");
    const enabled = (req.body as { enabled?: unknown } | undefined)?.enabled;
    if (typeof enabled !== "boolean") throw new HttpError(400, "enabled true və ya false olmalıdır");
    const next = { ...t.telegram, enabled };
    await store.updateTenant(t.tenantId, { telegram: next });
    res.json(view({ ...t, telegram: next }, config.publicPortalUrl, config.secretKey));
  });

  r.delete("/telegram", async (_req, res) => {
    const t = await tenantOf(res);
    if (t.telegram) {
      try { await telegram.deleteWebhook(decryptSecret(t.telegram.tokenEnc, config.secretKey)); } catch { /* token artıq etibarsızdırsa webhook onsuz da işləmir */ }
      await store.updateTenant(t.tenantId, { telegram: null });
      await store.deleteChannelSessions(t.tenantId);
    }
    res.json({ ok: true });
  });
  return r;
}
