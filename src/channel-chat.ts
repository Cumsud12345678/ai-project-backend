// Kanallar (Telegram, WhatsApp) üçün ortaq söhbət məntiqi: limitlər, tarixçə, AI çağırışı, cavab tapılmayanda kontakt yığımı.
import { randomBytes } from "node:crypto";
import { AiError } from "./ai.js";
import { notifyBalance } from "./billing.js";
import type { Deps } from "./deps.js";
import { recordError } from "./errorlog.js";
import { imageEnabled, checkBufferImage } from "./image-input.js";
import { cleanContact } from "./kb.js";
import type { ChannelSession, TenantRecord } from "./store/types.js";
import { hub } from "./hub.js";
import { LIVE_MSG, LIVE_STALE_MS, isBotCmd, isOperatorCmd, liveEnabled, startChannelLive, wantsHuman } from "./channel-live.js";
import { DEFAULT_GREETING, DEFAULT_GREETING_SUPPORT, limitsOf, modeOf } from "./widget.js";

export const MAX_TEXT = 500;
const HISTORY_KEEP = 10;
const SESSION_IDLE_MS = 12 * 60 * 60_000; // 12 saat yazılmayıbsa yeni söhbət sayılır

export const MSG = {
  textOnly: "Hələlik yalnız yazılı mesajlara cavab verə bilirəm. Sualınızı yazın.",
  tooLong: `Mesaj çox uzundur (maksimum ${MAX_TEXT} simvol). Qısaldıb yenidən yazın.`,
  slowDown: "Çox tez-tez yazırsınız, bir az gözləyib yenidən yazın.",
  dayLimit: "Bu gün üçün sual limitinə çatdınız. Sabah yenidən yazın.",
  busy: "Çat müvəqqəti məşğuldur, bir azdan yenidən yazın.",
  offline: "Çat hazırda cavab verə bilmir. Bir az sonra yenidən yazın.",
  askContact: "Bu sualın cavabını tapa bilmədim. İstəsəniz operator sizinlə əlaqə saxlasın: telefon nömrənizi və ya e-poçtunuzu yazın.",
  imageOff: "Şəkil qəbul edə bilmirəm. Sualınızı yazın.",
  imageFail: "Şəkli oxuya bilmədim (PNG, JPG və ya WebP, kiçik ölçüdə olmalıdır). Başqa şəkil göndərin və ya sualı yazın.",
  thanks: "Təşəkkürlər, müraciətiniz qəbul edildi. Operator tezliklə sizinlə əlaqə saxlayacaq.",
} as const;

export const clip = (v: unknown, n: number) => String(v ?? "").trim().slice(0, n);
const httpUrl = (v: unknown) => (typeof v === "string" && /^https?:\/\//i.test(v) && v.length < 2000 ? v : "");

/** AI cavabını mesajlaşma proqramı üçün düz mətnə çevirir (formatlama simvolları yoxdur). */
/** hide: şəkli ayrıca göndərilən elanların indekslərı (mətndə təkrarlanmasın) */
export function listingText(l: Record<string, unknown>): string {
  const price = typeof l.price === "number" ? ` — ${l.price}${l.currency ? ` ${clip(l.currency, 8)}` : ""}` : "";
  const url = httpUrl(l.url);
  return `• ${clip(l.title, 120) || "Elan"}${price}${url ? `\n${url}` : ""}`;
}

export function formatReply(out: Record<string, any>, hide: Set<number> = new Set()): string {
  const parts = [clip(out.answer, 3000) || "..."];
  const items = (Array.isArray(out.listings) ? out.listings : []).slice(0, 3).map((l: Record<string, unknown>, i: number) => hide.has(i) ? "" : listingText(l)).filter(Boolean);
  if (items.length) parts.push(items.join("\n"));
  const src = (Array.isArray(out.sources) ? out.sources : []).slice(0, 2).map((s: Record<string, unknown>) => {
    const url = httpUrl(s.url);
    return `${clip(s.title, 100)}${url ? ` ${url}` : ""}`.trim();
  }).filter(Boolean);
  if (src.length) parts.push(`Mənbə: ${src.join(", ")}`);
  return parts.join("\n\n").slice(0, 3900);
}

// Eyni yeniləməni təkrar emal etməmək üçün son açarlar yadda saxlanır
const seen = new Map<string, number>();
export const dedupe = (key: string) => {
  const now = Date.now();
  if (seen.size > 5000) for (const [k, t] of seen) if (now - t > 600_000) seen.delete(k);
  if (seen.has(key)) return true;
  seen.set(key, now);
  return false;
};
// Eyni söhbətdən ardıcıl mesajlar sıra ilə emal olunur (tarixçə qarışmasın)
const chains = new Map<string, Promise<unknown>>();
export const serial = <T,>(key: string, fn: () => Promise<T>): Promise<T> => {
  const next = (chains.get(key) ?? Promise.resolve()).catch(() => {}).then(fn);
  chains.set(key, next);
  void next.finally(() => { if (chains.get(key) === next) chains.delete(key); }).catch(() => {});
  return next;
};

export type ChatIO = {
  channel: "telegram" | "whatsapp";
  /** Xəta jurnalı və e-poçt mövzusu üçün ad ("Telegram", "WhatsApp") */
  label: string;
  chatId: string;
  text: string;
  senderName: string;
  /** Qarşı tərəfə düz mətn göndərir */
  send(text: string): Promise<unknown>;
  /** Şəkil + başlıq göndərir; alınmasa xəta atır (çağıran mətnə keçir). Yoxdursa şəkil göndərilmir. */
  photo?(url: string, caption: string): Promise<unknown>;
  /** Mesajda şəkil varsa: baytları yükləyən funksiya (null = yüklənmədi). Mətn (başlıq) text-dədir. */
  image?: { load(): Promise<Buffer | null> };
  /** "yazır..." göstəricisi (alınmasa da davam edilir) */
  typing(): Promise<unknown> | void;
  /** Söhbəti sıfırlayıb salamlama göndərmək (/start) */
  reset?: boolean;
  /** Kanalın daxili ünvanı (WhatsApp-da tam JID): operator cavabı bununla çatdırılır */
  ref?: string;
};

/** Bir daxil olan mətn mesajını emal edir. Eyni söhbət üzrə ardıcıl işləyir. */
export function handleChat(deps: Deps, tenant: TenantRecord, io: ChatIO): Promise<void> {
  const { store, ai, limiter, mailer } = deps;
  const { channel, chatId, label } = io;
  const text = io.text.trim();
  const lk = `${channel}:`;
  // Eyni mesajda xəbərdarlıq spamı olmasın: dəqiqədə ən çox 1 xəbərdarlıq
  const warn = async (m: string) => { if (limiter.hit(`${lk}warn:${tenant.tenantId}:${chatId}`, 1, 60_000)) await io.send(m); };

  return serial(`${tenant.tenantId}:${channel}:${chatId}`, async () => {
    const mode = modeOf(tenant.config);
    const greeting = tenant.widget?.greeting || (mode === "support" ? DEFAULT_GREETING_SUPPORT : DEFAULT_GREETING);
    let session: ChannelSession = (await store.getChannelSession(tenant.tenantId, channel, chatId)) ?? { tenantId: tenant.tenantId, channel, chatId, sid: randomBytes(12).toString("hex"), history: [], updatedAt: new Date() };
    if (Date.now() - new Date(session.updatedAt).getTime() > SESSION_IDLE_MS) session = { ...session, sid: randomBytes(12).toString("hex"), history: [], pending: null };

    // Operatorla canlı yazışma: açıq canlı söhbət varsa bot susur, mesaj operatora gedir
    const liveNow = await store.findLiveByChannel(tenant.tenantId, channel, chatId);
    if (liveNow && Date.now() - liveNow.updatedAt.getTime() > LIVE_STALE_MS) {
      await store.pushLive(tenant.tenantId, liveNow.id, { from: "system", text: "closed", at: new Date() }, { status: "closed" });
      hub.toOperators(tenant.tenantId, { t: "live", id: liveNow.id, kind: "close" });
    } else if (liveNow) {
      if (isBotCmd(text)) {
        await store.pushLive(tenant.tenantId, liveNow.id, { from: "system", text: "closed", at: new Date() }, { status: "closed" });
        hub.toOperators(tenant.tenantId, { t: "live", id: liveNow.id, kind: "close" });
        await io.send(LIVE_MSG.back);
        return;
      }
      const body = clip(text, 1000) || (io.image ? "[şəkil]" : "");
      if (!body) return;
      if (!limiter.hit(`${lk}liverate:${tenant.tenantId}:${chatId}`, 20, 60_000)) return;
      await store.pushLive(tenant.tenantId, liveNow.id, { from: "visitor", text: body, at: new Date() }, { visitorSeenAt: new Date(), ...(!liveNow.name && io.senderName ? { name: clip(io.senderName, 80) } : {}) });
      hub.toOperators(tenant.tenantId, { t: "live", id: liveNow.id, kind: "message" });
      return;
    } else if ((isOperatorCmd(text) || (liveEnabled(tenant) && wantsHuman(text))) && !io.reset) {
      if (!liveEnabled(tenant)) { await io.send(LIVE_MSG.off); return; }
      await startChannelLive(deps, tenant, { channel, chatId, ...(io.ref && { ref: io.ref }), name: clip(io.senderName, 80), history: session.history, ...(!isOperatorCmd(text) && { first: text }) });
      await io.send(LIVE_MSG.on);
      return;
    }

    if (io.reset) {
      await store.saveChannelSession({ ...session, history: [], pending: null, updatedAt: new Date() });
      await io.send(greeting);
      return;
    }
    const imgOn = Boolean(io.image) && imageEnabled(tenant);
    if (!text && !imgOn) return warn(io.image ? MSG.imageOff : MSG.textOnly);
    if (text.length > MAX_TEXT) return warn(MSG.tooLong);

    // Cavab tapılmayandan sonra gələn mesaj: etibarlı kontaktdırsa müraciət olur, deyilsə adi sual kimi davam edir
    if (session.pending && !imgOn) {
      const contact = cleanContact(text);
      if (contact) {
        const name = clip(io.senderName, 80);
        const question = session.pending.question;
        try { await ai.kbAddLead(tenant.tenantId, { name, contact, question, conversation: session.history.slice(-10) }); }
        catch (e) {
          if (e instanceof AiError) { await recordError(store, { source: "channel", message: `${label} müraciəti yazıla bilmədi: ${e.message}`, tenantId: tenant.tenantId, code: e.code }); await io.send(MSG.offline); return; }
          throw e;
        }
        try {
          const owner = await store.findUserById(tenant.userId);
          if (owner) await mailer.send(owner.email, `Yeni müraciət (${label}): ${tenant.businessName}`, `${label} kanalından yeni müraciət var.\n\nAd: ${name || "-"}\nƏlaqə: ${contact}\nSual: ${question || "-"}`);
        } catch { /* bildiriş alınmasa da müraciət paneldə qalır; mailer xətası artıq jurnala yazılıb */ }
        await store.saveChannelSession({ ...session, pending: null, updatedAt: new Date() });
        await io.send(MSG.thanks);
        return;
      }
      session = { ...session, pending: null };
    }

    // Limitlər vidjetlə eyni qaydadadır: müştərinin təyin etdiyi günlük və saatlıq həddlər
    const lim = limitsOf(tenant.widget);
    if (!limiter.hit(`${lk}min:${tenant.tenantId}:${chatId}`, 10, 60_000)) return warn(MSG.slowDown);
    if (lim.perVisitorDay > 0 && !limiter.hit(`${lk}day:${tenant.tenantId}:${chatId}`, lim.perVisitorDay, 24 * 60 * 60_000)) return warn(MSG.dayLimit);
    if (lim.siteHour > 0 && !limiter.hit(`${lk}hour:${tenant.tenantId}`, lim.siteHour, 60 * 60_000)) return warn(MSG.busy);

    // Şəkil: ayrıca limit (ziyarətçi başına 10 dəqiqədə 6, sayt üzrə saatda 200), sonra yüklənir və yoxlanır
    let image: string | undefined;
    if (imgOn) {
      if (!limiter.hit(`${lk}img:${tenant.tenantId}:${chatId}`, 6, 10 * 60_000) || !limiter.hit(`${lk}imgsite:${tenant.tenantId}`, 200, 60 * 60_000)) return warn(MSG.slowDown);
      let buf: Buffer | null = null;
      try { buf = await io.image!.load(); } catch { buf = null; }
      image = checkBufferImage(buf) ?? undefined;
      if (!image) return warn(MSG.imageFail);
    }
    try { void Promise.resolve(io.typing()).catch(() => {}); } catch { /* göstərici vacib deyil */ }
    let out: Record<string, any>;
    try { out = await ai.chat(tenant.tenantId, text, session.history.slice(-HISTORY_KEEP), { sid: session.sid, ...(liveEnabled(tenant) && { live: true }), ...(image && { image }) }); }
    catch (e) {
      if (e instanceof AiError) {
        if (e.status !== 402) await recordError(store, { source: "channel", message: `${label}: AI cavab vermədi (${e.status}) ${e.message}`, tenantId: tenant.tenantId, code: e.code, status: e.status });
        await io.send(MSG.offline);
        return;
      }
      throw e;
    }
    const notify = out.billing?.notify;
    if (notify === "low" || notify === "empty") void notifyBalance(deps, tenant, notify, out.billing?.balanceAzn);
    const withPhoto = io.photo
      ? (Array.isArray(out.listings) ? out.listings : []).slice(0, 3).map((l: Record<string, unknown>, i: number) => ({ l, i, img: httpUrl(l.image) })).filter((x: { img: string }) => x.img)
      : [];
    const answer = formatReply(out, new Set(withPhoto.map((x: { i: number }) => x.i)));
    const handoff = out.handoff === true && liveEnabled(tenant);
    const unanswered = out.unanswered === true && !handoff;
    const history = [...session.history, { role: "user" as const, text: `${text}${image ? `${text ? " " : ""}[şəkil${typeof out.imageNote === "string" && out.imageNote ? `: ${out.imageNote}` : ""}]` : ""}`.slice(0, 600) }, { role: "model" as const, text: clip(out.answer, 600) }].slice(-HISTORY_KEEP);
    await store.saveChannelSession({ ...session, history, pending: unanswered ? { question: text.slice(0, 500) } : null, ...(clip(io.senderName, 80) && { name: clip(io.senderName, 80) }), ...(io.ref && { ref: io.ref }), updatedAt: new Date() });
    // AI operatora ötürmə qərarı verdi: söhbət canlı operator qutusuna düşür, bot susur
    if (handoff) await startChannelLive(deps, tenant, { channel, chatId, ...(io.ref && { ref: io.ref }), name: clip(io.senderName, 80), history, ...(text && { first: text }) });
    await io.send(unanswered ? `${answer}\n\n${MSG.askContact}${liveEnabled(tenant) ? `\n${LIVE_MSG.hint}` : ""}` : answer);
    // Şəkilli elanlar ayrıca göndərilir; alınmayan olarsa mətn kimi
    for (const { l, img } of withPhoto) {
      const caption = listingText(l);
      try { await io.photo!(img, caption); } catch { await io.send(caption).catch(() => {}); }
    }
  });
}
