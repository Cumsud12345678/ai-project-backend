// Partnyor proqramı.
//
// Qaydalar:
//  - Partnyoru yalnız admin təyin edir (kod + faiz). Hələlik pul çıxarılmır: partnyor balansını yalnız görür, admin özü ödəyib
//    balansdan "ödənildi" kimi çıxır.
//  - Komissiya müştərinin REAL ödənişlərindən hesablanır: təsdiqlənmiş yükləmə sorğusu və ya ödəniş şlüzü (AI servisində
//    ledger ID-si "req:" / "pay:" ilə başlayan qeydlər). Pulsuz aylıq balans, bonus, admin hədiyyəsi və istifadə sayılmır:
//    bonus puldan komissiya yaranmır.
//  - Pəncərə: müştəri partnyora bağlanandan sonrakı `months` ay (defolt 12).
//  - Yeni müştəri (link və ya kodla qeydiyyat) ilk real ödənişində +bonusPct% balans alır (ən çox bonusCapAzn). Bonus
//    "manual" növlü qeyddir: ondan komissiya yaranmır. Admin sonradan bağladığı müştəriyə bonus verilmir.
//  - Komissiyalar dövri sinxronla yazılır (AI servisindəki ödənişlər oxunur). Hər ödəniş bir dəfə: sourceRef unikaldır.
import type { Deps } from "./deps.js";
import { HttpError } from "./http.js";
import type { PartnerInfo, ReferralInfo, User } from "./store/types.js";

// defaultRate: partnyorun faizi (müştərinin hər plan/paket ödənişindən); bonusReplies: kodla gələn müştəriyə ilk ödənişdən sonra
// bir dəfə verilən əlavə cavab sayı (0 = bonus yoxdur); months: komissiyanın neçə ay yazıldığı
export type PartnerSettings = { defaultRate: number; bonusReplies: number; months: number };
export const DEFAULT_PARTNER_SETTINGS: PartnerSettings = { defaultRate: 10, bonusReplies: 200, months: 12 };
const KEY = "partner_program";
const CODE_RE = /^[A-Z0-9_-]{3,20}$/;

export const normalizeCode = (v: unknown) => (typeof v === "string" ? v.trim().toUpperCase() : "");
export const validCode = (c: string) => CODE_RE.test(c);
const round2 = (n: number) => Math.round(n * 100) / 100;
const clamp = (n: unknown, lo: number, hi: number, d: number) => { const x = Number(n); return Number.isFinite(x) ? Math.min(hi, Math.max(lo, x)) : d; };

export function normalizeSettings(v: unknown): PartnerSettings {
  const o = (v ?? {}) as Partial<PartnerSettings>;
  return {
    defaultRate: round2(clamp(o.defaultRate, 1, 50, DEFAULT_PARTNER_SETTINGS.defaultRate)),
    bonusReplies: Math.round(clamp(o.bonusReplies, 0, 5000, DEFAULT_PARTNER_SETTINGS.bonusReplies)),
    months: Math.round(clamp(o.months, 1, 60, DEFAULT_PARTNER_SETTINGS.months)),
  };
}
export const getPartnerSettings = async (deps: Deps) => normalizeSettings(await deps.store.getSetting(KEY));
export async function savePartnerSettings(deps: Deps, patch: unknown) {
  const next = normalizeSettings({ ...(await getPartnerSettings(deps)), ...(patch as object) });
  await deps.store.setSetting(KEY, next);
  return next;
}

export function validRate(v: unknown): number {
  const n = Number(v);
  if (!Number.isFinite(n) || n < 1 || n > 50) throw new HttpError(400, "Faiz 1 ilə 50 arasında olmalıdır", "BAD_RATE");
  return round2(n);
}

/** Partnyor ilə bağlanma pəncərəsinin sonu */
export const windowEnd = (r: ReferralInfo, months: number) => { const d = new Date(r.at); d.setUTCMonth(d.getUTCMonth() + months); return d; };

/**
 * Qeydiyyatda müştərini partnyora bağlayır. Kod tapılmasa: source=code olanda xəta (istifadəçi özü yazıb), link olanda səssizcə
 * keçir (köhnə link). Müştəri artıq bağlıdırsa dəyişmir. Partnyor özünü dəvət edə bilməz.
 */
export async function attachOnSignup(deps: Deps, user: User, rawCode: unknown, source: "link" | "code") {
  const code = normalizeCode(rawCode);
  if (!code || user.referredBy) return;
  const partner = validCode(code) ? await deps.store.findUserByPartnerCode(code) : null;
  if (!partner?.partner?.active || partner.id === user.id || partner.email === user.email) {
    if (source === "code") throw new HttpError(400, "Promo kod tapılmadı", "BAD_REF_CODE");
    return;
  }
  await deps.store.updateUser(user.id, { referredBy: { partnerId: partner.id, code, at: new Date(), source, bonusAt: null } });
}

type LedgerEntry = { id: string; at: string; amountAzn: number };

async function paymentsOf(deps: Deps, tenantId: string, since: Date, until: Date): Promise<LedgerEntry[]> {
  const out: LedgerEntry[] = [];
  let before: string | undefined;
  for (let page = 0; page < 20; page++) {
    const r = await deps.ai.billingLedger({ tenantId, kind: "payment", since: since.toISOString(), until: until.toISOString(), limit: "200", ...(before && { before }) });
    out.push(...((r.entries ?? []) as LedgerEntry[]));
    if (!r.nextBefore) break;
    before = String(r.nextBefore);
  }
  return out.filter((e) => e.amountAzn > 0);
}

/**
 * Komissiya və bonusları yazır. partnerId verilibsə yalnız onun müştəriləri. Təkrar çağırmaq təhlükəsizdir.
 * Qaytarır: yeni yazılan komissiya sayı və verilən bonus sayı.
 */
export async function syncPartners(deps: Deps, opts: { partnerId?: string } = {}) {
  const { store } = deps;
  const settings = await getPartnerSettings(deps);
  const customers = await store.listReferred(opts.partnerId);
  if (!customers.length) return { commissions: 0, bonuses: 0 };
  const partnerIds = [...new Set(customers.map((c) => c.referredBy!.partnerId))];
  const partners = new Map((await store.findUsersByIds(partnerIds)).map((u) => [u.id, u]));
  const tenants = new Map((await store.findTenantsByUserIds(customers.map((c) => c.id))).map((t) => [t.userId, t]));
  let commissions = 0, bonuses = 0;

  for (const c of customers) {
    const ref = c.referredBy!;
    const partner = partners.get(ref.partnerId);
    const tenant = tenants.get(c.id);
    if (!tenant || !partner?.partner) continue;
    const until = windowEnd(ref, settings.months);
    let pays: LedgerEntry[];
    try { pays = await paymentsOf(deps, tenant.tenantId, new Date(ref.at), until); }
    catch (e) { console.warn(`[partners] ${tenant.tenantId} ödənişləri oxunmadı:`, e instanceof Error ? e.message : e); continue; }

    // Yeni müştəri bonusu: ilk real ödənişdən (plan alanda) sonra bir dəfə əlavə cavablar
    if (pays.length && ref.source !== "admin" && !ref.bonusAt && settings.bonusReplies > 0) {
      try {
        await deps.ai.billingBonusReplies(tenant.tenantId, { replies: settings.bonusReplies, ref: `partner:${c.id}`, note: `Partnyor kodu: ${ref.code}`, by: "system" });
        await store.updateUser(c.id, { referredBy: { ...ref, bonusAt: new Date() } });
        bonuses++;
      } catch (e) { console.warn(`[partners] bonus verilmədi (${tenant.tenantId}):`, e instanceof Error ? e.message : e); }
    }

    // Söndürülmüş partnyora yeni komissiya yazılmır (yenidən açılanda pəncərə daxilindəki ödənişlər yazılır)
    if (!partner.partner.active || partner.id === c.id) continue;
    for (const p of pays) {
      const amount = round2((p.amountAzn * partner.partner.rate) / 100);
      if (amount < 0.01) continue;
      const fresh = await store.addPartnerEntry({
        partnerId: partner.id, kind: "commission", amountAzn: amount, at: new Date(p.at), sourceRef: `c:${p.id}`,
        tenantId: tenant.tenantId, customerId: c.id, baseAzn: p.amountAzn, rate: partner.partner.rate, note: tenant.businessName,
      });
      if (fresh) {
        commissions++;
        // Partnyora xəbər: qazancı paneldə dərhal görünür
        void deps.mailer.send(partner.email, `Yeni qazanc: +${amount.toFixed(2)} AZN`, `${tenant.businessName} ${p.amountAzn.toFixed(2)} AZN ödədi. Sənin payın (${partner.partner.rate}%): +${amount.toFixed(2)} AZN.\n\nQazancın və ödənişlərin “Partnyor” səhifəsindədir.`, { action: "Partnyor səhifəsi", preheader: `+${amount.toFixed(2)} AZN komissiya` }).catch(() => {});
      }
    }
  }
  return { commissions, bonuses };
}

// Eyni anda iki sinxron işləməsin; səhifə açılanda tez-tez çağırılmasın
let running: Promise<unknown> | null = null;
const lastRun = new Map<string, number>();
export async function syncThrottled(deps: Deps, partnerId?: string, minGapMs = 30_000) {
  const key = partnerId ?? "*";
  if (Date.now() - (lastRun.get(key) ?? 0) < minGapMs) return;
  if (running) { await running.catch(() => {}); return; }
  lastRun.set(key, Date.now());
  running = syncPartners(deps, { partnerId }).catch((e) => console.warn("[partners] sinxron:", e instanceof Error ? e.message : e)).finally(() => { running = null; });
  await running;
}
export const resetPartnerSync = () => { lastRun.clear(); running = null; };

export function startPartnerScheduler(deps: Deps, everyMs = 10 * 60_000) {
  const t = setInterval(() => { void syncThrottled(deps, undefined, 0); }, everyMs);
  t.unref?.();
  return () => clearInterval(t);
}

/** Partnyorun bağladığı müştərilərin xülasəsi (partnyor və admin səhifələri üçün) */
export async function partnerCustomers(deps: Deps, partnerId: string, { revealEmail }: { revealEmail: boolean }) {
  const settings = await getPartnerSettings(deps);
  const [customers, byCustomer] = await Promise.all([deps.store.listReferred(partnerId), deps.store.partnerTotalsByCustomer(partnerId)]);
  const tenants = new Map((await deps.store.findTenantsByUserIds(customers.map((c) => c.id))).map((t) => [t.userId, t]));
  const mask = (e: string) => { const [u, d] = e.split("@"); return `${u!.slice(0, 2)}***@${d}`; };
  return customers.map((c) => {
    const t = tenants.get(c.id);
    const r = c.referredBy!;
    const end = windowEnd(r, settings.months);
    return {
      id: c.id, email: revealEmail ? c.email : mask(c.email), joinedAt: r.at, source: r.source, until: end, active: end.getTime() > Date.now(),
      site: t ? { businessName: t.businessName, domain: t.domain, tenantId: revealEmail ? t.tenantId : undefined } : null,
      paidAzn: byCustomer[c.id]?.base ?? 0, earnedAzn: byCustomer[c.id]?.earned ?? 0, bonus: Boolean(r.bonusAt),
    };
  });
}

export const publicPartner = (p: PartnerInfo) => ({ code: p.code, rate: p.rate, active: p.active, since: p.since });
