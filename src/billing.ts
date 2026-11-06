// Balansla bağlı portal köməkçiləri: məbləğin yoxlanması və email bildirişləri (hamısı "best effort": alınmasa əsas əməliyyat pozulmur).
import type { Deps } from "./deps.js";
import { HttpError } from "./http.js";
import type { TenantRecord } from "./store/types.js";
import { alertDailyLimit, alertTopupRequest } from "./alerts.js";

export function parseAmount(v: unknown, { allowNegative = false } = {}): number {
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v.replace(",", ".")) : NaN;
  if (!Number.isFinite(n) || n === 0 || (!allowNegative && n < 0) || Math.abs(n) > 100_000) throw new HttpError(400, "Məbləğ düzgün deyil", "BAD_AMOUNT");
  return Math.round(n * 100) / 100;
}

const fmt = (n: unknown) => `${Number(n ?? 0).toFixed(2)} AZN`;

async function mailOwner(deps: Deps, t: TenantRecord, subject: string, body: string) {
  try {
    const owner = await deps.store.findUserById(t.userId);
    if (owner) await deps.mailer.send(owner.email, subject, body);
  } catch (e) { console.warn("[billing] bildiriş göndərilmədi:", e instanceof Error ? e.message : e); }
}

/** AI servisi xəbər verəndə (balans azalıb / bitib) sayt sahibinə yazır. Eyni vəziyyət üçün yalnız bir dəfə gəlir. */
export function notifyBalance(deps: Deps, t: TenantRecord, kind: "low" | "empty", balanceAzn: unknown) {
  const panel = "Panelin “Balans” bölməsindən yükləmə sorğusu göndərə bilərsiniz.";
  if (kind === "low") return mailOwner(deps, t, `Balans azalır: ${t.businessName}`, `Çat balansında ${fmt(balanceAzn)} qalıb. Balans bitəndə çat ziyarətçilərə cavab verməyəcək, əvəzinə əlaqə forması göstəriləcək.\n\n${panel}`);
  return mailOwner(deps, t, `Balans bitdi: ${t.businessName}`, `Çat balansı bitdi və ziyarətçilərə cavab vermir (əvəzinə əlaqə forması göstərilir). Balans yüklənən kimi çat avtomatik davam edir.\n\n${panel}`);
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
  mailOwner(deps, t, `Balans yükləndi: +${fmt(amountAzn)}`, `Balansınıza ${fmt(amountAzn)} əlavə olundu. Cari balans: ${fmt(balanceAzn)}.`);
