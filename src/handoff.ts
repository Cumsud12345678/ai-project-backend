// Ağıllı operator çağırışı (portal tərəfi): sahibin qaydaları, səbəb etiketləri və iş saatından kənar davranış.
// Qərarı AI verir (səbəbi ilə: istədi / kömək edə bilmədi / narazıdır / almağa hazırdır), "ardıcıl 2 cavabsız sual" qaydasını portal özü sayır.
// Canlı operator işləyirsə söhbət canlı qutuya düşür (etiket + AI qeydi + səbəbli bildiriş). İşləmirsə müştəriyə "operator yazacaq" deyilir
// və müraciət yaranır: narazı və almağa hazır müştəri YÜKSƏK prioritetlə.
import type { Deps } from "./deps.js";
import { HttpError } from "./http.js";
import type { HandoffSettings, TenantRecord } from "./store/types.js";

// "limit": portal özü ötürür (botun limiti doldu), AI bu səbəbi seçə bilməz
export const HANDOFF_REASONS = ["asked", "cant_help", "upset", "ready_to_buy", "misses", "limit"] as const;
export type HandoffReason = (typeof HANDOFF_REASONS)[number];
export const DEFAULT_HANDOFF: HandoffSettings = { cantHelp: true, upset: true, ready: true, misses: true };

export const handoffOf = (t: Pick<TenantRecord, "handoff">): HandoffSettings => ({ ...DEFAULT_HANDOFF, ...(t.handoff ?? {}) });
/** AI servisinə gedən qaydalar ("ardıcıl cavabsız" portalın öz qaydasıdır) */
export const aiRules = (t: Pick<TenantRecord, "handoff">) => { const h = handoffOf(t); return { cantHelp: h.cantHelp, upset: h.upset, ready: h.ready }; };

export function parseHandoff(body: unknown): HandoffSettings {
  const b = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
  const out = { ...DEFAULT_HANDOFF };
  for (const k of ["cantHelp", "upset", "ready", "misses"] as const) {
    if (b[k] === undefined) continue;
    if (typeof b[k] !== "boolean") throw new HttpError(400, `${k} true/false olmalıdır`);
    out[k] = b[k] as boolean;
  }
  return out;
}

export const cleanReason = (v: unknown): HandoffReason => v !== "limit" && (HANDOFF_REASONS as readonly string[]).includes(v as string) ? (v as HandoffReason) : "asked";
const clip = (v: unknown, n: number) => (typeof v === "string" ? v.replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, n) : "");

/** Canlı söhbətdə görünən etiket (asked: etiket yoxdur) */
export const REASON_TAG: Record<HandoffReason, string | null> = { asked: null, cant_help: "AI cavab tapmadı", misses: "AI cavab tapmadı", upset: "Narazı", ready_to_buy: "Almağa hazır", limit: "Bot limiti doldu" };
/** Operator bildirişinin başlığı */
export const REASON_LABEL: Record<HandoffReason, string> = { asked: "🙋 Operator istəyir", cant_help: "🤖 AI kömək edə bilmədi", misses: "🤖 Ardıcıl cavabsız suallar", upset: "😠 Narazı müştəri", ready_to_buy: "🔥 Almağa hazırdır", limit: "⏳ Botun limiti doldu, operator cavab versin" };
export const urgent = (r: HandoffReason) => r === "upset" || r === "ready_to_buy";

/** Canlı söhbətə yazılacaq etiketlər və AI qeydi */
export function liveExtras(reason: HandoffReason, note?: string) {
  const tag = REASON_TAG[reason];
  const n = clip(note, 200);
  return { tags: tag ? [tag] : [], notes: n || reason !== "asked" ? [{ text: `${REASON_LABEL[reason]}${n ? `: ${n}` : ""}`, by: "AI", at: new Date() }] : [] };
}

/**
 * İş saatından kənar (və ya canlı operator söndürülüb) ötürmə: müraciət yaradır. Narazı və almağa hazır: yüksək prioritet.
 * Qaytarır: müraciət yaradıldımı (əlaqə məlumatı yoxdursa false: çağıran tərəf əlaqə istəyir).
 */
export async function offlineLead(deps: Deps, t: TenantRecord, p: { reason: HandoffReason; note?: string; name: string; contact: string; question: string; conversation: { role: string; text: string }[] }): Promise<boolean> {
  if (!p.contact) return false;
  const question = `${REASON_LABEL[p.reason]}${p.note ? ` · ${clip(p.note, 200)}` : ""}${p.question ? ` — ${p.question}` : ""}`.slice(0, 500);
  const r = await deps.ai.kbAddLead(t.tenantId, { name: p.name, contact: p.contact, question, conversation: p.conversation.slice(-10) });
  const id = (r as { lead?: { id?: string } }).lead?.id;
  if (id && urgent(p.reason)) await deps.ai.kbUpdateLead(t.tenantId, id, { priority: "high", by: "AI" }).catch(() => {});
  return true;
}
