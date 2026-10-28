// Operator helpdesk və proaktiv mesaj ayarlarının doğrulanması, işçi saatları hesabı.
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
    if (!x || typeof x.from !== "string" || typeof x.to !== "string" || !HM.test(x.from) || !HM.test(x.to) || mins(x.from) >= mins(x.to)) throw new HttpError(400, "İşçi saatları: saat HH:MM formatında olmalı və başlanğıc bitişdən əvvəl olmalıdır");
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
  const slot = h.days[day];
  if (!slot) return false;
  const cur = Number(get("hour")) * 60 + Number(get("minute"));
  return cur >= mins(slot.from) && cur < mins(slot.to);
}

/** Canlı operator hazırda ziyarətçiyə təklif olunurmu: açıqdır və işçi saatlarındadır. */
export const liveOpenNow = (t: TenantRecord, now = new Date()) => Boolean(t.widget?.live?.enabled) && withinHours(t.widget?.live?.hours, now);

export function parseProactive(v: unknown): { enabled: boolean; rules: ProactiveRule[] } {
  const p = v as { enabled?: unknown; rules?: unknown } | undefined;
  if (!p || typeof p !== "object" || typeof p.enabled !== "boolean" || !Array.isArray(p.rules)) throw new HttpError(400, "proactive: enabled və rules tələb olunur");
  if (p.rules.length > 5) throw new HttpError(400, "Ən çox 5 proaktiv mesaj yaza bilərsiniz");
  const rules = p.rules.map((r: unknown) => {
    const x = r as { id?: unknown; text?: unknown; delaySec?: unknown; match?: unknown };
    const text = typeof x?.text === "string" ? x.text.replace(/[\u0000-\u001f\u007f]/g, " ").trim() : "";
    if (text.length < 3 || text.length > 140) throw new HttpError(400, "Proaktiv mesaj 3-140 simvol olmalıdır");
    if (typeof x.delaySec !== "number" || !Number.isInteger(x.delaySec) || x.delaySec < 3 || x.delaySec > 300) throw new HttpError(400, "Gözləmə vaxtı 3-300 saniyə olmalıdır");
    const match = typeof x.match === "string" ? x.match.trim() : "";
    if (!match || match.length > 200 || !/^[\w\-./*,\s%]+$/.test(match)) throw new HttpError(400, "Səhifə şablonu düzgün deyil (məs. /, /products/*, *)");
    const id = typeof x.id === "string" && /^[a-f0-9]{8}$/.test(x.id) ? x.id : randomBytes(4).toString("hex");
    return { id, text, delaySec: x.delaySec, match };
  });
  if (new Set(rules.map((r) => r.id)).size !== rules.length) throw new HttpError(400, "Proaktiv mesaj identifikatorları təkrarlanır");
  return { enabled: p.enabled, rules };
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
