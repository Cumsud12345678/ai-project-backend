// Operator helpdesk və proaktiv mesaj ayarlarının doğrulanması, işçi saatları hesabı.
import { hasFeature } from "./plans.js";
import { randomBytes } from "node:crypto";
import { HttpError } from "./http.js";
import type { CannedReply, ProactiveRule, TenantRecord, WorkHours } from "./store/types.js";

const HM = /^([01]\d|2[0-3]):([0-5]\d)$/;
const mins = (s: string) => Number(s.slice(0, 2)) * 60 + Number(s.slice(3));

const validTz = (tz: string) => { try { new Intl.DateTimeFormat("en-US", { timeZone: tz }); return true; } catch { return false; } };

export function parseHours(v: unknown): WorkHours | null {
  if (v === null) return null;
  const h = v as { tz?: unknown; days?: unknown } | undefined;
  if (!h || typeof h !== "object" || typeof h.tz !== "string" || h.tz.length > 60 || !validTz(h.tz)) throw new HttpError(400, "İşçi saatları: saat qurşağı düzgün deyil (məs. Asia/Baku)");
  if (!Array.isArray(h.days) || h.days.length !== 7) throw new HttpError(400, "İşçi saatları: həftənin 7 günü göndərilməlidir");
  const days = h.days.map((d: unknown) => {
    if (d === null) return null;
    const x = d as { from?: unknown; to?: unknown };
    // Bitiş başlanğıcdan kiçikdirsə gecə növbəsidir (22:00–02:00 ertəsi gün bitir); bərabərdirsə 24 saat (00:00–00:00)
    if (!x || typeof x.from !== "string" || typeof x.to !== "string" || !HM.test(x.from) || !HM.test(x.to)) throw new HttpError(400, "İşçi saatları: saat HH:MM formatında olmalıdır");
    return { from: x.from, to: x.to };
  });
  if (!days.some(Boolean)) throw new HttpError(400, "İşçi saatları: ən azı bir iş günü olmalıdır");
  return { tz: h.tz, days };
}

/** Verilmiş vaxt işçi saatlarındadırmı. Saat təyin olunmayıbsa həmişə true. */
export function withinHours(h: WorkHours | null | undefined, now = new Date()): boolean {
  if (!h) return true;
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: h.tz, weekday: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(now);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  const day = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(get("weekday"));
  const cur = (Number(get("hour")) % 24) * 60 + Number(get("minute"));
  const slot = h.days[day];
  if (slot) {
    const f = mins(slot.from), t = mins(slot.to);
    if (t > f ? cur >= f && cur < t : cur >= f) return true;
  }
  // Dünənki gecə növbəsinin bu günə keçən hissəsi (məs. cümə 22:00–02:00 → şənbə 00:00–02:00)
  const prev = h.days[(day + 6) % 7];
  return Boolean(prev && mins(prev.to) <= mins(prev.from) && cur < mins(prev.to));
}

/** Canlı operator hazırda ziyarətçiyə təklif olunurmu: açıqdır və işçi saatlarındadır. */
// Canlı söhbət planda olmalıdır (keşdən; əsas axınlar əvvəlcə loadEntitlements çağırır)
export const liveOpenNow = (t: TenantRecord, now = new Date()) => Boolean(t.widget?.live?.enabled) && hasFeature(t.tenantId, "live") && withinHours(t.widget?.live?.hours, now);

export const MAX_CAMPAIGNS = 10;
const clean = (v: unknown, max: number) => (typeof v === "string" ? v.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, max + 1) : "");
const oneOf = <T extends string>(v: unknown, list: readonly T[], def: T): T => (v === undefined || v === null ? def : list.includes(v as T) ? (v as T) : (() => { throw new HttpError(400, `Kampaniya sahəsi düzgün deyil: ${String(v).slice(0, 20)}`); })());
function isoOrNull(v: unknown, label: string): string | null {
  if (v === undefined || v === null || v === "") return null;
  const d = typeof v === "string" ? new Date(v) : null;
  if (!d || Number.isNaN(d.getTime())) throw new HttpError(400, `${label} tarixi düzgün deyil`);
  return d.toISOString();
}

/** Kampaniyalar (proaktiv mesajlar). Köhnə qaydalar (yalnız text/delaySec/match) olduğu kimi qəbul edilir. */
export function parseProactive(v: unknown): { enabled: boolean; rules: ProactiveRule[] } {
  const p = v as { enabled?: unknown; rules?: unknown } | undefined;
  if (!p || typeof p !== "object" || typeof p.enabled !== "boolean" || !Array.isArray(p.rules)) throw new HttpError(400, "proactive: enabled və rules tələb olunur");
  if (p.rules.length > MAX_CAMPAIGNS) throw new HttpError(400, `Ən çox ${MAX_CAMPAIGNS} kampaniya yarada bilərsiniz`);
  const rules = p.rules.map((r: unknown): ProactiveRule => {
    const x = (r ?? {}) as Record<string, unknown>;
    const text = clean(x.text, 300);
    if (text.length < 3 || text.length > 300) throw new HttpError(400, "Proaktiv mesaj 3-300 simvol olmalıdır");
    if (typeof x.delaySec !== "number" || !Number.isInteger(x.delaySec) || x.delaySec < 0 || x.delaySec > 600) throw new HttpError(400, "Gözləmə vaxtı 0-600 saniyə olmalıdır");
    const match = typeof x.match === "string" ? x.match.trim() : "";
    if (!match || match.length > 200 || !/^[\w\-./*,\s%]+$/.test(match)) throw new HttpError(400, "Səhifə şablonu düzgün deyil (məs. /, /products/*, *)");
    const id = typeof x.id === "string" && /^[a-f0-9]{8}$/.test(x.id) ? x.id : randomBytes(4).toString("hex");
    const name = clean(x.name, 60), title = clean(x.title, 40);
    if (name.length > 60) throw new HttpError(400, "Kampaniyanın adı ən çox 60 simvol ola bilər");
    if (title.length > 40) throw new HttpError(400, "Kartın başlığı ən çox 40 simvol ola bilər");
    if (x.buttons !== undefined && (!Array.isArray(x.buttons) || x.buttons.length > 3)) throw new HttpError(400, "Ən çox 3 düymə ola bilər");
    const buttons = ((x.buttons as unknown[] | undefined) ?? []).map((b) => {
      const y = (b ?? {}) as Record<string, unknown>;
      const label = clean(y.label, 30);
      if (!label || label.length > 30) throw new HttpError(400, "Düymənin yazısı 1-30 simvol olmalıdır");
      return { label, kind: oneOf(y.kind, ["chat", "send", "close"] as const, "chat") };
    });
    const startAt = isoOrNull(x.startAt, "Başlama"), endAt = isoOrNull(x.endAt, "Bitmə");
    if (startAt && endAt && endAt <= startAt) throw new HttpError(400, "Bitmə tarixi başlamadan sonra olmalıdır");
    return {
      id, text, delaySec: x.delaySec, match,
      ...(name && { name }), ...(title && { title }), ...(buttons.length && { buttons }),
      active: x.active !== false,
      audience: oneOf(x.audience, ["all", "new", "returning"] as const, "all"),
      device: oneOf(x.device, ["all", "mobile", "desktop"] as const, "all"),
      freq: oneOf(x.freq, ["visit", "once"] as const, "visit"),
      online: x.online === true,
      startAt, endAt,
    };
  });
  if (new Set(rules.map((r) => r.id)).size !== rules.length) throw new HttpError(400, "Proaktiv mesaj identifikatorları təkrarlanır");
  return { enabled: p.enabled, rules };
}

/** Kampaniyanın indi göstərilib-göstərilməyəcəyi (vaxt və operator şərti; ziyarətçi şərtlərini vidjet yoxlayır) */
export function campaignRunning(r: ProactiveRule, liveOnline: boolean, now = new Date()): boolean {
  if (r.active === false) return false;
  if (r.startAt && new Date(r.startAt) > now) return false;
  if (r.endAt && new Date(r.endAt) <= now) return false;
  return !r.online || liveOnline;
}

export function parseCanned(v: unknown): CannedReply[] {
  if (!Array.isArray(v) || v.length > 30) throw new HttpError(400, "Ən çox 30 hazır cavab ola bilər");
  const out = v.map((r: unknown) => {
    const x = r as { id?: unknown; title?: unknown; text?: unknown };
    const title = typeof x?.title === "string" ? x.title.trim() : "", text = typeof x?.text === "string" ? x.text.trim() : "";
    if (!title || title.length > 40) throw new HttpError(400, "Hazır cavabın adı 1-40 simvol olmalıdır");
    if (!text || text.length > 1000) throw new HttpError(400, "Hazır cavabın mətni 1-1000 simvol olmalıdır");
    return { id: typeof x.id === "string" && /^[a-f0-9]{8}$/.test(x.id) ? x.id : randomBytes(4).toString("hex"), title, text };
  });
  if (new Set(out.map((r) => r.id)).size !== out.length) throw new HttpError(400, "Hazır cavab identifikatorları təkrarlanır");
  return out;
}

export function parseTags(v: unknown): string[] {
  if (!Array.isArray(v) || v.length > 5) throw new HttpError(400, "Ən çox 5 etiket ola bilər");
  const seen = new Set<string>(), out: string[] = [];
  for (const t of v) {
    const s = typeof t === "string" ? t.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim() : "";
    if (!s || s.length > 24) throw new HttpError(400, "Etiket 1-24 simvol olmalıdır");
    if (!seen.has(s.toLowerCase())) { seen.add(s.toLowerCase()); out.push(s); }
  }
  return out;
}

const matchPath = (pattern: string, path: string) => pattern.split(",").map((s) => s.trim()).filter(Boolean).some((p) => p === "*" || (p.endsWith("/*") ? path === p.slice(0, -2) || path.startsWith(p.slice(0, -1)) : p === path));
export { matchPath };
