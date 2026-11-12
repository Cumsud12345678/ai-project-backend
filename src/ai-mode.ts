// Kanal üzrə AI rejimi (Telegram/WhatsApp): sahib AI-a hələ tam güvənmirsə.
//  - auto:  AI özü cavab verir (defolt).
//  - draft: AI müştəriyə yazmır. Söhbət canlı qutuya düşür və hər yeni mesaja AI cavab qaralaması hazırlayır,
//           operator onu bir kliklə (və ya düzəldib) göndərir.
//  - off:   AI söndürülüb, söhbət yalnız operatorla gedir.
import type { Deps } from "./deps.js";
import { HttpError } from "./http.js";
import { hub } from "./hub.js";
import type { AiMode, TenantRecord } from "./store/types.js";

export const AI_MODES: AiMode[] = ["auto", "draft", "off"];
export const aiModeOf = (t: Pick<TenantRecord, "aiMode">, ch: "telegram" | "whatsapp"): AiMode => t.aiMode?.[ch] ?? "auto";
export const aiModesView = (t: Pick<TenantRecord, "aiMode">) => ({ telegram: aiModeOf(t, "telegram"), whatsapp: aiModeOf(t, "whatsapp") });

export function parseAiMode(body: unknown): { telegram: AiMode; whatsapp: AiMode } {
  const b = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
  const out = { telegram: "auto" as AiMode, whatsapp: "auto" as AiMode };
  for (const k of ["telegram", "whatsapp"] as const) {
    if (b[k] === undefined) continue;
    if (!AI_MODES.includes(b[k] as AiMode)) throw new HttpError(400, `${k}: auto, draft və ya off olmalıdır`);
    out[k] = b[k] as AiMode;
  }
  return out;
}

/** Ziyarətçinin son mesajına AI qaralaması: canlı söhbətdə saxlanır, panel dərhal yenilənir. Alınmasa susur (operator özü yazır). */
export async function prepareDraft(deps: Deps, t: TenantRecord, liveId: string): Promise<void> {
  if (!deps.limiter.hit(`aidraft:${t.tenantId}:${liveId}`, 30, 10 * 60_000) || !deps.limiter.hit(`aidraft:${t.tenantId}`, 600, 60 * 60_000)) return;
  try {
    const chat = await deps.store.getLive(t.tenantId, liveId);
    if (!chat || chat.status !== "open" || chat.messages.at(-1)?.from !== "visitor") return;
    const out = await deps.ai.draft(t.tenantId, {
      messages: chat.messages.filter((m) => m.from !== "system").slice(-12).map((m) => ({ from: m.from, text: m.text.slice(0, 600) })),
      context: chat.context.slice(-6).map((m) => ({ role: m.role, text: m.text.slice(0, 400) })),
    });
    const text = String(out.draft ?? "").trim().slice(0, 1000);
    if (!text) return;
    // Qaralama hazırlananda yeni mesaj gəlibsə: köhnə qaralama yazılmır (növbəti çağırış yenisini hazırlayır)
    const now = await deps.store.getLive(t.tenantId, liveId);
    if (!now || now.messages.length !== chat.messages.length) return;
    await deps.store.pushLive(t.tenantId, liveId, null, { aiDraft: { text, at: new Date() } });
    hub.toOperators(t.tenantId, { t: "live", id: liveId, kind: "message" });
  } catch (e) { console.warn("[ai-mode] qaralama hazırlanmadı:", e instanceof Error ? e.message : e); }
}
