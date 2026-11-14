// Admin xəbərdarlıqları: adminlərə Telegram (platformanın bildiriş botu) və/və ya e-poçt ilə.
//  - errors:  son 15 dəqiqədə xəta sayı həddi keçəndə (saatda ən çox bir dəfə)
//  - health:  AI servisi və ya verilənlər bazası ardıcıl 2 yoxlamada cavab verməyəndə; bərpa olanda da xəbər gedir
//  - topup:   müştəri yeni yükləmə sorğusu göndərəndə
//  - channel: müştərinin WhatsApp bağlantısı qırılanda (müştəri üzrə 6 saatda bir)
//  - limit:   müştəri gündəlik xərc limitinə çatanda (müştəri üzrə gündə bir)
//  - provider: Claude və ya Gemini hesabında balans/limit bitəndə, açar səhv olanda; bərpa olanda da xəbər gedir
// Vəziyyət (son göndərmə, servis vəziyyəti) yaddaşdadır: tək server prosesi üçündür.
import { sendPlanReminders } from "./billing.js";
import type { Deps } from "./deps.js";
import { notifyAvailable, sendNotify } from "./operator-notify.js";
import type { User } from "./store/types.js";
import { checkTelegramBots } from "./channel-health.js";

export const ALERT_KINDS = ["errors", "health", "topup", "channel", "limit", "domain", "provider", "setup"] as const;
export type AlertKind = (typeof ALERT_KINDS)[number];
export type AlertSettings = { email: boolean; telegram: boolean; kinds: Record<AlertKind, boolean>; /** 15 dəqiqədə neçə xətadan sonra */ errorThreshold: number };
export type AlertLogItem = { at: Date; kind: AlertKind | "test" | "ai"; title: string; telegram: number; email: number };

export const DEFAULT_ALERTS: AlertSettings = { email: true, telegram: true, kinds: { errors: true, health: true, topup: true, channel: true, limit: true, domain: true, provider: true, setup: true }, errorThreshold: 20 };
const KEY = "admin_alerts";
const COOLDOWN_MS: Record<AlertKind, number> = { errors: 60 * 60_000, health: 0, topup: 0, channel: 6 * 60 * 60_000, limit: 24 * 60 * 60_000, domain: 0, provider: 0, setup: 0 };
const ERROR_WINDOW_MS = 15 * 60_000;
const HOURLY_CAP = 40; // səhv konfiqurasiyada adminin telefonu/poçtu dolmasın

const last = new Map<string, number>();
const sentTimes: number[] = [];
const log: AlertLogItem[] = [];
// Baza əlçatmaz olanda da xəbər getsin deyə son oxunan ayarlar və adminlər yaddaşda saxlanır
// Açar store obyektidir: testlərdə bir prosesdə bir neçə portal ola bilər
type Ctx = { settings: AlertSettings; admins: User[]; at: number };
let ctxCache = new WeakMap<object, Ctx>();
const health = { ai: { down: false, fails: 0, since: 0 }, db: { down: false, fails: 0, since: 0 } };

/** Testlər üçün */
export function resetAlerts() { remindAt = 0; last.clear(); sentTimes.length = 0; log.length = 0; providerSeen.clear(); ctxCache = new WeakMap(); health.ai = { down: false, fails: 0, since: 0 }; health.db = { down: false, fails: 0, since: 0 }; }
export const alertLog = () => [...log].reverse();
export const healthState = () => ({ ai: { down: health.ai.down, since: health.ai.since ? new Date(health.ai.since) : null }, db: { down: health.db.down, since: health.db.since ? new Date(health.db.since) : null } });

export function normalizeAlerts(v: unknown): AlertSettings {
  const o = (v ?? {}) as Partial<AlertSettings> & { kinds?: Partial<Record<AlertKind, unknown>> };
  const kinds = { ...DEFAULT_ALERTS.kinds };
  for (const k of ALERT_KINDS) if (typeof o.kinds?.[k] === "boolean") kinds[k] = o.kinds[k] as boolean;
  const th = Number(o.errorThreshold);
  return {
    email: typeof o.email === "boolean" ? o.email : DEFAULT_ALERTS.email,
    telegram: typeof o.telegram === "boolean" ? o.telegram : DEFAULT_ALERTS.telegram,
    kinds, errorThreshold: Number.isFinite(th) ? Math.min(1000, Math.max(3, Math.round(th))) : DEFAULT_ALERTS.errorThreshold,
  };
}

export async function getAlertSettings(deps: Deps): Promise<AlertSettings> {
  return normalizeAlerts(await deps.store.getSetting(KEY));
}
export async function saveAlertSettings(deps: Deps, patch: unknown): Promise<AlertSettings> {
  const cur = await getAlertSettings(deps);
  const p = (patch ?? {}) as Partial<AlertSettings>;
  const next = normalizeAlerts({ ...cur, ...p, kinds: { ...cur.kinds, ...(p.kinds ?? {}) } });
  await deps.store.setSetting(KEY, next);
  ctxCache.delete(deps.store);
  return next;
}

async function context(deps: Deps): Promise<Ctx> {
  let cached = ctxCache.get(deps.store);
  if (cached && Date.now() - cached.at < 60_000) return cached;
  try {
    const [settings, admins] = await Promise.all([getAlertSettings(deps), deps.store.listAdmins(deps.config.adminEmails)]);
    // .env adminləri hələ qeydiyyatdan keçməyibsə də e-poçt alsınlar
    const missing = deps.config.adminEmails.filter((e) => !admins.some((u) => u.email === e)).map((email) => ({ id: email, email, passwordHash: "", verified: true, createdAt: new Date() }));
    cached = { settings, admins: [...admins.filter((u) => u.verified), ...missing], at: Date.now() };
    ctxCache.set(deps.store, cached);
  } catch {
    // baza cavab vermir: köhnə məlumatla davam (yoxdursa yalnız .env adminlərinə e-poçt)
    if (!cached) { cached = { settings: DEFAULT_ALERTS, admins: deps.config.adminEmails.map((email) => ({ id: email, email, passwordHash: "", verified: true, createdAt: new Date() })), at: 0 }; ctxCache.set(deps.store, cached); }
  }
  return cached;
}

/**
 * Xəbərdarlıq göndərir. key: eyni hadisənin təkrarını ayırmaq üçün (məs. müştəri ID). force: test, ayar və gözləmə vaxtı yoxlanmır.
 * Heç vaxt xəta atmır: xəbərdarlıq sistemi əsas işi yıxmamalıdır.
 */
export async function sendAlert(deps: Deps, kind: AlertKind | "test" | "ai", key: string, title: string, body: string, opts: { force?: boolean; only?: User[] } = {}): Promise<{ telegram: number; email: number; skipped?: string }> {
  try {
    const { settings, admins } = await context(deps);
    if (!opts.force && kind !== "test" && kind !== "ai" && !settings.kinds[kind]) return { telegram: 0, email: 0, skipped: "off" };
    const id = `${kind}:${key}`;
    const cd = kind === "test" || kind === "ai" ? 0 : COOLDOWN_MS[kind];
    if (!opts.force && cd && Date.now() - (last.get(id) ?? 0) < cd) return { telegram: 0, email: 0, skipped: "cooldown" };
    while (sentTimes.length && Date.now() - sentTimes[0]! > 60 * 60_000) sentTimes.shift();
    if (!opts.force && sentTimes.length >= HOURLY_CAP) return { telegram: 0, email: 0, skipped: "cap" };
    last.set(id, Date.now());
    sentTimes.push(Date.now());

    const to = opts.only ?? admins;
    const text = `⚠️ ${title}\n\n${body}${deps.config.allowedOrigins[0] ? `\n\n${deps.config.allowedOrigins[0]}/admin` : ""}`;
    let tg = 0, em = 0;
    if (settings.telegram && notifyAvailable(deps)) {
      for (const u of to) {
        if (!u.tgNotify?.chatId) continue;
        const r = await sendNotify(deps, u.tgNotify.chatId, text);
        if (r === "ok") tg++;
        else if (r === "gone") await deps.store.updateUser(u.id, { tgNotify: null }).catch(() => {});
      }
    }
    // E-poçt: Telegram seçilməyibsə, bot qoşulmayıbsa və ya heç bir admin Telegram bağlamayıbsa da gedir (xəbər itməsin)
    if (settings.email || tg === 0) {
      for (const u of to) {
        try { await deps.mailer.send(u.email, `[Admin] ${title}`, text.replace(/^⚠️ /, "")); em++; } catch { /* loggedMailer jurnala yazır */ }
      }
    }
    log.push({ at: new Date(), kind, title, telegram: tg, email: em });
    if (log.length > 50) log.shift();
    return { telegram: tg, email: em };
  } catch (e) {
    console.warn("[alerts] göndərilmədi:", e instanceof Error ? e.message : e);
    return { telegram: 0, email: 0, skipped: "error" };
  }
}

/** Servis yoxlaması: ardıcıl 2 uğursuz yoxlamada "əlçatmaz", ilk uğurlu yoxlamada "bərpa olundu". */
async function checkService(deps: Deps, name: "ai" | "db", fn: () => Promise<unknown>) {
  const s = health[name];
  const label = name === "ai" ? "AI servisi" : "Verilənlər bazası";
  try {
    await fn();
    if (s.down) {
      const mins = Math.max(1, Math.round((Date.now() - s.since) / 60_000));
      s.down = false; s.fails = 0; s.since = 0;
      await sendAlert(deps, "health", `${name}:up`, `${label} bərpa olundu`, `${label} yenidən cavab verir (təxminən ${mins} dəqiqə əlçatmaz idi).`);
    }
    s.fails = 0;
  } catch (e) {
    s.fails++;
    if (!s.down && s.fails >= 2) {
      s.down = true; s.since = Date.now();
      await sendAlert(deps, "health", `${name}:down`, `${label} cavab vermir`, `${label} ardıcıl ${s.fails} yoxlamada cavab vermədi: ${e instanceof Error ? e.message.slice(0, 200) : String(e)}.\n\nVidjet ziyarətçilərə "çat hazırda cavab vermir" göstərir.`);
    }
  }
}

/** Son 15 dəqiqədə xəta həddi keçibsə (brauzer xətaları sayılmır) ən çox təkrarlanan xəta ilə birlikdə xəbər verir. */
async function checkErrors(deps: Deps) {
  const { settings } = await context(deps);
  if (!settings.kinds.errors) return;
  const rows = (await deps.store.listErrors({ since: new Date(Date.now() - ERROR_WINDOW_MS), limit: 1000 })).filter((e) => e.source !== "client");
  if (rows.length < settings.errorThreshold) return;
  const groups = new Map<string, { n: number; message: string; source: string }>();
  for (const e of rows) { const g = groups.get(e.fingerprint) ?? { n: 0, message: e.message, source: e.source }; g.n++; groups.set(e.fingerprint, g); }
  const top = [...groups.values()].sort((a, b) => b.n - a.n).slice(0, 3).map((g) => `• ${g.n}× [${g.source}] ${g.message.slice(0, 140)}`).join("\n");
  await sendAlert(deps, "errors", "spike", `Son 15 dəqiqədə ${rows.length} xəta`, `Hədd: ${settings.errorThreshold}. Ən çox təkrarlananlar:\n${top}`);
}

// ---- Claude/Gemini hesab problemləri ----
// Hər problem bir dəfə xəbər verilir (provayder + növ + başlama vaxtı); hər 3 saatda bir xatırladılır, düzələndə "bərpa olundu" gedir.
type ProviderIssue = { kind: string; message?: string; since: string; count?: number };
const providerSeen = new Map<string, { key: string; at: number }>();
const PROVIDER_NAME: Record<string, string> = { claude: "Claude (Anthropic)", gemini: "Gemini (Google)" };
const PROVIDER_FIX: Record<string, string> = {
  claude: "console.anthropic.com → Billing: balansı artır və ya avtomatik yükləməni (auto-reload) aç; limit üçün Limits bölməsinə bax.",
  gemini: "aistudio.google.com → Billing: balansı artır (Prepay) və ya xərc limitini yoxla.",
};
const KIND_TEXT: Record<string, string> = {
  balance: "hesabda balans bitib", limit: "xərc limitinə çatılıb", auth: "API açarı qəbul olunmur (səhvdir, silinib və ya hesab bloklanıb)", quota: "sorğu kvotası dolub (çoxlu 429 xətası)",
};
const REMIND_MS = 3 * 60 * 60_000;

export async function checkProviders(deps: Deps) {
  const r = await deps.ai.providers();
  const issues = ((r as { providers?: Record<string, ProviderIssue> }).providers ?? {});
  for (const p of ["claude", "gemini"]) {
    const i = issues[p];
    const seen = providerSeen.get(p);
    if (!i) {
      if (seen) {
        providerSeen.delete(p);
        await sendAlert(deps, "provider", `${p}:ok:${seen.key}`, `${PROVIDER_NAME[p]} yenidən işləyir`, `${PROVIDER_NAME[p]} sorğuları yenidən uğurla cavablanır.`);
      }
      continue;
    }
    const key = `${i.kind}:${i.since}`;
    if (seen?.key === key && Date.now() - seen.at < REMIND_MS) continue;
    providerSeen.set(p, { key, at: Date.now() });
    const other = p === "claude" ? "gemini" : "claude";
    const fallback = issues[other]
      ? `Diqqət: ${PROVIDER_NAME[other]} də işləmir (${KIND_TEXT[issues[other]!.kind] ?? issues[other]!.kind}). Müştərilərin köməkçiləri cavab verə bilməyəcək.`
      : `Sorğular hələlik ehtiyat model (${PROVIDER_NAME[other]}) ilə cavablanır, amma keyfiyyət və xərc fərqli ola bilər.`;
    await sendAlert(deps, "provider", `${p}:${key}:${seen?.key === key ? "remind" : "new"}:${Math.floor(Date.now() / REMIND_MS)}`,
      `${PROVIDER_NAME[p]}: ${KIND_TEXT[i.kind] ?? i.kind}`,
      `${fallback}\n\nNə etməli: ${PROVIDER_FIX[p]}\n\nXəta: ${(i.message ?? "").slice(0, 240)}\nBaşlayıb: ${new Date(i.since).toLocaleString("az-AZ", { timeZone: "Asia/Baku" })}`);
  }
}

/** Bir yoxlama dövrü (testlərdə birbaşa çağırılır). */
export async function alertTick(deps: Deps) {
  await checkService(deps, "db", () => deps.store.countUsers({ ids: [] }));
  await checkService(deps, "ai", () => deps.ai.ping());
  if (!health.ai.down) await checkProviders(deps).catch(() => {});
  if (!health.db.down) await checkErrors(deps).catch(() => {});
  // Abunə xatırlatmaları: saatda bir dəfə (AI servisi hər abunə üçün bir dəfə qaytarır)
  if (!health.ai.down && Date.now() - remindAt >= 60 * 60_000) { remindAt = Date.now(); await sendPlanReminders(deps).catch(() => {}); }
  // Telegram botlarının tokeni: saatda bir (ləğv olunubsa sahib xəbər tutur)
  if (Date.now() - tgCheckAt >= 60 * 60_000) { tgCheckAt = Date.now(); await checkTelegramBots(deps).catch(() => {}); }
}
let remindAt = 0;
let tgCheckAt = 0;

/** Server açılanda: hər 2 dəqiqədən bir yoxlama. */
export function startAlertScheduler(deps: Deps, everyMs = 2 * 60_000) {
  let running = false;
  const tick = async () => { if (running) return; running = true; try { await alertTick(deps); } finally { running = false; } };
  const t = setInterval(() => { void tick(); }, everyMs);
  t.unref?.();
  return () => clearInterval(t);
}

// ---- Hadisə xəbərdarlıqları (kodun digər yerlərindən çağırılır) ----
const fmt = (n: unknown) => `${(Math.round((Number(n) || 0) * 100) / 100).toFixed(2)} AZN`;
export const alertTopupRequest = (deps: Deps, t: { tenantId: string; businessName: string; domain: string }, amountAzn: unknown, requestId: string) =>
  sendAlert(deps, "topup", requestId, `Yeni yükləmə sorğusu: ${fmt(amountAzn)}`, `${t.businessName} (${t.domain}) ${fmt(amountAzn)} yükləmək istəyir. Ödəniş gəlibsə "Ödənişlər" bölməsində təsdiqlə.`);
export const alertChannel = (deps: Deps, tenantId: string, businessName: string, channel: string, problem: string) =>
  sendAlert(deps, "channel", `${tenantId}:${channel}`, `${channel} bağlantısı qırıldı: ${businessName}`, `${problem}\n\nMüştəri paneldən yenidən qoşmalıdır. Vəziyyət: admin → "Kanallar".`);
export const alertDailyLimit = (deps: Deps, t: { tenantId: string; businessName: string; domain: string }) =>
  sendAlert(deps, "limit", `${t.tenantId}:${new Date().toISOString().slice(0, 10)}`, `Gündəlik limitə çatıldı: ${t.businessName}`, `${t.businessName} (${t.domain}) bu gün üçün xərc limitinə çatdı, çat sabaha qədər cavab vermir. Qəfil artım ola bilər (bot hücumu, səhv inteqrasiya). Limiti "İstifadəçilər" → "Balansı idarə et" bölməsindən dəyişmək olar.`);
export const alertOrder = (deps: Deps, t: { tenantId: string; businessName: string; domain: string }, o: Record<string, unknown>) =>
  sendAlert(deps, "topup", String(o.id ?? `${t.tenantId}:${Date.now()}`), o.kind === "pack" ? `Yeni paket sifarişi: ${fmt(o.amountAzn)}` : `Yeni plan sifarişi: ${String(o.plan ?? "")} · ${fmt(o.amountAzn)}`,
    `${t.businessName} (${t.domain}) ${o.kind === "pack" ? `əlavə paket (+${String(o.replies ?? "")} cavab)` : `“${String(o.plan ?? "")}” planı (${o.cycle === "year" ? "illik" : "aylıq"}${o.orderType === "upgrade" ? ", yüksəltmə" : o.orderType === "renew" ? ", yeniləmə" : ""})`} sifariş etdi: ${fmt(o.amountAzn)}. Ödəniş gəlibsə "Ödənişlər" bölməsində təsdiqlə.`);
