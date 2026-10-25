// Hesabı və ona bağlı hər şeyi silir (admin başqasını silir və ya istifadəçi özünü silir).
import { AiError } from "./ai.js";
import type { Deps } from "./deps.js";
import type { User } from "./store/types.js";

export async function deleteAccount(deps: Deps, user: User): Promise<{ hadTenant: boolean }> {
  const { store, ai } = deps;
  const tenant = await store.findTenantByUser(user.id);
  if (tenant) {
    // Əvvəlcə AI servisində: orada silinməsə, burada silsək müştəri "yetim" qalar və açarı işləməyə davam edər.
    try { await ai.deleteTenant(tenant.tenantId); }
    catch (e) { if (!(e instanceof AiError && e.status === 404)) throw e; } // artıq silinibsə problem deyil
    await store.deleteTenant(tenant.tenantId);
  }
  await store.deleteSessionsForUser(user.id);
  await store.deleteCodesForEmail(user.email);
  await store.deleteUser(user.id);
  return { hadTenant: Boolean(tenant) };
}
