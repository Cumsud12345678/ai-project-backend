// Balansla bağlı portal köməkçiləri: məbləğin yoxlanması və email bildirişləri (hamısı "best effort": alınmasa əsas əməliyyat pozulmur).
import type { MailOptions } from "./mailer.js";
import type { Deps } from "./deps.js";
import { HttpError } from "./http.js";
import type { TenantRecord } from "./store/types.js";
import { alertDailyLimit, alertOrder, alertTopupRequest } from "./alerts.js";
import { invalidateEntitlements } from "./plans.js";

export function parseAmount(v: unknown, { allowNegative = false } = {}): number {
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v.replace(",", ".")) : NaN;
  if (!Number.isFinite(n) || n === 0 || (!allowNegative && n < 0) || Math.abs(n) > 100_000) throw new HttpError(400, "Məbləğ düzgün deyil", "BAD_AMOUNT");
  return Math.round(n * 100) / 100;
}

const fmt = (n: unknown) => `${Number(n ?? 0).toFixed(2)} AZN`;

async function mailOwner(deps: Deps, t: TenantRecord, subject: string, body: string, opts?: MailOptions) {
  try {
    const owner = await deps.store.findUserById(t.userId);
    if (owner) await deps.mailer.send(owner.email, subject, body, opts);
  } catch (e) { console.warn("[billing] bildiriş göndərilmədi:", e instanceof Error ? e.message : e); }
}

/** AI servisi xəbər verəndə (balans azalıb / bitib) sayt sahibinə yazır. Eyni vəziyyət üçün yalnız bir dəfə gəlir. */
export function notifyBalance(deps: Deps, t: TenantRecord, kind: "low" | "empty", balanceAzn: unknown) {
  const panel = "Panelin “Balans” bölməsindən yükləmə sorğusu göndərə bilərsiniz.";
  if (kind === "low") return mailOwner(deps, t, `Balans azalır: ${t.businessName}`, `Çat balansında ${fmt(balanceAzn)} qalıb. Balans bitəndə çat ziyarətçilərə cavab verməyəcək, əvəzinə əlaqə forması göstəriləcək.\n\n${panel}`, { action: "Balansı artır", preheader: `Balansda ${fmt(balanceAzn)} qalıb` });
  return mailOwner(deps, t, `Balans bitdi: ${t.businessName}`, `Çat balansı bitdi və ziyarətçilərə cavab vermir (əvəzinə əlaqə forması göstərilir). Balans yüklənən kimi çat avtomatik davam edir.\n\n${panel}`, { action: "Balansı artır", preheader: "Çat ziyarətçilərə cavab vermir" });
}

/** Yeni yükləmə sorğusu: adminlərə xəbərdarlıq (Telegram və/və ya e-poçt, admin → Ayarlar). */
export async function notifyTopupRequest(deps: Deps, t: TenantRecord, amountAzn: number, requestId = `${t.tenantId}:${Date.now()}`) {
  await alertTopupRequest(deps, t, amountAzn, requestId);
}

/** Müştəri gündəlik xərc limitinə çatdı: sahibə gündə bir dəfə e-poçt, adminə xəbərdarlıq. */
export async function notifyDailyLimit(deps: Deps, t: TenantRecord) {
  const day = new Date().toISOString().slice(0, 10);
  if (!deps.limiter.hit(`dlimit:${t.tenantId}:${day}`, 1, 24 * 60 * 60_000)) return;
  await mailOwner(deps, t, `Gündəlik limitə çatıldı: ${t.businessName}`, `Çat bu gün üçün təyin olunmuş xərc limitinə çatdı və sabaha qədər ziyarətçilərə cavab vermir (əvəzinə əlaqə forması göstərilir).\n\nQəfil artım gözlənilməzdirsə (məs. bot hücumu), "Sorğular" bölməsinə bax. Limiti dəyişmək üçün dəstəyə yaz.`);
  await alertDailyLimit(deps, t);
}

export const notifyTopupDone = (deps: Deps, t: TenantRecord, amountAzn: number, balanceAzn: unknown) =>
  mailOwner(deps, t, `Balans yükləndi: +${fmt(amountAzn)}`, `Balansınıza vəsait əlavə olundu.\n\nMəbləğ: +${fmt(amountAzn)}\nCari balans: ${fmt(balanceAzn)}\nTarix: ${new Date().toISOString().slice(0, 16).replace("T", " ")} UTC`, { preheader: `Cari balans: ${fmt(balanceAzn)}` });

// ---- Abunə ----
const date = (iso: unknown) => (typeof iso === "string" ? iso.slice(0, 10).split("-").reverse().join(".") : "");
const PLAN_PANEL = "Panelin “Plan və ödəniş” bölməsindən planı yeniləyə, yüksəldə və ya əlavə cavab paketi ala bilərsiniz.";

/** Planın cavab limitinin 80%-i / hamısı işlənib (AI servisi hər dövrdə bir dəfə xəbər verir) */
export function notifyUsage(deps: Deps, t: TenantRecord, kind: "usage80" | "usage100", plan: { used?: number; included?: number } | undefined) {
  const used = Number(plan?.used ?? 0), inc = Number(plan?.included ?? 0);
  if (kind === "usage80") return mailOwner(deps, t, `Cavab limitinin 80%-i işlənib: ${t.businessName}`, `Bu dövr üçün ${inc} cavabdan ${used}-i işlənib. Limit dolanda köməkçi ziyarətçilərə cavab verməyəcək, əvəzinə əlaqə forması göstəriləcək.\n\n${PLAN_PANEL}`, { action: "Planı idarə et", preheader: `${used}/${inc} cavab işlənib` });
  return mailOwner(deps, t, `Cavab limiti doldu: ${t.businessName}`, `Bu dövrün cavab limiti (${inc}) doldu: köməkçi ziyarətçilərə cavab vermir, əvəzinə əlaqə forması göstərilir (müraciətlər itmir). Planı yüksəltsəniz və ya əlavə paket alsanız, köməkçi dərhal davam edir. Limit növbəti dövrdə özü yenilənir.\n\n${PLAN_PANEL}`, { action: "Planı idarə et", preheader: "Köməkçi ziyarətçilərə cavab vermir" });
}

/** Pulsuz sınaq cavabları bitdi (AI servisi bir dəfə xəbər verir) */
export function notifyTrialEnd(deps: Deps, t: TenantRecord) {
  return mailOwner(deps, t, `Pulsuz sınaq bitdi: ${t.businessName}`, `Pulsuz sınaq cavabları bitdi: köməkçi ziyarətçilərə cavab vermir, əvəzinə əlaqə forması göstərilir (müraciətlər itmir). Bilik bazanız və ayarlarınız saxlanılır: plan seçən kimi köməkçi davam edir.\n\n${PLAN_PANEL}`, { action: "Plan seç", preheader: "Köməkçinin işləməsi üçün plan seçin" });
}

/** Abunənin bitməsinə az qalıb / bitib (saatlıq yoxlamadan) */
export function notifyPlanReminder(deps: Deps, t: TenantRecord, r: { kind: string; planName?: string; end?: string; next?: string | null }) {
  if (r.kind === "expiring") return mailOwner(deps, t, `Planın müddəti bitir: ${t.businessName}`, `“${r.planName}” planının müddəti ${date(r.end)} tarixində bitir. Fasilə olmaması üçün vaxtında yeniləyin: yeni dövr köhnəsinin bitdiyi gündən başlayır, heç bir gün itmir.\n\n${PLAN_PANEL}`, { action: "Planı yenilə", preheader: `${date(r.end)} tarixində bitir` });
  return mailOwner(deps, t, `Planın müddəti bitdi: ${t.businessName}`, `“${r.planName}” planının müddəti bitdi və köməkçi ziyarətçilərə cavab vermir (əvəzinə əlaqə forması göstərilir). Bilik bazanız və ayarlarınız saxlanılır: planı yeniləyən kimi köməkçi davam edir.\n\n${PLAN_PANEL}`, { action: "Planı yenilə", preheader: "Köməkçi ziyarətçilərə cavab vermir" });
}

/** Yeni plan/paket sifarişi: adminə xəbər */
export async function notifyOrder(deps: Deps, t: TenantRecord, order: Record<string, unknown>) {
  await alertOrder(deps, t, order);
}

/** Sifariş təsdiqləndi: sahibə e-poçt, imkanlar keşi yenilənir */
export function notifyOrderDone(deps: Deps, t: TenantRecord, out: Record<string, any>) {
  invalidateEntitlements(t.tenantId);
  const r = out.request ?? {};
  const sub = out.subscription ?? {};
  if (r.kind === "pack") return mailOwner(deps, t, `Əlavə paket aktivdir: +${r.replies} cavab`, `Hesabınıza ${r.replies} əlavə cavab əlavə olundu. Planın limiti dolanda köməkçi bu paketdən istifadə edir.\n\nMəbləğ: ${fmt(r.amountAzn)}`, { preheader: `+${r.replies} cavab` });
  return mailOwner(deps, t, `Plan aktivdir: ${sub.planName ?? r.plan}`, `Ödənişiniz təsdiqləndi.\n\nPlan: ${sub.planName ?? r.plan}\nDövr: ${date(sub.start)} – ${date(sub.end)}\nCavab limiti: ${sub.included ?? ""} / ${sub.cycle === "year" ? "hər 30 gün" : "ay"}\nMəbləğ: ${fmt(r.amountAzn)}`, { preheader: `${date(sub.end)} tarixinədək aktivdir` });
}

/** Saatlıq: bitməyə yaxın və bitmiş abunələr üçün sahibə xatırlatma */
export async function sendPlanReminders(deps: Deps) {
  const out = await deps.ai.planReminders();
  for (const r of (out.reminders ?? []) as { tenantId: string; kind: string; planName?: string; end?: string; next?: string | null }[]) {
    const t = await deps.store.findTenantById(r.tenantId).catch(() => null);
    if (t) { invalidateEntitlements(t.tenantId); await notifyPlanReminder(deps, t, r); }
  }
}
