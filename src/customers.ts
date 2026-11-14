// Müştərilər: canlı söhbətlər (sayt, Telegram, WhatsApp) və əlaqə formasından gələn müraciətlər bir müştəri kartında.
// Birləşdirmə açarı: telefon (son 9 rəqəm) və ya e-poçt; yoxdursa kanal ID-si; o da yoxdursa saytdakı ziyarətçinin pid-i.
// Ayrıca baza yoxdur: kart hər dəfə mövcud qeydlərdən hesablanır (son ~1000 söhbət və 500 müraciət).
import type { ChannelSession, LiveChat, TenantRecord } from "./store/types.js";
import { blockKeyOfChat, isBlocked } from "./visitors.js";

export type LeadLite = { id: string; at: string; name: string; contact: string; question: string; status?: string; handled?: boolean };
export type Customer = {
  id: string; name: string; contacts: string[]; channels: ("site" | "telegram" | "whatsapp" | "form")[];
  firstAt: string; lastAt: string; tags: string[]; blocked: boolean; csat: number | null;
  chats: { id: string; status: "open" | "closed"; channel: "site" | "telegram" | "whatsapp"; createdAt: string; count: number; first: string; tags: string[]; csat: number | null; assignee: string | null }[];
  leads: { id: string; at: string; status: string; question: string }[];
  visitor: { tz?: string; lang?: string; mobile?: boolean; first?: number; visits?: number; ref?: string } | null;
};

/** Telefon: son 9 rəqəm (+994 50 ... və 050 ... eyni olsun); e-poçt: kiçik hərf */
export function contactKey(c: string): string | null {
  const v = c.trim();
  if (!v) return null;
  if (v.includes("@")) return `e:${v.toLowerCase()}`;
  const d = v.replace(/\D/g, "");
  return d.length >= 7 ? `p:${d.slice(-9)}` : null;
}

/** Kanal müştərisinin real telefonu: WhatsApp gizli LID ünvanı göndəribsə chatId nömrə deyil */
export function sessionPhone(s: Pick<ChannelSession, "channel" | "chatId" | "ref" | "phone">): string {
  if (s.channel !== "whatsapp") return "";
  if (s.phone && /^\d{7,15}$/.test(s.phone)) return s.phone;
  if (s.ref?.endsWith("@lid")) return "";
  return /^\d{7,15}$/.test(s.chatId) ? s.chatId : "";
}

/** Köhnə qeydlər: LID ilə açılmış WhatsApp söhbətində "+LID" telefon kimi yazılıb, onu göstərmirik */
const chatContact = (ch: LiveChat) => (ch.channel?.type === "whatsapp" && ch.channel.ref?.endsWith("@lid") && ch.contact === `+${ch.channel.chatId}` ? "" : ch.contact);

export function buildCustomers(t: Pick<TenantRecord, "blocked">, chats: LiveChat[], leads: LeadLite[], q = "", sessions: ChannelSession[] = []): Customer[] {
  const byKey = new Map<string, Customer>();
  const alias = new Map<string, string>(); // ikinci açar → kartın id-si (eyni adamın həm telefonu, həm kanal ID-si)
  const iso = (d: Date | string) => new Date(d).toISOString();
  const card = (keys: string[], seed: { name: string; at: string }): Customer => {
    for (const k of keys) { const id = alias.get(k); if (id) { keys.forEach((x) => alias.set(x, id)); return byKey.get(id)!; } }
    const c: Customer = { id: keys[0]!, name: seed.name, contacts: [], channels: [], firstAt: seed.at, lastAt: seed.at, tags: [], blocked: false, csat: null, chats: [], leads: [], visitor: null };
    byKey.set(c.id, c);
    keys.forEach((x) => alias.set(x, c.id));
    return c;
  };
  const touch = (c: Customer, name: string, contact: string, at: string) => {
    if (!c.name && name) c.name = name;
    if (contact && !c.contacts.includes(contact)) c.contacts.push(contact);
    if (at < c.firstAt) c.firstAt = at;
    if (at > c.lastAt) c.lastAt = at;
  };

  for (const ch of [...chats].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())) {
    const contact = chatContact(ch);
    const keys = [contactKey(contact), ch.channel ? `${ch.channel.type}:${ch.channel.chatId}` : null, ch.visitor?.pid ? `v:${ch.visitor.pid}` : null].filter((k): k is string => Boolean(k));
    if (!keys.length) keys.push(`chat:${ch.id}`);
    const at = iso(ch.updatedAt ?? ch.createdAt);
    const c = card(keys, { name: ch.name, at: iso(ch.createdAt) });
    touch(c, ch.name, contact, at);
    const channel = ch.channel?.type ?? "site";
    if (!c.channels.includes(channel)) c.channels.push(channel);
    for (const g of ch.tags ?? []) if (!c.tags.includes(g)) c.tags.push(g);
    if (ch.csat) c.csat = ch.csat.rating;
    if (ch.visitor) { const { pid: _p, ...v } = ch.visitor; c.visitor = { ...c.visitor, ...v }; }
    if (isBlocked(t, blockKeyOfChat(ch))) c.blocked = true;
    c.chats.push({
      id: ch.id, status: ch.status, channel, createdAt: iso(ch.createdAt), count: ch.messages.length,
      first: (ch.messages.find((m) => m.from === "visitor")?.text ?? ch.context.find((m) => m.role === "user")?.text ?? "").slice(0, 120),
      tags: ch.tags ?? [], csat: ch.csat?.rating ?? null, assignee: ch.assignee?.name ?? null,
    });
  }
  // Botla yazışıb operatora keçməyən Telegram/WhatsApp müştəriləri də müştəridir
  for (const s of sessions) {
    const phone = sessionPhone(s);
    const keys = [phone ? contactKey(`+${phone}`) : null, `${s.channel}:${s.chatId}`].filter((k): k is string => Boolean(k));
    const at = iso(s.updatedAt);
    const c = card(keys, { name: s.name ?? "", at });
    touch(c, s.name ?? "", phone ? `+${phone}` : "", at);
    if (!c.channels.includes(s.channel)) c.channels.push(s.channel);
  }
  for (const l of leads) {
    const k = contactKey(l.contact);
    const c = card([k ?? `lead:${l.id}`], { name: l.name ?? "", at: l.at });
    touch(c, l.name ?? "", l.contact ?? "", l.at);
    if (!c.channels.includes("form")) c.channels.push("form");
    c.leads.push({ id: l.id, at: l.at, status: l.status ?? (l.handled ? "solved" : "new"), question: String(l.question ?? "").slice(0, 160) }); // köhnə/natamam yazı səhifəni yıxmasın
  }

  const needle = q.trim().toLocaleLowerCase();
  return [...byKey.values()]
    .map((c) => ({ ...c, chats: c.chats.reverse(), leads: c.leads.sort((a, b) => b.at.localeCompare(a.at)) }))
    .filter((c) => !needle || `${c.name} ${c.contacts.join(" ")} ${c.tags.join(" ")}`.toLocaleLowerCase().includes(needle))
    .sort((a, b) => b.lastAt.localeCompare(a.lastAt))
    .slice(0, 300);
}
