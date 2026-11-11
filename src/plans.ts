// Abunə planının imkanları (AI servisi hesablayır): portal funksiyaları buna görə açılır/bağlanır.
// Hər müştəri üçün 60 saniyə yaddaşda saxlanır. Sinxron yoxlamalar (məs. liveOpenNow) keşdən oxuyur; əsas axınlar
// (vidjet ayarı, çat, kanal mesajı) əvvəlcə loadEntitlements çağırıb keşi təzələyir.
// AI servisi cavab verməsə imkanlar açıq sayılır (ödəniş edən müştərinin funksiyası qəfil bağlanmasın).
import type { Deps } from "./deps.js";

export const FEATURE_KEYS = ["channels", "live", "automations", "campaigns", "actions", "customerData", "noBranding"] as const;
export type FeatureKey = (typeof FEATURE_KEYS)[number];
export type Entitlements = { source: "plan" | "trial" | "none"; plan: string | null; features: Record<FeatureKey, boolean>; seats: number };

const TTL = 60_000;
const FAIL_TTL = 10_000;
const OPEN: Entitlements = { source: "trial", plan: null, features: Object.fromEntries(FEATURE_KEYS.map((k) => [k, true])) as Record<FeatureKey, boolean>, seats: 3 };
const cache = new Map<string, { at: number; ttl: number; v: Entitlements }>();

function normalize(r: Record<string, unknown> | null | undefined): Entitlements {
  const f = (r?.features ?? {}) as Record<string, unknown>;
  return {
    source: r?.source === "plan" || r?.source === "none" ? r.source : "trial",
    plan: typeof r?.plan === "string" ? r.plan : null,
    features: Object.fromEntries(FEATURE_KEYS.map((k) => [k, f[k] !== false])) as Record<FeatureKey, boolean>,
    seats: Number.isFinite(Number(r?.seats)) ? Math.max(1, Math.round(Number(r!.seats))) : OPEN.seats,
  };
}

export async function loadEntitlements(deps: Pick<Deps, "ai">, tenantId: string): Promise<Entitlements> {
  const c = cache.get(tenantId);
  if (c && Date.now() - c.at < c.ttl) return c.v;
  try {
    const v = normalize(await deps.ai.entitlements(tenantId));
    cache.set(tenantId, { at: Date.now(), ttl: TTL, v });
    return v;
  } catch {
    const v = c?.v ?? OPEN;
    cache.set(tenantId, { at: Date.now(), ttl: FAIL_TTL, v });
    return v;
  }
  finally { if (cache.size > 5000) cache.delete(cache.keys().next().value!); }
}

/** Keşdən sinxron yoxlama (hələ yüklənməyibsə açıq) */
export const hasFeature = (tenantId: string, key: FeatureKey) => cache.get(tenantId)?.v.features[key] ?? true;

/** Plan dəyişəndə (təsdiq, admin) dərhal yenilənsin */
export const invalidateEntitlements = (tenantId?: string) => { if (tenantId) cache.delete(tenantId); else cache.clear(); };
