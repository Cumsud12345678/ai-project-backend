// Randevu (portal tərəfi): AI randevunu qeydə alanda sahibə xəbər (e-poçt, ötürmə, panel siqnalı) və
// Telegram/WhatsApp-dan yazılan müştəriyə xatırlatma planı: randevuya 24 saatdan çox varsa bir gün əvvəl, azdırsa 2 saat əvvəl.
// Xatırlatmalar bazada saxlanır (server yenidən başlasa da itmir), planlayıcı dəqiqədə bir yoxlayır.
import { randomUUID } from "node:crypto";
import { bookingText, sendToReach } from "./customer-notify.js";
import type { Deps } from "./deps.js";
import { recordError } from "./errorlog.js";
import { hub } from "./hub.js";
import { notifyTeam } from "./operator-notify.js";
import { forwardLead } from "./lead-forward.js";
import type { Reach, TenantRecord } from "./store/types.js";

export type BookingInfo = { id: string; title: string; service: string; date: string; time: string; start: string; name: string; contact: string; reminders: boolean };
const str = (v: unknown, n: number) => (typeof v === "string" ? v.replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, n) : "");

export function parseBookingInfo(v: unknown): BookingInfo | null {
  if (!v || typeof v !== "object") return null;
  const o = v as Record<string, unknown>;
  const b = { id: str(o.id, 60), title: str(o.title, 60) || "Randevu", service: str(o.service, 60), date: str(o.date, 10), time: str(o.time, 5), start: str(o.start, 40), name: str(o.name, 80), contact: str(o.contact, 40), reminders: o.reminders !== false };
  if (!b.id || !b.service || !/^\d{4}-\d{2}-\d{2}$/.test(b.date) || !/^\d{2}:\d{2}$/.test(b.time) || Number.isNaN(Date.parse(b.start))) return null;
  return b;
}

const HOUR = 3_600_000;
/** Xatırlatma vaxtı: 26 saatdan çox varsa 24 saat əvvəl, 3 saatdan çox varsa 2 saat əvvəl, yoxsa göndərilmir */
export function reminderAt(startMs: number, now = Date.now()): number | null {
  const left = startMs - now;
  if (left > 26 * HOUR) return startMs - 24 * HOUR;
  if (left > 3 * HOUR) return startMs - 2 * HOUR;
  return null;
}

export async function scheduleBookingReminder(deps: Deps, t: TenantRecord, b: Pick<BookingInfo, "id" | "date" | "time" | "service" | "start">, reach: Reach): Promise<boolean> {
  const at = reminderAt(Date.parse(b.start));
  if (at === null) return false;
  await deps.store.deleteRemindersByRef(t.tenantId, b.id);
  await deps.store.addReminder({ id: randomUUID(), tenantId: t.tenantId, ref: b.id, at: new Date(at), reach, text: bookingText("reminder", b, t.businessName, reach.lang), createdAt: new Date() });
  return true;
}

/** Yeni randevu: sahibə e-poçt, ötürmə (Telegram qrupu / Bitrix / webhook), panel siqnalı, xatırlatma. */
export async function onBooking(deps: Deps, t: TenantRecord, raw: unknown, source: string, reach: Reach | null, conversation: { role: string; text: string }[] = []): Promise<void> {
  const b = parseBookingInfo(raw);
  if (!b) return;
  hub.toOperators(t.tenantId, { t: "leads", kind: "booking" });
  const line = `${b.service} · ${b.date} ${b.time}`;
  void notifyTeam(deps, t, `📅 Yeni randevu (${source}) · ${t.businessName}\n\n${line}\n${[b.name, b.contact].filter(Boolean).join(", ")}`, "/bookings");
  void forwardLead(deps, t, { source: `${source}, randevu`, name: b.name, contact: b.contact, question: `${b.title}: ${line}`, conversation: conversation.slice(-10) });
  if (reach && b.reminders) await scheduleBookingReminder(deps, t, b, reach).catch((e) => console.warn("[booking] xatırlatma planlanmadı:", e instanceof Error ? e.message : e));
  try {
    const owner = await deps.store.findUserById(t.userId);
    if (!owner) return;
    await deps.mailer.send(owner.email, `📅 Yeni randevu: ${line} · ${t.businessName}`,
      `Çat (${source}) yeni randevu qeydə aldı.\n\nXidmət: ${b.service}\nGün və saat: ${b.date} ${b.time}\nAd: ${b.name || "-"}\nƏlaqə: ${b.contact || "-"}\n\nRandevuları paneldə görə və ləğv edə bilərsiniz:\n${deps.config.allowedOrigins[0] ?? ""}/bookings`,
      { action: "Randevulara bax", preheader: `${b.name || b.contact}: ${line}` });
  } catch (e) { console.warn("[booking] sahibə bildiriş göndərilmədi:", e instanceof Error ? e.message : e); }
}

/** Vaxtı çatmış xatırlatmaları göndərir. Randevunun vaxtı keçibsə (server uzun müddət dayanıb) göndərmədən silir. */
export async function runReminders(deps: Deps, now = Date.now()): Promise<number> {
  let sent = 0;
  for (const r of await deps.store.dueReminders(new Date(now), 200)) {
    await deps.store.deleteReminder(r.id); // əvvəl silinir: xəta olsa belə müştəriyə iki dəfə getməsin
    if (now - r.at.getTime() > 3 * HOUR) continue;
    const t = await deps.store.findTenantById(r.tenantId);
    if (!t || t.suspended) continue;
    try { await sendToReach(deps, t, r.reach, r.text); sent++; }
    catch (e) { void recordError(deps.store, { source: "channel", message: `Randevu xatırlatması göndərilmədi (${r.reach.type}): ${e instanceof Error ? e.message : String(e)}`, tenantId: r.tenantId, code: "BOOKING_REMINDER" }); }
  }
  return sent;
}

export function startReminderScheduler(deps: Deps): () => void {
  let busy = false;
  const tick = async () => { if (busy) return; busy = true; try { await runReminders(deps); } catch (e) { console.warn("[booking] xatırlatma planlayıcısı:", e instanceof Error ? e.message : e); } finally { busy = false; } };
  const h = setInterval(tick, 60_000);
  h.unref?.();
  return () => clearInterval(h);
}
