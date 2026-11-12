// API-siz sifariş: AI söhbətdə sifariş formasını doldurub təsdiq alanda AI servisi onu müraciətlər qutusuna yazır və cavabda
// `order` qaytarır. Burada: sahibə e-poçt, avtomatlaşdırmalar (Telegram qrupu / Bitrix24 / webhook) və panelin dərhal yenilənməsi.
// Ziyarətçini gözlətmir: hamısı fonda gedir, alınmasa da sifariş paneldə qalır.
import type { Deps } from "./deps.js";
import { hub } from "./hub.js";
import { notifyTeam } from "./operator-notify.js";
import { forwardLead } from "./lead-forward.js";
import type { TenantRecord } from "./store/types.js";

export type OrderInfo = { id: string; title: string; name: string; contact: string; fields: { label: string; value: string }[] };

const str = (v: unknown, n: number) => (typeof v === "string" ? v.replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, n) : "");

/** AI servisinin cavabındakı order sahəsini yoxlayır (etibarsızdırsa null). */
export function parseOrder(v: unknown): OrderInfo | null {
  if (!v || typeof v !== "object") return null;
  const o = v as Record<string, unknown>;
  const fields = (Array.isArray(o.fields) ? o.fields : []).slice(0, 12)
    .map((f) => ({ label: str((f as { label?: unknown })?.label, 60), value: str((f as { value?: unknown })?.value, 300) }))
    .filter((f) => f.label && f.value);
  const contact = str(o.contact, 120);
  if (!contact || !fields.length) return null;
  return { id: str(o.id, 60), title: str(o.title, 60) || "Sifariş", name: str(o.name, 80), contact, fields };
}

/** Sifariş gəldi: sahibə e-poçt, ötürmə və panel siqnalı. channel: "sayt" | "Telegram" | "WhatsApp". */
export async function onOrder(deps: Deps, t: TenantRecord, raw: unknown, source: string, conversation: { role: string; text: string }[] = []): Promise<void> {
  const order = parseOrder(raw);
  if (!order) return;
  const lines = order.fields.map((f) => `${f.label}: ${f.value}`);
  hub.toOperators(t.tenantId, { t: "leads", kind: "order" });
  void notifyTeam(deps, t, `🛒 Yeni sifariş${order.id ? ` №${order.id.slice(0, 8).toUpperCase()}` : ""} (${source}) · ${t.businessName}\n\n${[order.name, order.contact].filter(Boolean).join(", ")}\n${lines.slice(0, 8).join("\n")}`, "/orders");
  void forwardLead(deps, t, { source: `${source}, sifariş`, name: order.name, contact: order.contact, question: `${order.title}: ${lines.join("; ")}`.slice(0, 500), conversation: conversation.slice(-10), order: { title: order.title, fields: order.fields } });
  try {
    const owner = await deps.store.findUserById(t.userId);
    if (!owner) return;
    const no = order.id ? ` №${order.id.slice(0, 8).toUpperCase()}` : "";
    await deps.mailer.send(owner.email, `🛒 Yeni sifariş${no}: ${t.businessName}`,
      `Çat (${source}) yeni sifariş qəbul etdi: ${order.title}${no}.\n\n${lines.join("\n")}\n\nMüştəri ilə əlaqə saxlayın və sifarişi paneldə "işdədir" / "həll olunub" kimi qeyd edin:\n${deps.config.allowedOrigins[0] ?? ""}/inbox`,
      { action: "Sifarişə bax", preheader: `${order.name || order.contact}: ${lines.slice(0, 3).join(", ").slice(0, 100)}` });
  } catch (e) { console.warn("[order] sahibə bildiriş göndərilmədi:", e instanceof Error ? e.message : e); }
}
