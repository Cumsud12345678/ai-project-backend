// Telegram kanalı: müştərinin öz botu portala webhook ilə bağlanır, mesajlar vidjetlə eyni AI çatından keçir.
// Panel marşrutları: /tenant/channels/telegram (token qoşmaq/çıxarmaq). İctimai marşrut: POST /telegram/:hook (yalnız Telegram).
import { randomBytes, timingSafeEqual } from "node:crypto";
import { Router } from "express";
import { MAX_TEXT, clip, dedupe, formatReply, handleChat } from "./channel-chat.js";
import type { Deps } from "./deps.js";
import { recordError } from "./errorlog.js";
import { HttpError } from "./http.js";
import { currentUser, requireAuth } from "./middleware.js";
import { decryptSecret, encryptSecret } from "./secrets.js";
import { TelegramError } from "./telegram.js";
import type { TenantRecord } from "./store/types.js";

const TOKEN_RE = /^\d{6,12}:[A-Za-z0-9_-]{30,50}$/;
const HOOK_RE = /^[a-f0-9]{24}$/;

export { formatReply };

type Update = { update_id?: number; message?: { text?: string; chat?: { id?: number; type?: string }; from?: { first_name?: string; username?: string; is_bot?: boolean } } };

/** Bir Telegram yeniləməsini emal edir. Xətalar yuxarıda jurnala yazılır, Telegram-a həmişə 200 qayıdır. */
export async function processUpdate(deps: Deps, tenant: TenantRecord, update: Update): Promise<void> {
  const { telegram, config } = deps;
  const link = tenant.telegram;
  const msg = update.message;
  if (!link?.enabled || !msg?.chat || msg.chat.type !== "private" || msg.from?.is_bot || typeof msg.chat.id !== "number") return;
  if (typeof update.update_id === "number" && dedupe(`${tenant.tenantId}:${update.update_id}`)) return;
  const token = decryptSecret(link.tokenEnc, config.secretKey);
  const chatId = String(msg.chat.id);
  const text = typeof msg.text === "string" ? msg.text.trim() : "";
  const run = (txt: string) => handleChat(deps, tenant, {
    channel: "telegram", label: "Telegram", chatId, text: txt,
    senderName: [msg.from?.first_name, msg.from?.username ? `@${msg.from.username}` : ""].filter(Boolean).join(" "),
    send: (t) => telegram.sendMessage(token, chatId, t),
    photo: (url, caption) => telegram.sendPhoto(token, chatId, url, caption),
    typing: () => telegram.sendChatAction(token, chatId),
    reset: /^\/start(\s|@|$)/i.test(txt),
  });
  const batchMs = deps.telegramBatchMs ?? 4000;
  if (batchMs <= 0 || !text || text.startsWith("/")) return run(text);
  // Dalbadal mesajlar: sakitlik olanda hamısı bir sual kimi cavablanır
  const key = `${tenant.tenantId}|${chatId}`;
  const entry = tgBatches.get(key) ?? { texts: [], first: Date.now(), timer: undefined as unknown as NodeJS.Timeout };
  entry.texts.push(text);
  clearTimeout(entry.timer);
  const wait = Math.max(0, Math.min(batchMs, 12_000 - (Date.now() - entry.first)));
  entry.timer = setTimeout(() => {
    tgBatches.delete(key);
    run(entry.texts.join("\n").slice(0, MAX_TEXT)).catch((e) => reportUpdateError(deps, tenant, e));
  }, wait);
  tgBatches.set(key, entry);
}

const tgBatches = new Map<string, { texts: string[]; first: number; timer: NodeJS.Timeout }>();
function reportUpdateError(deps: Deps, tenant: TenantRecord, e: unknown) {
  console.warn(`[telegram] ${tenant.tenantId}: ${e instanceof Error ? e.message : e}`);
  void recordError(deps.store, { source: "channel", message: `Telegram: ${e instanceof Error ? e.message : String(e)}`, stack: e instanceof Error ? e.stack : undefined, tenantId: tenant.tenantId, code: "TELEGRAM_UPDATE" });
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
      await store.deleteChannelSessions(t.tenantId, "telegram");
    }
    res.json({ ok: true });
  });
  return r;
}
