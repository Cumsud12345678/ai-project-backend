// Yeni müştərinin (tenant) yaradılması: əvvəl AI servisində, sonra portal bazasında. Panelin "Qoş" düyməsi və adminin
// "qurulum sorğusundan bot yarat" əməliyyatı eyni yolu işlədir (sınaq qaydası, yetim müştərinin silinməsi, vidjet).
import type { AiResult } from "./ai.js";
import type { Deps } from "./deps.js";
import { HttpError } from "./http.js";
import { DuplicateError, type User } from "./store/types.js";
import { markTrialUsed, trialUsed } from "./trial.js";
import { defaultWidget } from "./widget.js";

/** Bazada saxlanan nüsxədə sirr olmur. */
export function withoutSecrets(cfg: Record<string, unknown>): Record<string, unknown> {
  const { apiSecret: _drop, feedText: _feed, ...rest } = cfg; // yüklənmiş fayl portalda saxlanmır (AI servisindədir)
  const source = rest.source as { auth?: Record<string, unknown> } | undefined;
  if (source?.auth) {
    const { value: _v, secret: _s, valueEnv: _e, encryptedValue: _x, ...auth } = source.auth;
    rest.source = { ...source, auth };
  }
  return rest;
}

/** cfg artıq yoxlanılıb (tanınan sahələr). Qaytarır: AI servisinin cavabı (apiKey bir dəfə). */
export async function createTenantFor(deps: Deps, user: User, cfg: Record<string, unknown>): Promise<AiResult> {
  const { store, ai } = deps;
  // Bu e-poçt əvvəl sınaqdan istifadə edibsə (hesabı silib yenidən açıb) yeni müştəriyə pulsuz sınaq verilmir
  const noTrial = await trialUsed(store, user.email);
  const created = await ai.createTenant({ ...cfg, ...(noTrial && { noTrial: true }) });
  const now = new Date();
  try {
    await store.createTenant({
      userId: user.id, tenantId: String(created.tenantId), businessName: String(cfg.businessName).trim(), domain: String(cfg.domain).trim(),
      config: withoutSecrets(cfg), createdAt: now, updatedAt: now,
      widget: defaultWidget({ businessName: String(cfg.businessName).trim(), config: cfg }),
    });
  } catch (e) {
    // AI servisində yaradılan müştəri "yetim" qalmasın (açarı heç kimdə yoxdur, amma pulsuz balans alıb)
    await ai.deleteTenant(String(created.tenantId)).catch((err) => console.error(`[tenant] yetim müştəri ${created.tenantId} silinə bilmədi`, err));
    if (e instanceof DuplicateError) throw new HttpError(409, "Artıq aktiv mənbən var", "TENANT_EXISTS");
    console.error(`[tenant] AI servisində ${created.tenantId} yaradıldı, amma bazaya yazıla bilmədi (silindi)`, e);
    throw e;
  }
  await markTrialUsed(store, user.email).catch((err) => console.warn("[trial] qeyd yazılmadı:", err instanceof Error ? err.message : err));
  return created;
}
