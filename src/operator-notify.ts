// Operatora Telegram bildirişi: platformanın öz bildiriş botu (NOTIFY_TELEGRAM_TOKEN) vasitəsilə.
// Müştərinin öz Telegram botundan ayrıdır: o bot ziyarətçilərə cavab verir, bu bot yalnız operatorlara xəbər göndərir.
//  - Operator paneldə "Telegram-da bildiriş al" basır -> birdəfəlik kodlu link (t.me/<bot>?start=<kod>) -> botda Start -> bağlanır.
//  - Yeni canlı söhbət başlayanda bağlı bütün operatorlara (sahib + komanda) mesaj gedir.
//  - Açıq söhbətdə ziyarətçi yazanda yalnız panel açıq deyilsə (heç bir operator soketi yoxdur) xəbər gedir, söhbət başına 3 dəqiqədə bir.
// Kodlar yaddaşda saxlanır (10 dəqiqə): tək server prosesi üçündür, çox serverdə kodu yaradan prosesə webhook gəlməyə bilər.
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { Router } from "express";
import type { Deps } from "./deps.js";
import { isAdmin } from "./deps.js";
import { hub } from "./hub.js";
import { HttpError } from "./http.js";
import { currentUser, requireAuth } from "./middleware.js";
import { tenantFor } from "./team.js";
import { TelegramError } from "./telegram.js";
import type { TenantRecord, User } from "./store/types.js";

const CODE_TTL_MS = 10 * 60_000;
const MSG_GAP_MS = 3 * 60_000;
const codes = new Map<string, { userId: string; exp: number }>();
/** Müraciətlərin göndəriləcəyi Telegram qrupunu bağlamaq üçün kodlar (bot qrupa "startgroup" linki ilə əlavə olunur) */
const groupCodes = new Map<string, { tenantId: string; exp: number }>();
let botUsername = "";

/** Webhook ünvanındakı gizli hissə və Telegram-ın göndərdiyi gizli başlıq: tokendən törədilir, ayrıca saxlanmır. */
const derive = (deps: Deps, label: string) => createHash("sha256").update(`${label}:${deps.config.notifyBotToken ?? ""}:${deps.config.aiServiceToken}`).digest("hex");
const hookOf = (deps: Deps) => derive(deps, "notify-hook").slice(0, 32);
const secretOf = (deps: Deps) => derive(deps, "notify-secret").slice(0, 48);
export const notifyAvailable = (deps: Deps) => Boolean(deps.config.notifyBotToken && botUsername);

/** Server başlayanda: botun adını öyrənir və webhook-u qurur. Alınmasa yalnız xəbərdarlıq yazılır (panel "əlçatan deyil" göstərir). */
export async function initNotifyBot(deps: Deps): Promise<void> {
  const token = deps.config.notifyBotToken;
  if (!token) return;
  if (!deps.config.publicPortalUrl.startsWith("https://")) { console.warn("[notify] PUBLIC_PORTAL_URL https deyil: Telegram bildiriş botu qoşulmadı"); return; }
  try {
    const me = await deps.telegram.getMe(token);
    await deps.telegram.setWebhook(token, { url: `${deps.config.publicPortalUrl}/telegram-notify/${hookOf(deps)}`, secret: secretOf(deps) });
    botUsername = me.username;
    console.log(`[notify] Telegram bildiriş botu hazırdır: @${me.username}`);
  } catch (e) {
    console.warn("[notify] Telegram bildiriş botu qoşulmadı:", e instanceof Error ? e.message : e);
  }
}

/** Testlər üçün: bot adını əl ilə qoyur. */
export const __setNotifyBot = (name: string) => { botUsername = name; codes.clear(); groupCodes.clear(); };

/** İstifadəçinin şəxsi Telegram-ını bağlamaq üçün birdəfəlik link (operator bildirişləri və admin xəbərdarlıqları eyni botdan gəlir). */
export function userLinkUrl(userId: string): { url: string; expiresInS: number } {
  for (const [k, v] of codes) if (v.exp < Date.now() || v.userId === userId) codes.delete(k);
  const code = randomBytes(12).toString("base64url");
  codes.set(code, { userId, exp: Date.now() + CODE_TTL_MS });
  return { url: `https://t.me/${botUsername}?start=${code}`, expiresInS: CODE_TTL_MS / 1000 };
}
export const notifyBotName = () => botUsername || null;

/** Müraciət qrupu üçün link: açılanda Telegram qrup seçdirir, botu əlavə edir və qrupa "/start <kod>" göndərir. */
export function groupLinkUrl(tenantId: string): { url: string; expiresInS: number } {
  for (const [k, v] of groupCodes) if (v.exp < Date.now() || v.tenantId === tenantId) groupCodes.delete(k);
  const code = randomBytes(12).toString("base64url");
  groupCodes.set(code, { tenantId, exp: Date.now() + CODE_TTL_MS });
  return { url: `https://t.me/${botUsername}?startgroup=${code}`, expiresInS: CODE_TTL_MS / 1000 };
}
/** Bildiriş botu ilə istənilən söhbətə (qrupa) mesaj. "gone": bot qrupdan çıxarılıb və ya qrup silinib. */
export const sendNotify = (deps: Deps, chatId: string, text: string) => send(deps, chatId, text);

async function send(deps: Deps, chatId: string, text: string): Promise<"ok" | "gone" | "fail"> {
  try { await deps.telegram.sendMessage(deps.config.notifyBotToken!, chatId, text); return "ok"; }
  catch (e) { return e instanceof TelegramError && (e.status === 403 || e.status === 400) ? "gone" : "fail"; }
}

/** Sahib və komanda üzvlərindən Telegram-ı bağlı olanlar. */
async function linkedUsers(deps: Deps, t: TenantRecord): Promise<User[]> {
  const ids = [t.userId, ...(t.team ?? []).map((m) => m.userId).filter((x): x is string => Boolean(x))];
  const users = await Promise.all([...new Set(ids)].map((id) => deps.store.findUserById(id)));
  return users.filter((u): u is User => Boolean(u?.tgNotify?.chatId));
}

const lastMsgAt = new Map<string, number>();
/** Panelin ünvanı: ALLOWED_ORIGINS-in birincisi (panel saytı) */
const panelUrl = (deps: Deps) => (deps.config.allowedOrigins[0] ? `\n\n${deps.config.allowedOrigins[0]}/inbox` : "");

/**
 * Canlı söhbət hadisəsi barədə operatorlara Telegram mesajı.
 * kind "start": həmişə (sayt üzrə saatda 30-a qədər). kind "message": yalnız panel açıq deyilsə və söhbət başına 3 dəqiqədə bir.
 */
export async function notifyOperators(deps: Deps, t: TenantRecord, p: { kind: "start" | "message"; chatId: string; channel: string; name?: string; text?: string; /** AI-ın ötürmə səbəbi, məs. "🔥 Almağa hazırdır" */ reason?: string }): Promise<void> {
  if (!notifyAvailable(deps)) return;
  try {
    if (p.kind === "message") {
      if (hub.operatorCount(t.tenantId) > 0) return; // panel açıqdır: operator onsuz da görür (səs və brauzer bildirişi)
      const last = lastMsgAt.get(p.chatId) ?? 0;
      if (Date.now() - last < MSG_GAP_MS) return;
      lastMsgAt.set(p.chatId, Date.now());
      if (lastMsgAt.size > 5000) for (const [k, v] of lastMsgAt) if (Date.now() - v > MSG_GAP_MS) lastMsgAt.delete(k);
    } else if (!deps.limiter.hit(`notify:tg:${t.tenantId}`, 30, 60 * 60_000)) return;
    const users = await linkedUsers(deps, t);
    if (!users.length) return;
    const who = p.name?.trim() ? p.name.trim().slice(0, 60) : "Ziyarətçi";
    const head = p.kind === "start" ? `${p.reason ? `${p.reason}\n` : ""}🟢 Yeni canlı söhbət (${p.channel}) · ${t.businessName}` : `💬 Yeni mesaj (${p.channel}) · ${t.businessName}`;
    const body = p.text?.trim() ? `\n\n${who}: ${p.text.trim().slice(0, 300)}` : `\n\n${who} operatorla yazışmaq istəyir.`;
    const text = `${head}${body}${panelUrl(deps)}`;
    for (const u of users) {
      const r = await send(deps, u.tgNotify!.chatId, text);
      if (r === "gone") await deps.store.updateUser(u.id, { tgNotify: null }); // botu bloklayıb və ya söhbəti silib
    }
  } catch (e) { console.warn("[notify] Telegram bildirişi göndərilmədi:", e instanceof Error ? e.message : e); }
}

type Update = { message?: { text?: string; chat?: { id?: number; type?: string; title?: string }; from?: { first_name?: string; username?: string; is_bot?: boolean } } };

/** İctimai webhook: Telegram bura çağırır. Yalnız "/start <kod>" bağlama üçündür, qalan mesajlara qısa izah verilir. */
export function notifyWebhook(deps: Deps) {
  const r = Router();
  r.post("/telegram-notify/:hook", async (req, res) => {
    const token = deps.config.notifyBotToken;
    const got = String(req.get("x-telegram-bot-api-secret-token") ?? ""), want = token ? secretOf(deps) : "";
    const a = Buffer.from(got), b = Buffer.from(want); // bayt uzunluğu: unicode başlıq timingSafeEqual-u xətaya salmasın
    if (!token || String(req.params.hook ?? "") !== hookOf(deps) || a.length !== b.length || !timingSafeEqual(a, b)) throw new HttpError(404, "Tapılmadı");
    res.json({ ok: true });
    const msg = ((req.body ?? {}) as Update).message;
    // Qrup: yalnız "/start@bot <kod>" (bot qrupa müraciət qrupu kimi əlavə olunanda). Qrupdakı digər yazışmalara bot qarışmır.
    if (msg?.chat && (msg.chat.type === "group" || msg.chat.type === "supergroup") && typeof msg.chat.id === "number" && !msg.from?.is_bot) {
      const g = (typeof msg.text === "string" ? msg.text.trim() : "").match(/^\/start(?:@\w+)?\s+([A-Za-z0-9_-]{10,40})$/);
      if (!g) return;
      const gid = String(msg.chat.id), c = groupCodes.get(g[1]!);
      groupCodes.delete(g[1]!);
      if (!c || c.exp < Date.now()) { await send(deps, gid, "Link köhnəlib. Paneldən yenisini al (link 10 dəqiqə etibarlıdır)."); return; }
      const t = await deps.store.findTenantById(c.tenantId);
      if (!t) return;
      await deps.store.updateTenant(t.tenantId, { leadForward: { ...(t.leadForward ?? {}), telegram: { chatId: gid, title: String(msg.chat.title ?? "").slice(0, 80) } } });
      await send(deps, gid, `✅ Bu qrup ${t.businessName} saytının yeni müraciətlərini alacaq (ad, əlaqə, sual). Ayırmaq üçün paneldə “Ayır” düyməsini bas və ya botu qrupdan çıxar.`);
      return;
    }
    if (!msg?.chat || msg.chat.type !== "private" || msg.from?.is_bot || typeof msg.chat.id !== "number") return;
    const chatId = String(msg.chat.id);
    const text = typeof msg.text === "string" ? msg.text.trim() : "";
    const m = text.match(/^\/start\s+([A-Za-z0-9_-]{10,40})$/);
    if (!m) { await send(deps, chatId, "Bu bot yalnız canlı söhbət bildirişləri göndərir. Bağlamaq üçün paneldə “Telegram-da bildiriş al” düyməsini bas."); return; }
    const c = codes.get(m[1]!);
    codes.delete(m[1]!);
    if (!c || c.exp < Date.now()) { await send(deps, chatId, "Link köhnəlib. Paneldən yenisini al (link 10 dəqiqə etibarlıdır)."); return; }
    const name = [msg.from?.first_name, msg.from?.username ? `@${msg.from.username}` : ""].filter(Boolean).join(" ").slice(0, 60);
    await deps.store.updateUser(c.userId, { tgNotify: { chatId, name, at: new Date() } });
    const linked = await deps.store.findUserById(c.userId);
    const admin = linked ? isAdmin(deps.config, linked) : false;
    await send(deps, chatId, admin
      ? "✅ Bildirişlər qoşuldu. Admin xəbərdarlıqları (xəta artımı, servis əlçatmazlığı, yeni yükləmə sorğusu, kanal problemləri) və öz saytının canlı söhbətləri burada gələcək.\n\nAyırmaq üçün admin paneldə “Ayarlar” bölməsinə bax."
      : "✅ Bildirişlər qoşuldu. Saytında yeni canlı söhbət başlayanda, panel bağlı olanda isə ziyarətçi yazanda burada xəbər alacaqsan.\n\nAyırmaq üçün paneldə “Ayır” düyməsini bas.");
  });
  return r;
}

/** Panel: /tenant/notify (sahib və operatorlar, hər kəs öz Telegram-ını bağlayır). */
export function notifyPanelRoutes(deps: Deps) {
  const r = Router();
  r.use("/notify", requireAuth);
  const me = async (res: Parameters<typeof currentUser>[0]) => {
    const user = currentUser(res);
    if (!(await tenantFor(deps.store, user))) throw new HttpError(404, "Əvvəlcə qurulumu tamamla", "NO_TENANT");
    return (await deps.store.findUserById(user.id)) ?? user;
  };
  const view = (u: User) => ({ available: notifyAvailable(deps), botUsername: botUsername || null, telegram: u.tgNotify ? { name: u.tgNotify.name, at: u.tgNotify.at } : null });

  r.get("/notify", async (_req, res) => { res.json(view(await me(res))); });
  r.post("/notify/telegram", async (_req, res) => {
    const u = await me(res);
    if (!notifyAvailable(deps)) throw new HttpError(503, "Telegram bildirişləri serverdə qoşulmayıb (NOTIFY_TELEGRAM_TOKEN)", "NOTIFY_OFF");
    if (!deps.limiter.hit(`notify:code:${u.id}`, 10, 10 * 60_000)) throw new HttpError(429, "Çox tez-tez sorğu", "RATE_LIMITED");
    res.json(userLinkUrl(u.id));
  });
  r.delete("/notify/telegram", async (_req, res) => {
    const u = await me(res);
    if (u.tgNotify && deps.config.notifyBotToken) await send(deps, u.tgNotify.chatId, "Bildirişlər ayrıldı. Yenidən qoşmaq üçün paneldən link al.");
    await deps.store.updateUser(u.id, { tgNotify: null });
    res.json(view({ ...u, tgNotify: null }));
  });
  return r;
}
