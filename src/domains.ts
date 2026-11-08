// Domen nəzarəti: eyni sayt fərqli hesablarla qoşulursa (məs. yeni e-poçtla pulsuz balansı təkrar almaq üçün) admin görsün
// və domeni bloklaya bilsin. Hər hesabın qoşduğu domen jurnala yazılır; hesab silinsə də qeyd qalır, ona görə
// "sil, yeni e-poçtla yenidən qeydiyyatdan keç" də görünür. Müqayisə əsas domen üzrədir: www.shop.az, m.shop.az və shop.az eynidir.
import type { Deps } from "./deps.js";
import { sendAlert } from "./alerts.js";
import type { Store, TenantRecord } from "./store/types.js";

export type DomainLogEntry = { root: string; host: string; tenantId: string; userId: string; email: string; at: string };
export type DomainBlock = { domain: string; reason: string; by: string; at: string; /** blok zamanı dayandırılan müştərilər: blok götürüləndə bərpa olunurlar */ suspended: string[] };
export type DomainAccount = {
  tenantId: string; userId: string; email: string; host: string; businessName: string;
  /** hesab hazırda bu domendədir */ current: boolean; /** hesab silinib */ deleted: boolean; suspended: boolean; firstAt: string;
};
export type DomainOk = { domain: string; accounts: number; by: string; at: string };
export type DomainGroup = { root: string; accounts: DomainAccount[]; emails: number; block: DomainBlock | null; lastAt: string;
  /** admin "normaldır" deyib (məs. agentlik); sonradan yeni hesab gəlsə yenidən şübhəli olur */ ok: DomainOk | null; suspicious: boolean };

const LOG_KEY = "domain_log";
const BLOCK_KEY = "domain_blocks";
const OK_KEY = "domain_ok";
const LOG_MAX = 20_000;
// İkinci səviyyəli zona: shop.com.az → əsas domen "shop.com.az" (yalnız "com.az" yox)
const SLD = new Set(["com", "net", "org", "gov", "edu", "co", "ac", "biz", "info", "int", "mil", "name", "pp", "web", "ltd", "plc", "me", "or", "ne", "go"]);

/** "https://WWW.Shop.az:443/path" → "shop.az" (host, www-siz) */
export function domainHost(input: string): string {
  let h = String(input ?? "").trim().toLowerCase();
  h = h.replace(/^[a-z][a-z0-9+.-]*:\/\//, "").split(/[/?#]/)[0] ?? "";
  h = h.replace(/^[^@]*@/, "").replace(/:\d+$/, "").replace(/\.+$/, "").replace(/^www\d*\./, "");
  return h;
}

/** Əsas (qeydiyyat) domen: m.shop.az → shop.az, a.shop.com.az → shop.com.az. IP və localhost olduğu kimi qalır. */
export function domainRoot(input: string): string {
  const h = domainHost(input);
  if (!h || /^\d{1,3}(\.\d{1,3}){3}$/.test(h) || h.includes(":") || !h.includes(".")) return h;
  const p = h.split(".");
  if (p.length <= 2) return h;
  const tld = p[p.length - 1]!, sld = p[p.length - 2]!;
  return tld.length === 2 && SLD.has(sld) ? p.slice(-3).join(".") : p.slice(-2).join(".");
}

const getLog = async (store: Store) => (await store.getSetting<DomainLogEntry[]>(LOG_KEY)) ?? [];
export const getBlocks = async (store: Store) => (await store.getSetting<DomainBlock[]>(BLOCK_KEY)) ?? [];
const saveBlocks = (store: Store, b: DomainBlock[]) => store.setSetting(BLOCK_KEY, b);

/** Domen (və ya onun əsas domeni) bloklanıbsa blok qeydi */
export async function blockOf(store: Store, domain: string): Promise<DomainBlock | null> {
  const root = domainRoot(domain);
  if (!root) return null;
  return (await getBlocks(store)).find((b) => b.domain === root) ?? null;
}

/**
 * Müştərinin domenini jurnala yazır (yaradılanda və domen dəyişəndə).
 * Eyni əsas domen artıq başqa e-poçtla işlənibsə adminlərə xəbər gedir. Xəta qeydiyyatı dayandırmır.
 */
export async function recordDomain(deps: Deps, t: Pick<TenantRecord, "tenantId" | "userId" | "domain" | "businessName">, email: string): Promise<void> {
  try {
    const root = domainRoot(t.domain);
    if (!root) return;
    const log = await getLog(deps.store);
    if (log.some((e) => e.tenantId === t.tenantId && e.root === root)) return;
    // Əvvəl jurnalda olmayan (bu funksiyadan əvvəl yaradılmış) hesablar da sayılsın
    const live = (await deps.store.listTenants(LOG_MAX)).filter((x) => x.tenantId !== t.tenantId && domainRoot(x.domain) === root);
    const owners = await deps.store.findUsersByIds([...new Set(live.map((x) => x.userId))]);
    const others = new Set([...log.filter((e) => e.root === root && e.email !== email).map((e) => e.email), ...owners.map((u) => u.email).filter((e) => e !== email)]);
    log.push({ root, host: domainHost(t.domain), tenantId: t.tenantId, userId: t.userId, email, at: new Date().toISOString() });
    await deps.store.setSetting(LOG_KEY, log.slice(-LOG_MAX));
    if (others.size) {
      void sendAlert(deps, "domain", `dup:${root}:${t.tenantId}`, `Eyni domen yeni hesabda: ${root}`,
        `${email} "${t.businessName}" adı ilə ${root} domenini qoşdu. Bu domen əvvəl başqa hesab(lar)da işlənib: ${[...others].slice(0, 5).join(", ")}.\n\nBu, pulsuz balansı təkrar almaq üçün ola bilər. Admin panel → Müştərilər → Domenlər bölməsində yoxla, lazım olsa domeni blokla.`).catch(() => {});
    }
  } catch (e) { console.error("[domains] jurnala yazıla bilmədi:", e); }
}

/** Bütün domenlər əsas domen üzrə qruplanmış: hazırkı hesablar + jurnaldakı keçmiş (silinmiş və ya domenini dəyişmiş) hesablar */
export async function domainGroups(store: Store): Promise<DomainGroup[]> {
  const [tenants, log, blocks, oks] = await Promise.all([store.listTenants(LOG_MAX), getLog(store), getBlocks(store), store.getSetting<DomainOk[]>(OK_KEY).then((x) => x ?? [])]);
  const owners = await store.findUsersByIds([...new Set(tenants.map((t) => t.userId))]);
  const email = new Map(owners.map((u) => [u.id, u.email]));
  const live = new Map(tenants.map((t) => [t.tenantId, t]));
  const groups = new Map<string, Map<string, DomainAccount>>();
  const add = (root: string, a: DomainAccount) => {
    if (!root) return;
    const g = groups.get(root) ?? new Map<string, DomainAccount>();
    const prev = g.get(a.tenantId);
    if (!prev || (a.current && !prev.current)) g.set(a.tenantId, prev ? { ...a, firstAt: prev.firstAt < a.firstAt ? prev.firstAt : a.firstAt } : a);
    groups.set(root, g);
  };
  for (const t of tenants) {
    add(domainRoot(t.domain), { tenantId: t.tenantId, userId: t.userId, email: email.get(t.userId) ?? "", host: domainHost(t.domain), businessName: t.businessName, current: true, deleted: false, suspended: Boolean(t.suspended), firstAt: new Date(t.createdAt).toISOString() });
  }
  for (const e of log) {
    const t = live.get(e.tenantId);
    add(e.root, { tenantId: e.tenantId, userId: e.userId, email: e.email, host: e.host, businessName: t?.businessName ?? "", current: Boolean(t && domainRoot(t.domain) === e.root), deleted: !t, suspended: Boolean(t?.suspended), firstAt: e.at });
  }
  const blockBy = new Map(blocks.map((b) => [b.domain, b]));
  const okBy = new Map(oks.map((o) => [o.domain, o]));
  for (const b of blocks) if (!groups.has(b.domain)) groups.set(b.domain, new Map());
  return [...groups.entries()].map(([root, g]) => {
    const accounts = [...g.values()].sort((a, b) => a.firstAt.localeCompare(b.firstAt));
    const emails = new Set(accounts.map((a) => a.email).filter(Boolean)).size;
    const block = blockBy.get(root) ?? null;
    const ok = okBy.get(root) && okBy.get(root)!.accounts >= accounts.length ? okBy.get(root)! : null;
    return { root, accounts, emails, block, ok, suspicious: emails >= 2 && !block && !ok, lastAt: accounts.at(-1)?.firstAt ?? block?.at ?? "" };
  }).sort((a, b) => Number(b.suspicious) - Number(a.suspicious) || b.emails - a.emails || b.lastAt.localeCompare(a.lastAt));
}

/** "Normaldır": hazırkı hesab sayı ilə qeyd olunur, yeni hesab gəlsə qrup yenidən şübhəli görünür. ok=false qeydi silir. */
export async function markDomainOk(store: Store, domain: string, accounts: number, by: string, ok: boolean): Promise<void> {
  const root = domainRoot(domain);
  const list = ((await store.getSetting<DomainOk[]>(OK_KEY)) ?? []).filter((o) => o.domain !== root);
  await store.setSetting(OK_KEY, ok ? [...list, { domain: root, accounts, by, at: new Date().toISOString() }] : list);
}

/** Domeni bloklayır. suspendAll: bu domendə hazırda işləyən hesabları da dayandırır (blok götürüləndə bərpa olunurlar). */
export async function blockDomain(deps: Deps, domain: string, reason: string, by: string, suspend: (tenantId: string) => Promise<boolean>, suspendAll: boolean): Promise<DomainBlock> {
  const root = domainRoot(domain);
  const blocks = await getBlocks(deps.store);
  if (blocks.some((b) => b.domain === root)) throw Object.assign(new Error("Bu domen artıq bloklanıb"), { code: "ALREADY_BLOCKED" });
  const suspended: string[] = [];
  if (suspendAll) {
    for (const t of (await deps.store.listTenants(LOG_MAX)).filter((x) => domainRoot(x.domain) === root && !x.suspended)) {
      if (await suspend(t.tenantId)) suspended.push(t.tenantId);
    }
  }
  const b: DomainBlock = { domain: root, reason, by, at: new Date().toISOString(), suspended };
  await saveBlocks(deps.store, [...blocks, b]);
  return b;
}

/** Bloku götürür; blok zamanı dayandırılanları qaytarır ki, bərpa olunsunlar */
export async function unblockDomain(store: Store, domain: string): Promise<DomainBlock | null> {
  const root = domainRoot(domain);
  const blocks = await getBlocks(store);
  const b = blocks.find((x) => x.domain === root) ?? null;
  if (b) await saveBlocks(store, blocks.filter((x) => x.domain !== root));
  return b;
}
