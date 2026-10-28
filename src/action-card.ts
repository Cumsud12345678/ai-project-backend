// Əməliyyat təsdiq kartı: AI serverindən gələn məlumat təmizlənir (ziyarətçiyə yalnız bu sahələr çatır).
export type ConfirmCard = { id: string; title: string; summary: string; details: { k: string; v: string }[]; account?: boolean; expiresInS?: number };

const cut = (v: unknown, n: number) => (typeof v === "string" ? v.replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, n) : "");

export function publicConfirm(raw: unknown): ConfirmCard | null {
  const c = raw as Record<string, unknown> | null | undefined;
  if (!c || typeof c !== "object" || typeof c.id !== "string" || !/^[0-9a-f]{32}$/.test(c.id)) return null;
  const details = (Array.isArray(c.details) ? c.details : []).slice(0, 8)
    .map((d: any) => ({ k: cut(d?.k, 40), v: cut(d?.v, 120) })).filter((d) => d.k);
  return { id: c.id, title: cut(c.title, 60) || "Əməliyyat", summary: cut(c.summary, 300), details, ...(c.account === true && { account: true }), ...(Number.isFinite(c.expiresInS) && { expiresInS: Math.min(Number(c.expiresInS), 3600) }) };
}

/** Mesajlaşma kanalları üçün düz mətn kartı. */
export function cardText(card: ConfirmCard): string {
  const lines = [`⚠️ ${card.title}`, ...(card.summary ? [card.summary] : []), ...card.details.map((d) => `• ${d.k}: ${d.v}`)];
  return `${lines.join("\n")}\n\nTəsdiq etmək üçün BƏLİ, ləğv etmək üçün XEYR yazın.`;
}

const YES = new Set(["bəli", "beli", "bəli.", "təsdiq", "tesdiq", "təsdiq edirəm", "yes", "да", "ok", "okay"]);
const NO = new Set(["xeyr", "yox", "ləğv", "legv", "ləğv et", "no", "нет", "cancel", "отмена"]);
/** Yalnız TAM söz təsdiq sayılır ("bəli, amma..." və ya uzun mətn sayılmır). */
export function parseDecision(text: string): "confirm" | "cancel" | null {
  const t = text.toLowerCase().replace(/\u0307/g, "").replace(/[!.?\s]+$/g, "").replace(/^[\s]+/, "");
  if (YES.has(t)) return "confirm";
  if (NO.has(t)) return "cancel";
  return null;
}
