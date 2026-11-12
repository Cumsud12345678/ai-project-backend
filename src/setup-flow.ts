// Quraşdırma sehirbazının axını (addım ardıcıllığı, qaralamalar, təmizlik).
//  - stage: təsdiqlənmiş son addım (1 biznes, 2 biznes növü, 3 məlumat, 4 sınaq, 5 bitdi). Bir addım DƏYİŞƏNDƏ stage həmin addıma
//    enir, ondan sonrakı addımlar yenidən keçilməlidir. stage yoxdursa (köhnə hesablar) əvvəlki qayda işləyir.
//  - drafts: hər biznes növü üçün "Sürətli başlanğıc" formasında yazılanlar. Növü dəyişib geri qayıdanda itmir; sehirbaz bitəndə silinir.
//  - made: sürətli başlanğıcın SON dəfə yaratdıqları (bilik mətnləri, randevu, sifariş forması, xatırlatma). Yenidən işə salınanda
//    köhnələri silinir ki, AI əvvəlki seçimin (məs. randevu) məlumatı ilə cavab verməsin.
import type { Deps } from "./deps.js";
import { HttpError } from "./http.js";
import { BIZ_TYPES, type BizType, type SetupMade, type TenantRecord } from "./store/types.js";

export const stageOf = (t: Pick<TenantRecord, "setup">) => t.setup?.stage;
/** Sınaq tamamdırmı: yeni axında stage ≥ 4, köhnə hesablarda testedAt və ya real sual */
export const testedOf = (t: Pick<TenantRecord, "setup" | "testedAt">, realQuestions = 0) => {
  const s = stageOf(t);
  return s !== undefined ? s >= 4 : Boolean(t.testedAt) || realQuestions > 0;
};

/** Addımı yazır: dəyişiklik olubsa stage həmin addıma enir, olmayıbsa ən azı həmin addım qədər olur */
export async function setStage(deps: Deps, t: TenantRecord, stage: number, changed: boolean): Promise<number> {
  const cur = stageOf(t) ?? 0;
  const next = changed ? stage : Math.max(cur, stage);
  if (next !== cur) await deps.store.updateTenant(t.tenantId, { setup: { goals: t.setup?.goals ?? [], ...t.setup, stage: next, at: t.setup?.at ?? new Date() } });
  return next;
}

const DRAFT_KEYS = ["phone", "whatsapp", "address", "hours", "list", "delivery", "from", "to", "sat", "sun", "capacity", "useBook", "useRem", "useOrder", "useFu"];
export function cleanDraft(v: unknown): Record<string, string | number | boolean> {
  const o = v && typeof v === "object" ? (v as Record<string, unknown>) : {};
  const out: Record<string, string | number | boolean> = {};
  for (const k of DRAFT_KEYS) {
    const x = o[k];
    if (typeof x === "string") out[k] = x.slice(0, 3000);
    else if (typeof x === "boolean") out[k] = x;
    else if (typeof x === "number" && Number.isFinite(x)) out[k] = Math.max(0, Math.min(1000, Math.round(x)));
  }
  return out;
}
export const bizTypeOf = (v: unknown): BizType => {
  if (!BIZ_TYPES.includes(v as BizType)) throw new HttpError(400, "Biznes növü düzgün deyil");
  return v as BizType;
};

export function cleanMade(v: unknown, type: BizType): SetupMade {
  const o = v && typeof v === "object" ? (v as Record<string, unknown>) : {};
  const ids = Array.isArray(o.kbSources) ? o.kbSources.filter((x): x is string => typeof x === "string" && /^[\w-]{1,64}$/.test(x)).slice(0, 10) : [];
  return { type, kbSources: ids, booking: o.booking === true, orderForm: o.orderForm === true, followup: o.followup === true, at: new Date() };
}

/** Sürətli başlanğıcın əvvəlki dəfə yaratdıqlarını silir (sahibin öz qurduqlarına toxunmur) */
export async function undoMade(deps: Deps, t: TenantRecord): Promise<void> {
  const m = t.setup?.made;
  if (!m) return;
  for (const id of m.kbSources) await deps.ai.kbDelete(t.tenantId, id).catch(() => {});
  if (m.booking) await deps.ai.deleteBooking(t.tenantId).catch(() => {});
  if (m.orderForm) await deps.ai.deleteOrderForm(t.tenantId).catch(() => {});
  if (m.followup && t.followup?.enabled) await deps.store.updateTenant(t.tenantId, { followup: { ...t.followup, enabled: false } });
  const { made: _m, ...rest } = t.setup!;
  await deps.store.updateTenant(t.tenantId, { setup: rest });
}

/** Sehirbaz bitdi: qaralamalar silinir; kataloq seçilməyibsə köməkçi kataloqdan axtarmır (yalnız bilik bazası) */
export async function finalizeSetup(deps: Deps, t: TenantRecord): Promise<void> {
  // Növ sonradan dəyişib, yeni növ üçün sürətli başlanğıc işlədilməyibsə köhnə növün yaratdıqları qalmasın
  if (t.setup?.made && t.setup.bizType && t.setup.made.type !== t.setup.bizType) { await undoMade(deps, t); t = (await deps.store.findTenantById(t.tenantId)) ?? t; }
  const goals = t.setup?.goals ?? [];
  const mode = (t.config as { profile?: { mode?: string } } | undefined)?.profile?.mode;
  if (goals.length && !goals.includes("catalog") && mode && mode !== "support") {
    try {
      const r = await deps.ai.patchProfile(t.tenantId, { mode: "support" });
      await deps.store.updateTenant(t.tenantId, { config: { ...t.config, profile: (r as { profile?: object }).profile ?? { ...(t.config as { profile?: object }).profile, mode: "support" } } });
    } catch (e) { console.warn("[setup] rejim dəyişmədi:", e instanceof Error ? e.message : e); }
  }
  const fresh = (await deps.store.findTenantById(t.tenantId)) ?? t;
  const { drafts: _d, ...rest } = fresh.setup ?? { goals, at: new Date() };
  await deps.store.updateTenant(t.tenantId, { setup: { ...rest, stage: 5 } });
}
