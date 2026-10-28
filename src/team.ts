// Operator komandası: sahib işçilərini e-poçtla dəvət edir; işçi qeydiyyatdan keçib (və ya girib) yalnız canlı söhbət qutusunu görür.
import type { Deps } from "./deps.js";
import type { Store, TenantRecord, User } from "./store/types.js";

export const MAX_TEAM = 5;
export const nameOf = (u: { email: string }) => u.email.split("@")[0]!.slice(0, 40);
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
export const validEmail = (e: string) => e.length <= 120 && EMAIL.test(e);

/** İstifadəçi komanda üzvüdürsə onun hesabını qaytarır; e-poçtla dəvət olunub hələ bağlanmayıbsa bağlayır. */
export async function memberTenant(store: Store, user: User): Promise<TenantRecord | null> {
  const linked = await store.findTenantByMember(user.id);
  if (linked) return linked;
  const invited = await store.findTenantByTeamEmail(user.email.toLowerCase());
  if (!invited) return null;
  const team = (invited.team ?? []).map((m) => (m.email === user.email.toLowerCase() && !m.userId ? { ...m, userId: user.id } : m));
  await store.updateTenant(invited.tenantId, { team });
  return { ...invited, team };
}

/** Sahib (öz hesabı) və ya operator (komanda üzvü). */
export async function tenantFor(store: Store, user: User): Promise<{ tenant: TenantRecord; role: "owner" | "operator" } | null> {
  const own = await store.findTenantByUser(user.id);
  if (own) return { tenant: own, role: "owner" };
  const m = await memberTenant(store, user);
  return m ? { tenant: m, role: "operator" } : null;
}

/** Yeni canlı söhbət barədə sahibə və komandaya e-poçt (10 dəqiqədə bir, spam olmasın). */
export async function notifyTeam(deps: Deps, t: TenantRecord, subject: string, text: string): Promise<void> {
  if (!deps.limiter.hit(`live:mail:${t.tenantId}`, 1, 10 * 60_000)) return;
  try {
    const owner = await deps.store.findUserById(t.userId);
    const to = [...new Set([owner?.email, ...(t.team ?? []).map((m) => m.email)].filter((x): x is string => Boolean(x)))];
    for (const addr of to) await deps.mailer.send(addr, subject, text).catch(() => {});
  } catch (e) { console.warn("[live] bildiriş göndərilmədi:", e instanceof Error ? e.message : e); }
}
