// Susan müştəriyə xatırlatma (Telegram/WhatsApp): AI cavab verib, müştəri isə sahibin seçdiyi müddət (defolt 2 saat) yazmayıbsa,
// həmin sakitlik üçün BİR dəfə yumşaq mesaj gedir ("Sualınız qaldımı?"). Müştəri yenidən yazanda növbəti sakitlik üçün yenə bir dəfə.
//
// Göndərilmir: söhbət "sağ ol / tamam" ilə bitibsə, canlı operator söhbəti açıqdırsa, BƏLİ/XEYR təsdiqi gözlənilirsə, müştəri bloklanıbsa,
// sahib WhatsApp-da telefondan özü yazıb (bot susdurulub), hesab dayandırılıbsa və ya son mesajdan 23 saatdan çox keçibsə
// (kanalların 24 saatlıq qaydası və nəzakət). Nömrənin qorunması üçün hesab başına 10 dəqiqədə ən çox 30 xatırlatma.
import type { Deps } from "./deps.js";
import { HttpError } from "./http.js";
import { channelTexts, chatLang } from "./channel-i18n.js";
import { decryptSecret } from "./secrets.js";
import { recordError } from "./errorlog.js";
import { isBlocked } from "./visitors.js";
import type { ChannelSession, FollowupSettings, TenantRecord } from "./store/types.js";

export const FOLLOWUP_DELAYS = [30, 60, 120, 240, 720] as const;
export const DEFAULT_FOLLOWUP: FollowupSettings = { enabled: false, delayMin: 120 };
const MAX_AGE_MS = 23 * 60 * 60_000;
const MIN_DELAY_MS = Math.min(...FOLLOWUP_DELAYS) * 60_000;
const PER_TENANT = 30;
const HISTORY_KEEP = 10;

/** Söhbət müştəri tərəfindən bitirilib: təşəkkür, razılıq, sağollaşma (xatırlatma yersiz olar) */
const DONE_RE = /^(çox\s+)?(sağ\s*ol|sag\s*ol|saq\s*ol|təşəkkür|tesekkur|minnətdar|tamam|oldu|ok(ay)?|anladım|anladim|aydındır|aydindir|əla|ela|super|thanks?|thank you|thx|ty|got it|bye|спасибо|благодарю|понятно|ок|хорошо|пока|teşekkür|tesekkürler|sağ ?olun|eyvallah|görüşərik|gorusuruk|\p{Extended_Pictographic})[\s!.,)\p{Extended_Pictographic}\uFE0F]*$/iu;
export const conversationDone = (text: string) => DONE_RE.test(text.trim());

export const followupOf = (t: Pick<TenantRecord, "followup">): FollowupSettings => ({ ...DEFAULT_FOLLOWUP, ...(t.followup ?? {}) });

/** Panelin göndərdiyi ayar; səhv varsa HttpError */
export function parseFollowup(body: unknown): FollowupSettings {
  const b = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
  if (typeof b.enabled !== "boolean") throw new HttpError(400, "enabled true/false olmalıdır");
  const delayMin = Number(b.delayMin ?? DEFAULT_FOLLOWUP.delayMin);
  if (!(FOLLOWUP_DELAYS as readonly number[]).includes(delayMin)) throw new HttpError(400, `Gecikmə bunlardan biri olmalıdır: ${FOLLOWUP_DELAYS.join(", ")} dəqiqə`);
  if (b.text !== undefined && b.text !== null && typeof b.text !== "string") throw new HttpError(400, "Mətn yazı olmalıdır");
  const text = typeof b.text === "string" ? b.text.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, " ").trim() : "";
  if (text.length > 300) throw new HttpError(400, "Xatırlatma mətni ən çox 300 simvol ola bilər");
  return { enabled: b.enabled, delayMin, ...(text && { text }) };
}

/** Bu söhbətə indi xatırlatma göndərmək olarmı (kanal və canlı söhbət yoxlamasından əvvəlki sadə şərtlər) */
export function dueFor(s: ChannelSession, cfg: FollowupSettings, now = Date.now()): boolean {
  const at = new Date(s.updatedAt).getTime();
  if (!cfg.enabled || now - at < cfg.delayMin * 60_000 || now - at > MAX_AGE_MS) return false;
  if (s.followedUpAt && new Date(s.followedUpAt).getTime() >= at) return false; // bu sakitlik üçün artıq göndərilib
  if (s.pendingAction) return false;
  const last = s.history.at(-1);
  const lastUser = [...s.history].reverse().find((m) => m.role === "user");
  return Boolean(last && last.role === "model" && lastUser && !conversationDone(lastUser.text));
}

const jidOf = (s: ChannelSession) => s.ref || `${s.chatId}@s.whatsapp.net`;

/** Bir dövr: vaxtı çatmış söhbətlərə xatırlatma göndərir. Qaytarır: göndərilənlərin sayı. */
export async function runFollowups(deps: Deps, now = Date.now()): Promise<number> {
  const { store } = deps;
  const sessions = await store.listIdleChannelSessions(new Date(now - MAX_AGE_MS), new Date(now - MIN_DELAY_MS), 2000);
  if (!sessions.length) return 0;
  const ids = [...new Set(sessions.map((s) => s.tenantId))];
  const tenants = new Map((await store.findTenantsByIds(ids)).map((t) => [t.tenantId, t]));
  let sent = 0;
  for (const s of sessions) {
    const t = tenants.get(s.tenantId);
    if (!t || t.suspended) continue;
    const cfg = followupOf(t);
    if (!dueFor(s, cfg, now)) continue;
    if (isBlocked(t, `${s.channel === "telegram" ? "tg" : "wa"}:${s.chatId}`)) continue;
    if (s.channel === "telegram" ? !t.telegram?.enabled : !t.whatsapp?.enabled || deps.whatsapp.isPaused(t.tenantId, jidOf(s))) continue;
    if (await store.findLiveByChannel(t.tenantId, s.channel, s.chatId)) continue; // operator söhbəti açıqdır
    if (!deps.limiter.hit(`followup:${t.tenantId}`, PER_TENANT, 10 * 60_000)) continue;
    const lastUser = [...s.history].reverse().find((m) => m.role === "user")?.text ?? "";
    const text = cfg.text || channelTexts(chatLang(t, lastUser), 0, 0).followup;
    try {
      if (s.channel === "telegram") await deps.telegram.sendMessage(decryptSecret(t.telegram!.tokenEnc, deps.config.secretKey), s.chatId, text);
      else await deps.whatsapp.sendText(t.tenantId, jidOf(s), text);
      sent++;
    } catch (e) {
      void recordError(store, { source: "channel", message: `Xatırlatma göndərilmədi (${s.channel}): ${e instanceof Error ? e.message : String(e)}`, tenantId: t.tenantId, code: "FOLLOWUP_SEND" });
    }
    // Alınmasa da qeyd olunur: eyni söhbətə hər dövr təkrar cəhd edilməsin. updatedAt dəyişmir (müştərinin son hərəkəti).
    await store.saveChannelSession({ ...s, history: [...s.history, { role: "model" as const, text }].slice(-HISTORY_KEEP), followedUpAt: new Date(now) });
  }
  return sent;
}

export function startFollowupScheduler(deps: Deps): () => void {
  if (process.env.FOLLOWUPS === "off") return () => {};
  const tick = () => { runFollowups(deps).catch((e) => { void recordError(deps.store, { source: "job", message: `Xatırlatmalar: ${e instanceof Error ? e.message : String(e)}`, code: "FOLLOWUP_JOB" }); }); };
  const first = setTimeout(tick, 60_000);
  const timer = setInterval(tick, 5 * 60_000);
  first.unref?.(); timer.unref?.();
  return () => { clearTimeout(first); clearInterval(timer); };
}
