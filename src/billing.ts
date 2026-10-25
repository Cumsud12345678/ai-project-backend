// Balansla bağlı portal köməkçiləri: məbləğin yoxlanması və email bildirişləri (hamısı "best effort": alınmasa əsas əməliyyat pozulmur).
import type { Deps } from "./deps.js";
import { HttpError } from "./http.js";
import type { TenantRecord } from "./store/types.js";

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

export async function notifyTopupRequest(deps: Deps, t: TenantRecord, amountAzn: number) {
  for (const to of deps.config.adminEmails) {
    try { await deps.mailer.send(to, `Balans yükləmə sorğusu: ${t.businessName}`, `${t.businessName} (${t.domain}) ${fmt(amountAzn)} yükləmək istəyir.\n\nÖdəniş alınandan sonra admin panelində sorğunu təsdiqlə.`); }
    catch (e) { console.warn("[billing] admin bildirişi göndərilmədi:", e instanceof Error ? e.message : e); }
  }
}

export const notifyTopupDone = (deps: Deps, t: TenantRecord, amountAzn: number, balanceAzn: unknown) =>
  mailOwner(deps, t, `Balans yükləndi: +${fmt(amountAzn)}`, `Balansınıza ${fmt(amountAzn)} əlavə olundu. Cari balans: ${fmt(balanceAzn)}.`);
