// Operator cavablarından öyrənmə (portal): canlı söhbət bağlananda operatorun cavabları varsa AI servisi
// başqa müştərilərə də yarayan sual-cavab təklifləri çıxarır. Sahib "Bilik bazası → Təkliflər"də təsdiqləyir və ya rədd edir.
import type { Deps } from "./deps.js";
import type { LiveChat, TenantRecord } from "./store/types.js";

export async function learnFromLive(deps: Deps, t: TenantRecord, chat: LiveChat): Promise<void> {
  const messages = chat.messages.filter((m) => (m.from === "visitor" || m.from === "operator") && m.text && m.text !== "📷").slice(-80).map((m) => ({ from: m.from as "visitor" | "operator", text: m.text.slice(0, 600) }));
  if (!messages.some((m) => m.from === "operator" && m.text.trim().length >= 10) || !messages.some((m) => m.from === "visitor")) return;
  if (!deps.limiter.hit(`learn:${t.tenantId}`, 100, 24 * 60 * 60_000)) return;
  try { await deps.ai.kbLearn(t.tenantId, { messages, chatId: chat.id }); }
  catch (e) { console.warn("[learn] təklif hazırlanmadı:", e instanceof Error ? e.message : e); } // balans yoxdursa və s.: söhbətin bağlanmasına təsir etmir
}
