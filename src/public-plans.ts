// Saytın qiymət bölməsi üçün plan kataloqu (girişsiz). 5 dəqiqə yaddaşda saxlanır; admin dəyişəndə sıfırlanır.
import type { Deps } from "./deps.js";

export const publicPlans: { at: number; value: Record<string, unknown> | null } = { at: 0, value: null };

export async function getPublicPlans(deps: Pick<Deps, "ai">) {
  if (publicPlans.value && Date.now() - publicPlans.at < 5 * 60_000) return publicPlans.value;
  try {
    const c = await deps.ai.billingPlans();
    publicPlans.value = { plans: c.plans ?? [], packs: c.packs ?? [] };
    publicPlans.at = Date.now();
  } catch (e) { if (!publicPlans.value) throw e; } // köhnə dəyər varsa onu qaytar
  return publicPlans.value;
}
