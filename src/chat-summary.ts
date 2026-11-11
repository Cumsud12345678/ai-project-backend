// Söhbətin AI xülasəsi: canlı söhbət (operator qutusu) və AI söhbəti (sorğu jurnalı) üçün.
// Xərc balansdan çıxılır, ona görə nəticə saxlanır: canlı söhbətdə söhbətin özündə, AI söhbətində yaddaşda (keş).
// Yeni mesaj gəlməyibsə təkrar açılış pulsuzdur; operator "yenilə" basanda və ya mesaj sayı dəyişəndə yenidən hazırlanır.
import { AiError } from "./ai.js";
import type { Deps } from "./deps.js";
import { HttpError } from "./http.js";
import type { ChatSummary, LiveChat } from "./store/types.js";

const MOODS = ["positive", "neutral", "negative"] as const;
const TEMPS = ["hot", "warm", "cold"] as const;
const str = (v: unknown, n: number) => (typeof v === "string" ? v.replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, n) : "");

/** AI servisinin cavabını yoxlayır (etibarsızdırsa null) */
export function cleanSummary(v: unknown): ChatSummary | null {
  if (!v || typeof v !== "object") return null;
  const o = v as Record<string, unknown>;
  const summary = str(o.summary, 400);
  if (!summary) return null;
  return {
    summary, intent: str(o.intent, 120), nextStep: str(o.nextStep, 200),
    mood: (MOODS as readonly string[]).includes(o.mood as string) ? (o.mood as ChatSummary["mood"]) : "neutral",
    temperature: (TEMPS as readonly string[]).includes(o.temperature as string) ? (o.temperature as ChatSummary["temperature"]) : "warm",
    objections: (Array.isArray(o.objections) ? o.objections : []).map((x) => str(x, 100)).filter(Boolean).slice(0, 3),
  };
}

type Msg = { from: "visitor" | "operator" | "ai"; text: string };

/** Canlı söhbətin mətni: AI ilə əvvəlki yazışma + operatorla yazışma (sistem mesajları atılır) */
export const liveTranscript = (c: LiveChat): Msg[] => [
  ...c.context.map((m) => ({ from: m.role === "user" ? "visitor" as const : "ai" as const, text: m.text })),
  ...c.messages.filter((m) => m.from !== "system").map((m) => ({ from: m.from as "visitor" | "operator", text: m.file && !m.text ? "[fayl]" : m.text })),
].filter((m) => m.text.trim()).slice(-60);

async function ask(deps: Deps, tenantId: string, messages: Msg[]): Promise<ChatSummary> {
  if (!messages.some((m) => m.from === "visitor")) throw new HttpError(400, "Müştəri hələ yazmayıb", "NO_VISITOR_MESSAGE");
  try {
    const out = await deps.ai.summarize(tenantId, messages.map((m) => ({ from: m.from, text: m.text.slice(0, 600) })));
    const s = cleanSummary(out.summary);
    if (!s) throw new HttpError(502, "AI xülasə hazırlaya bilmədi, bir az sonra yenidən cəhd et", "AI_FAILED");
    return s;
  } catch (e) {
    if (e instanceof AiError) throw new HttpError(e.status === 402 ? 402 : 502, e.status === 402 ? "Balans bitib, AI xülasəsi mümkün deyil" : "AI xülasə hazırlaya bilmədi, bir az sonra yenidən cəhd et", e.code ?? "AI_FAILED");
    throw e;
  }
}

/** Canlı söhbət: saxlanmış xülasə hələ təzədirsə (mesaj sayı eynidir) onu qaytarır, əks halda yenisini hazırlayıb saxlayır */
export async function liveSummary(deps: Deps, tenantId: string, chat: LiveChat, force = false) {
  const transcript = liveTranscript(chat);
  const count = chat.context.length + chat.messages.length;
  if (chat.summary && chat.summary.count === count && !force) return { summary: chat.summary, cached: true };
  const s = await ask(deps, tenantId, transcript);
  const summary = { ...s, at: new Date(), count };
  await deps.store.patchLive(tenantId, chat.id, { summary });
  return { summary, cached: false };
}

// AI söhbətləri (vidjet, kanallar): mətn AI servisindədir, xülasə yaddaşda saxlanır (restartdan sonra yenidən hazırlanır)
const convCache = new Map<string, { summary: ChatSummary & { at: Date; count: number } }>();
export async function conversationSummary(deps: Deps, tenantId: string, sid: string, force = false) {
  const conv = (await deps.ai.conversation(tenantId, sid)) as { messages?: { message?: unknown; answer?: unknown }[] };
  const rows = Array.isArray(conv.messages) ? conv.messages : [];
  const messages: Msg[] = rows.flatMap((m) => [
    ...(typeof m.message === "string" && m.message ? [{ from: "visitor" as const, text: m.message }] : []),
    ...(typeof m.answer === "string" && m.answer ? [{ from: "ai" as const, text: m.answer }] : []),
  ]).slice(-60);
  const key = `${tenantId}|${sid}`;
  const hit = convCache.get(key);
  if (hit && hit.summary.count === rows.length && !force) return { summary: hit.summary, cached: true };
  const s = await ask(deps, tenantId, messages);
  const summary = { ...s, at: new Date(), count: rows.length };
  convCache.set(key, { summary });
  if (convCache.size > 2000) convCache.delete(convCache.keys().next().value!);
  return { summary, cached: false };
}
