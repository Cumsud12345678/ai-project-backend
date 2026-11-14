// Məhsullar üzrə analitika: hansı məhsula daha çox maraq var (AI söhbətdə göstərib), hansı daha çox sifariş olunur, hansı xidmətə randevu alınır.
// Faiz = bu dövrdəki payı; dəyişmə = əvvəlki eyni uzunluqlu dövrlə müqayisə. AI çağırılmır (pulsuz).
import type { Deps } from "./deps.js";
import type { TenantRecord } from "./store/types.js";

type Row = { title: string; count: number; prev: number; clicks?: number };
type Lead = { at?: string; order?: { fields?: { key?: string; label?: string; value?: string }[] }; booking?: { service?: string; status?: string } };

// Sifariş formasında məhsul sahəsi: açar (hazır şablonlar) və ya ad (sahibin öz forması)
const PRODUCT_KEYS = new Set(["product", "products", "item", "items", "course", "service", "model", "mehsul"]);
const PRODUCT_LABEL = /^(məhsul|mehsul|məhsullar|mal|kurs|xidmət|model|product|item|товар|продукт|услуга|курс|ürün|hizmet)(?!\p{L})/iu;
const norm = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim();
// "Qara çanta x2", "Qara çanta - 2 ədəd" → "qara çanta" (say hissəsi qruplaşdırmaya mane olmasın)
const clean = (s: string) => norm(s).replace(/[,;(]?\s*(x\s*\d+|\d+\s*(ədəd|eded|əd|шт|adet|pcs|dənə|dene))\)?\s*$/i, "").replace(/[.,;:!-]+$/, "").trim();

export function productOf(fields: { key?: string; label?: string; value?: string }[] = []): string | null {
  const f = fields.find((x) => x.key && PRODUCT_KEYS.has(x.key.toLowerCase())) ?? fields.find((x) => x.label && PRODUCT_LABEL.test(x.label.trim()));
  const v = f?.value?.trim();
  return v ? v.slice(0, 120) : null;
}

function tally(entries: { title: string; at: number }[], curFrom: number, knownTitle: Map<string, string> = new Map()): { total: number; prevTotal: number; items: Row[] } {
  const known = [...knownTitle.keys()].sort((a, b) => b.length - a.length);
  const m = new Map<string, Row>();
  let total = 0, prevTotal = 0;
  for (const e of entries) {
    let k = clean(e.title);
    if (!k) continue;
    // Kataloqda tanınan məhsul adı mətnin içindədirsə həmin ada yığılır ("Qara çanta M ölçü" → "Qara çanta")
    const hit = known.find((t) => t.length >= 3 && k.includes(t));
    if (hit) k = hit;
    const r = m.get(k) ?? { title: hit ? e.title : e.title.trim(), count: 0, prev: 0 };
    if (hit) r.title = knownTitle.get(hit) ?? r.title;
    if (e.at >= curFrom) { r.count++; total++; } else { r.prev++; prevTotal++; }
    m.set(k, r);
  }
  return { total, prevTotal, items: [...m.values()].filter((r) => r.count > 0).sort((a, b) => b.count - a.count || a.title.localeCompare(b.title)).slice(0, 20) };
}
export async function productInsights(deps: Deps, t: TenantRecord, days: number) {
  const now = Date.now();
  const curFrom = now - days * 86_400_000, prevFrom = now - 2 * days * 86_400_000;
  const ok = <T>(p: Promise<T>) => p.catch(() => null);
  const [interest, orders, bookings] = await Promise.all([
    ok(deps.ai.productInterest(t.tenantId, days)),
    ok(deps.ai.kbLeads(t.tenantId, "order")),
    ok(deps.ai.kbLeads(t.tenantId, "booking")),
  ]);
  const iItems = ((interest?.items ?? []) as { title: string; shown: number; prevShown: number; clicks: number }[]);
  const knownTitle = new Map<string, string>();
  for (const x of iItems) knownTitle.set(clean(x.title), x.title);
  const inWin = (l: Lead) => { const at = Date.parse(String(l.at ?? "")); return Number.isFinite(at) && at >= prevFrom ? at : null; };
  const orderEntries = ((orders?.items ?? []) as Lead[]).flatMap((l) => { const at = inWin(l); const p = productOf(l.order?.fields); return at && p ? [{ title: p, at }] : []; });
  const bookingEntries = ((bookings?.items ?? []) as Lead[]).flatMap((l) => { const at = inWin(l); const s = l.booking?.service?.trim(); return at && s && l.booking?.status !== "cancelled" ? [{ title: s.slice(0, 120), at }] : []; });
  return {
    days,
    enabled: interest?.enabled !== false,
    interest: {
      total: Number(interest?.conversations ?? 0), prevTotal: Number(interest?.prevConversations ?? 0),
      items: iItems.map((x) => ({ title: x.title, count: x.shown, prev: x.prevShown, clicks: x.clicks })),
    },
    orders: tally(orderEntries, curFrom, knownTitle),
    bookings: tally(bookingEntries, curFrom),
  };
}
