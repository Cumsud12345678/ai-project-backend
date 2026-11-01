// "İndi saytda kim var": vidjet açıq tabda 15 saniyədən bir xəbər verir (POST /widget/:key/presence).
// Yalnız server yaddaşında saxlanır (bazaya yazılmır), IP və brauzer barmaq izi saxlanmır; 45 saniyə xəbər gəlməsə ziyarətçi siyahıdan düşür.
// Panelə ziyarətçinin öz ID-si yox, ondan törədilmiş qısa açar (pid) verilir: operator ziyarətçinin brauzer ID-sini görmür.
// Operator dəvəti: operator ziyarətçiyə ilk yazır -> canlı söhbət yaradılır -> token ziyarətçinin növbəti xəbərinin cavabında ona çatır.
// Tək server prosesi üçündür (hub.ts kimi). Çox serverdə ziyarətçi başqa serverə düşsə siyahı natamam olar.
import { createHash } from "node:crypto";

export const PRESENCE_TTL_MS = 45_000;
const INVITE_TTL_MS = 10 * 60_000;
const MAX_PER_TENANT = 300;

export type ChatState = "none" | "ai" | "live";
export type Visitor = {
  pid: string; path: string; title: string; ref: string; lang: string; mobile: boolean; chat: ChatState;
  since: number; seen: number; pages: number;
};
type Entry = Visitor & { lastPath: string };

const byTenant = new Map<string, Map<string, Entry>>();
const invites = new Map<string, { id: string; token: string; exp: number }>();

export const pidOf = (tenantId: string, vid: string) => createHash("sha256").update(`presence:${tenantId}:${vid}`).digest("hex").slice(0, 16);

function prune(m: Map<string, Entry>, now = Date.now()) {
  for (const [k, v] of m) if (now - v.seen > PRESENCE_TTL_MS) m.delete(k);
}

/** Ziyarətçinin xəbəri. Qaytarır: { pid, isNew } (yeni gələn ziyarətçi panelə dərhal siqnal verir). Limit dolubsa null. */
export function beat(tenantId: string, vid: string, info: Omit<Visitor, "pid" | "since" | "seen" | "pages">): { pid: string; isNew: boolean } | null {
  const now = Date.now();
  let m = byTenant.get(tenantId);
  if (!m) { m = new Map(); byTenant.set(tenantId, m); }
  const pid = pidOf(tenantId, vid);
  const cur = m.get(pid);
  if (cur && now - cur.seen <= PRESENCE_TTL_MS) {
    // Gəldiyi yer: ilk xarici mənbə saxlanır (sayt daxilində keçiddə referrer saytın özü olur)
    Object.assign(cur, info, { ref: cur.ref || info.ref, seen: now, pages: cur.pages + (info.path !== cur.lastPath ? 1 : 0), lastPath: info.path });
    return { pid, isNew: false };
  }
  prune(m, now);
  if (m.size >= MAX_PER_TENANT) return null;
  m.set(pid, { ...info, pid, since: now, seen: now, pages: 1, lastPath: info.path });
  return { pid, isNew: true };
}

export function listVisitors(tenantId: string): Visitor[] {
  const m = byTenant.get(tenantId);
  if (!m) return [];
  prune(m);
  return [...m.values()].sort((a, b) => b.since - a.since).map(({ lastPath: _l, ...v }) => v);
}
export const getVisitor = (tenantId: string, pid: string): Visitor | null => {
  const v = byTenant.get(tenantId)?.get(pid);
  return v && Date.now() - v.seen <= PRESENCE_TTL_MS ? v : null;
};

export const setInvite = (tenantId: string, pid: string, inv: { id: string; token: string }) => { invites.set(`${tenantId}|${pid}`, { ...inv, exp: Date.now() + INVITE_TTL_MS }); };
export const hasInvite = (tenantId: string, pid: string) => { const v = invites.get(`${tenantId}|${pid}`); return Boolean(v && v.exp > Date.now()); };
/** Dəvəti bir dəfə verir (sonra silinir). */
export function takeInvite(tenantId: string, pid: string): { id: string; token: string } | null {
  const k = `${tenantId}|${pid}`, v = invites.get(k);
  if (!v) return null;
  invites.delete(k);
  return v.exp > Date.now() ? { id: v.id, token: v.token } : null;
}

/** Testlər üçün */
export const __resetPresence = () => { byTenant.clear(); invites.clear(); };

// Boş qalmış saytları və köhnəlmiş dəvətləri dəqiqədə bir təmizləyir
setInterval(() => {
  const now = Date.now();
  for (const [t, m] of byTenant) { prune(m, now); if (!m.size) byTenant.delete(t); }
  for (const [k, v] of invites) if (v.exp < now) invites.delete(k);
}, 60_000).unref();
