// Telegram/WhatsApp-da operatora keçid: müştəri "/operator" yazır → söhbət paneldəki "Canlı söhbət" siyahısına düşür, bot həmin söhbətdə susur,
// operatorun cavabı həmin kanala gedir. Operator bitirəndə (və ya müştəri "/bot" yazanda) bot geri qayıdır.
import { liveOpenNow } from "./helpdesk.js";
import { randomBytes, randomUUID } from "node:crypto";
import type { Deps } from "./deps.js";
import { decryptSecret } from "./secrets.js";
import { signedFileUrl } from "./live-files.js";
import type { LiveChat, TenantRecord } from "./store/types.js";
import { hub } from "./hub.js";
import { notifyTeam } from "./team.js";
import { notifyOperators } from "./operator-notify.js";

/** Operator cavab verməyibsə bot bu müddətdən sonra özü qayıdır (söhbət sonsuza qədər susmasın). */
export const LIVE_STALE_MS = Number(process.env.CHANNEL_LIVE_STALE_MS) || 12 * 60 * 60_000;

export const isOperatorCmd = (t: string) => /^\/?(operator|оператор|insan)(@\w+)?$/i.test(t.trim());
/** Müştəri açıq şəkildə insanla danışmaq istəyir ("operatora qoş", "insanla danışım", "talk to a human", "хочу поговорить с оператором"). Qısa mesaj + hədəf söz + niyyət sözü. */
export function wantsHuman(t: string): boolean {
  const s = t.trim().toLowerCase();
  if (!s || s.length > 100) return false;
  if (/mobil|azercell|bakcell|\bnar\b/.test(s)) return false;
  const target = /(operator|оператор|insan|\badam\b|canlı dəstək|canli destek|menecer|manager|менеджер|\badmin|human|real person|живой|человек|\bagent\b)/.test(s);
  const intent = /(danış|danis|yaz|qoş|qos|bağla|bagla|istəyir|isteyir|lazım|lazim|çağır|cagir|speak|talk|connect|transfer|chat with|need|want|свяж|соедин|поговор|хочу|нужен|позов)/.test(s);
  return target && intent;
}
export const isBotCmd = (t: string) => /^\/(bot|ai)(@\w+)?$/i.test(t.trim());


export const liveEnabled = (t: TenantRecord) => liveOpenNow(t);

/** Operatorun mesajını müştərinin kanalına göndərir. Alınmasa xəta atır. */
export async function deliverToChannel(deps: Deps, t: TenantRecord, chat: LiveChat, text: string): Promise<void> {
  const ch = chat.channel;
  if (!ch) return;
  if (ch.type === "telegram") {
    if (!t.telegram?.enabled) throw new Error("Telegram qoşulu deyil");
    await deps.telegram.sendMessage(decryptSecret(t.telegram.tokenEnc, deps.config.secretKey), ch.chatId, text);
  } else {
    if (!t.whatsapp?.enabled) throw new Error("WhatsApp qoşulu deyil");
    await deps.whatsapp.sendText(t.tenantId, ch.ref || `${ch.chatId}@s.whatsapp.net`, text);
  }
}

/** Operatorun faylını kanala göndərir. Telegram faylı müddətli imzalı linkdən özü yükləyir. Alınmasa xəta atır. */
export async function deliverFileToChannel(deps: Deps, t: TenantRecord, chat: LiveChat, f: { id: string; b64: string; mime: string; name: string; caption: string }): Promise<void> {
  const ch = chat.channel;
  if (!ch) return;
  if (ch.type === "telegram") {
    if (!t.telegram?.enabled) throw new Error("Telegram qoşulu deyil");
    const url = signedFileUrl(deps.config, t.tenantId, f.id);
    if (!url) throw new Error("CHANNEL_SECRET_KEY yoxdur");
    const token = decryptSecret(t.telegram.tokenEnc, deps.config.secretKey);
    if (f.mime.startsWith("image/")) await deps.telegram.sendPhoto(token, ch.chatId, url, f.caption);
    else if (deps.telegram.sendDocument) await deps.telegram.sendDocument(token, ch.chatId, url, f.caption);
    else throw new Error("Telegram sənəd göndərə bilmir");
  } else {
    if (!t.whatsapp?.enabled) throw new Error("WhatsApp qoşulu deyil");
    await deps.whatsapp.sendFile(t.tenantId, ch.ref || `${ch.chatId}@s.whatsapp.net`, { data: Buffer.from(f.b64, "base64"), mime: f.mime, name: f.name, caption: f.caption });
  }
}

export async function startChannelLive(deps: Deps, t: TenantRecord, p: { channel: "telegram" | "whatsapp"; chatId: string; ref?: string; name: string; history: { role: "user" | "model"; text: string }[]; /** operatorun görəcəyi ilk mesaj (müştərinin sualı) */ first?: string; /** operator özü başladıb: bildiriş göndərilmir */ quiet?: boolean }): Promise<LiveChat> {
  const now = new Date();
  const chat: LiveChat = {
    id: randomUUID(), tenantId: t.tenantId, tokenHash: randomBytes(16).toString("hex"), // kanal söhbətinə token ilə giriş yoxdur
    name: p.name.slice(0, 80), contact: p.channel === "whatsapp" && /^\d{7,15}$/.test(p.chatId) ? `+${p.chatId}` : "", status: "open",
    context: p.history.slice(-10), messages: p.first ? [{ from: "visitor", text: p.first.slice(0, 1000), at: now }] : [], createdAt: now, updatedAt: now, visitorSeenAt: now,
    channel: { type: p.channel, chatId: p.chatId, ...(p.ref && { ref: p.ref }) },
  };
  await deps.store.createLive(chat);
  if (!p.quiet) void notifyTeam(deps, t, `Canlı söhbət (${p.channel === "telegram" ? "Telegram" : "WhatsApp"}): ${t.businessName}`, `${p.channel === "telegram" ? "Telegram" : "WhatsApp"} kanalında müştəri operatorla yazışmaq istəyir.${p.first ? `\n\nMüştəri: ${p.first.slice(0, 300)}` : ""}\n\nPanelin "Müraciətlər" bölməsində "Canlı söhbət" tabını açın.`);
  hub.toOperators(t.tenantId, { t: "live", id: chat.id, kind: "start", ...(!p.quiet && { by: "visitor" }) });
  if (!p.quiet) void notifyOperators(deps, t, { kind: "start", chatId: chat.id, channel: p.channel === "telegram" ? "Telegram" : "WhatsApp", name: chat.name, ...(p.first && { text: p.first }) });
  return chat;
}
