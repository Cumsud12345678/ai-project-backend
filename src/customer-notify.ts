// Müştəriyə sonradan yazmaq: sifariş mərhələsi dəyişəndə, randevu ləğv olunanda və randevu xatırlatması.
// Ünvan (reach) söhbət zamanı AI servisinə verilir və sifariş/randevu ilə birlikdə saxlanır: Telegram chatId və ya WhatsApp JID.
// Saytdan (vidjet) gələn sifarişdə kanal yoxdur: əlaqə e-poçtdursa məktub gedir, telefondursa avtomatik bildiriş mümkün deyil.
import type { Deps } from "./deps.js";
import { decryptSecret } from "./secrets.js";
import type { Reach, TenantRecord } from "./store/types.js";

type Lang = "az" | "en" | "ru" | "tr";
const LANGS: Lang[] = ["az", "en", "ru", "tr"];
export const isEmailContact = (v: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v.trim());

export function parseReach(v: unknown): Reach | null {
  if (!v || typeof v !== "object") return null;
  const r = v as Record<string, unknown>;
  if ((r.type !== "telegram" && r.type !== "whatsapp") || typeof r.chatId !== "string" || !/^[\w.@:+-]{1,80}$/.test(r.chatId)) return null;
  return { type: r.type, chatId: r.chatId, ...(typeof r.ref === "string" && /^[\w.@:+-]{1,120}$/.test(r.ref) && { ref: r.ref }), ...(LANGS.includes(r.lang as Lang) && { lang: r.lang as Lang }) };
}

/** Kanal qoşulu deyilsə və ya göndərmə alınmasa xəta atır */
export async function sendToReach(deps: Deps, t: TenantRecord, reach: Reach, text: string): Promise<void> {
  if (reach.type === "telegram") {
    if (!t.telegram?.enabled) throw new Error("Telegram qoşulu deyil");
    await deps.telegram.sendMessage(decryptSecret(t.telegram.tokenEnc, deps.config.secretKey), reach.chatId, text);
  } else {
    if (!t.whatsapp?.enabled) throw new Error("WhatsApp qoşulu deyil");
    await deps.whatsapp.sendText(t.tenantId, reach.ref || `${reach.chatId}@s.whatsapp.net`, text);
  }
}

export const ORDER_STAGES = ["new", "confirmed", "shipped", "delivered", "cancelled"] as const;
export type OrderStage = (typeof ORDER_STAGES)[number];
const ORDER_TEXT: Record<Lang, Record<Exclude<OrderStage, "new">, string>> = {
  az: { confirmed: "✅ Sifarişiniz №{no} təsdiqləndi.", shipped: "🚚 Sifarişiniz №{no} yola çıxdı.", delivered: "📦 Sifarişiniz №{no} çatdırıldı. Bizi seçdiyiniz üçün təşəkkür edirik!", cancelled: "❌ Sifarişiniz №{no} ləğv olundu." },
  en: { confirmed: "✅ Your order #{no} is confirmed.", shipped: "🚚 Your order #{no} is on its way.", delivered: "📦 Your order #{no} has been delivered. Thank you for choosing us!", cancelled: "❌ Your order #{no} has been cancelled." },
  ru: { confirmed: "✅ Ваш заказ №{no} подтверждён.", shipped: "🚚 Ваш заказ №{no} отправлен.", delivered: "📦 Ваш заказ №{no} доставлен. Спасибо, что выбрали нас!", cancelled: "❌ Ваш заказ №{no} отменён." },
  tr: { confirmed: "✅ №{no} numaralı siparişiniz onaylandı.", shipped: "🚚 №{no} numaralı siparişiniz yola çıktı.", delivered: "📦 №{no} numaralı siparişiniz teslim edildi. Bizi tercih ettiğiniz için teşekkürler!", cancelled: "❌ №{no} numaralı siparişiniz iptal edildi." },
};
const NOTE: Record<Lang, string> = { az: "Qeyd", en: "Note", ru: "Примечание", tr: "Not" };
const langOf = (l?: string): Lang => (LANGS.includes(l as Lang) ? (l as Lang) : "az");
const fill = (s: string, v: Record<string, string>) => s.replace(/\{(\w+)\}/g, (_, k: string) => v[k] ?? "");
export const shortNo = (id: string) => id.slice(0, 8).toUpperCase();

export function orderStageText(stage: OrderStage, id: string, businessName: string, lang?: string, note = ""): string | null {
  if (stage === "new") return null;
  const l = langOf(lang);
  return `${businessName}: ${fill(ORDER_TEXT[l][stage], { no: shortNo(id) })}${note ? `\n${NOTE[l]}: ${note}` : ""}`;
}

const dmy = (date: string) => { const [y, m, d] = date.split("-"); return `${d}.${m}.${y}`; };
const BOOK_TEXT: Record<Lang, { reminder: string; cancelled: string; noShowIfLate: string }> = {
  az: { reminder: "⏰ Xatırlatma: {date} saat {time} sizi gözləyirik ({service}).", cancelled: "❌ {date} saat {time} randevunuz ({service}) ləğv olundu.", noShowIfLate: "Gələ bilməsəniz, zəhmət olmasa bizə yazın." },
  en: { reminder: "⏰ Reminder: we are expecting you on {date} at {time} ({service}).", cancelled: "❌ Your appointment on {date} at {time} ({service}) has been cancelled.", noShowIfLate: "If you can't make it, please let us know." },
  ru: { reminder: "⏰ Напоминание: ждём вас {date} в {time} ({service}).", cancelled: "❌ Ваша запись на {date} в {time} ({service}) отменена.", noShowIfLate: "Если не сможете прийти, пожалуйста, напишите нам." },
  tr: { reminder: "⏰ Hatırlatma: {date} saat {time} sizi bekliyoruz ({service}).", cancelled: "❌ {date} saat {time} randevunuz ({service}) iptal edildi.", noShowIfLate: "Gelemeyecekseniz lütfen bize yazın." },
};
export function bookingText(kind: "reminder" | "cancelled", b: { date: string; time: string; service: string }, businessName: string, lang?: string, note = ""): string {
  const l = langOf(lang), T = BOOK_TEXT[l];
  const body = fill(T[kind], { date: dmy(b.date), time: b.time, service: b.service });
  return `${businessName}: ${body}${kind === "reminder" ? ` ${T.noShowIfLate}` : ""}${note ? `\n${NOTE[l]}: ${note}` : ""}`;
}

/** AI servisindən gələn müraciət (sifariş/randevu sahələri ilə) */
export type Lead = {
  id: string; contact?: string;
  order?: { reach?: Reach; stage?: string; [k: string]: unknown };
  booking?: { reach?: Reach; date: string; time: string; service: string; start: string; status?: string; [k: string]: unknown };
  [k: string]: unknown;
};
/** Panelə: kanal ünvanı çıxarılır, əvəzinə müştəriyə necə yazıla biləcəyi göstərilir */
export function leadView(l: Lead) {
  const { order, booking, ...rest } = l;
  const strip = <T extends { reach?: Reach }>(x: T) => { const { reach: _r, ...o } = x; return o; };
  return {
    ...rest,
    ...(order && { order: { ...strip(order), notify: order.reach ? "channel" : isEmailContact(l.contact ?? "") ? "email" : null } }),
    ...(booking && { booking: { ...strip(booking), notify: booking.reach ? "channel" : null } }),
  } as Lead & { order?: { notify: string | null }; booking?: { notify: string | null } };
}
