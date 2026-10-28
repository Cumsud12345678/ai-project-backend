// Operator cavab yazanda ziyarətçi çatdan getmişsə ona e-poçt göndərir. Ziyarətçi çatdadırsa (cavabı birbaşa görür) e-poçt getmir.
import type { Deps } from "./deps.js";
import type { LiveChat, TenantRecord } from "./store/types.js";

/** Ziyarətçi bu müddətdən çox sorğu göndərməyibsə "çatda deyil" sayılır (vidjet açıqda 3 san, bağlıda 15 san, gizli tabda 30 san-dən bir sorğu göndərir). */
export const ABSENT_MS = Number(process.env.LIVE_ABSENT_MS) || 2 * 60_000;
/** Eyni söhbətə iki e-poçt arasında minimum fasilə və ümumi say. */
export const MAIL_GAP_MS = Number(process.env.LIVE_MAIL_GAP_MS) || 10 * 60_000;
export const MAIL_MAX = 5;

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
export const isEmail = (v: string) => EMAIL.test(v.trim());

export function shouldMailVisitor(chat: LiveChat, now = Date.now()): boolean {
  if (chat.status !== "open" || !isEmail(chat.contact || "")) return false;
  const seen = (chat.visitorSeenAt ?? chat.createdAt).getTime();
  if (now - seen < ABSENT_MS) return false; // ziyarətçi çatdadır
  if (chat.notifiedAt && now - chat.notifiedAt.getTime() < MAIL_GAP_MS) return false;
  return (chat.notifyCount ?? 0) < MAIL_MAX;
}

const T = {
  az: { subject: (b: string) => `${b}: operator sizə cavab verdi`, intro: "Saytdakı canlı söhbətdə operator sizə cavab yazdı:", more: "Daha çox mesaj ola bilər. Söhbətə qayıtmaq üçün saytı açın:", foot: "Bu məktub saytda canlı söhbətdə e-poçtunuzu yazdığınız üçün göndərilib. Bu sizə aid deyilsə, məktuba məhəl qoymayın." },
  en: { subject: (b: string) => `${b}: an operator replied to you`, intro: "An operator replied to you in the live chat on the website:", more: "There may be more messages. Open the website to continue the chat:", foot: "You received this because you entered your email in the live chat. If this is not for you, please ignore it." },
  ru: { subject: (b: string) => `${b}: оператор ответил вам`, intro: "Оператор ответил вам в онлайн-чате на сайте:", more: "Возможно, есть и другие сообщения. Откройте сайт, чтобы продолжить чат:", foot: "Вы получили это письмо, потому что указали e-mail в онлайн-чате. Если оно не для вас, просто проигнорируйте его." },
  tr: { subject: (b: string) => `${b}: operatör size yanıt verdi`, intro: "Sitedeki canlı sohbette operatör size yanıt yazdı:", more: "Başka mesajlar da olabilir. Sohbete dönmek için siteyi açın:", foot: "Bu e-postayı canlı sohbette e-postanızı girdiğiniz için aldınız. Size ait değilse lütfen dikkate almayın." },
} as const;

const siteUrl = (domain: string) => `https://${String(domain).replace(/^https?:\/\//i, "").replace(/\/.*$/, "")}`;

/** Göndərmə uğursuz olsa operatorun cavabına təsir etmir (xəta yalnız jurnala yazılır). */
export async function mailVisitorReply(deps: Deps, t: TenantRecord, chat: LiveChat, text: string): Promise<boolean> {
  if (!shouldMailVisitor(chat)) return false;
  const lang = ((t.config as { profile?: { language?: string } }).profile?.language ?? "az") as keyof typeof T;
  const m = T[lang] ?? T.az;
  try {
    await deps.store.patchLive(t.tenantId, chat.id, { notifiedAt: new Date(), notifyCount: (chat.notifyCount ?? 0) + 1 }); // əvvəl qeyd et: təkrar göndərilməsin
    await deps.mailer.send(chat.contact, m.subject(t.businessName), `${m.intro}\n\n${text.slice(0, 1000)}\n\n${m.more}\n${siteUrl(t.domain)}\n\n--\n${m.foot}`);
    return true;
  } catch (e) {
    console.warn("[live] ziyarətçiyə e-poçt göndərilmədi:", e instanceof Error ? e.message : e);
    return false;
  }
}
