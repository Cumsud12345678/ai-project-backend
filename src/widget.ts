// Müştəri saytına qoyulan çat vidjeti: ictimai script + vidjet açarı ilə işləyən endpoint-lər.
// Gizli API açarı heç vaxt brauzerə çıxmır: vidjet yalnız ictimai açar (wk_...) göndərir,
// portal isə həmin müştəri üçün AI servisini öz service tokeni ilə çağırır.
import { notifyTeam } from "./team.js";
import { notifyOperators } from "./operator-notify.js";
import { forwardLead } from "./lead-forward.js";
import { publicConfirm } from "./action-card.js";
import { campaignRunning, liveOpenNow, parseHours, parseProactive } from "./helpdesk.js";
import { liveEventBase, runAutomations } from "./automations.js";
import { checkBase64Image, imageEnabled } from "./image-input.js";
import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import { Router, type RequestHandler } from "express";
import { AiError } from "./ai.js";
import type { Deps } from "./deps.js";
import { HttpError } from "./http.js";
import type { LiveChat, TenantRecord, WidgetImage, WidgetImageKind, WidgetSettings } from "./store/types.js";
import { cleanContact } from "./kb.js";
import { notifyBalance, notifyDailyLimit } from "./billing.js";
import { hub } from "./hub.js";
import { beat, pidOf, takeInvite, type ChatState } from "./presence.js";
import { isBlocked, parseVisitorInfo } from "./visitors.js";
import { checkFileSig } from "./live-files.js";

export const WIDGET_KEY_RE = /^wk_[a-f0-9]{32}$/;
export const newWidgetKey = () => `wk_${randomBytes(16).toString("hex")}`;

export const DEFAULT_GREETING = "Salam! Axtardığınız nəqliyyat vasitəsini və büdcənizi yazın, sizə uyğun elanları tapım.";
export const DEFAULT_COLOR = "#ea580c";
export const DEFAULT_GREETING_SUPPORT = "Salam! Sualınızı yazın, şirkətin məlumatlarına əsasən cavab verim.";
export const DEFAULT_LABEL = "AI-dan soruş";

export type Mode = "listings" | "support" | "both";
export const modeOf = (config: unknown): Mode => {
  const m = ((config as { profile?: { mode?: unknown } } | undefined)?.profile?.mode);
  return m === "support" || m === "both" ? m : "listings";
};

export const defaultWidget = (t: Pick<TenantRecord, "businessName"> & { config?: unknown }): WidgetSettings => ({
  key: newWidgetKey(), enabled: true, origins: [], title: t.businessName.slice(0, 60),
  greeting: modeOf(t.config) === "support" ? DEFAULT_GREETING_SUPPORT : DEFAULT_GREETING, color: DEFAULT_COLOR, label: DEFAULT_LABEL,
});

export const DEFAULT_LIMITS = { perVisitorDay: 30, siteHour: 0 } as const;
export const limitsOf = (w: Pick<WidgetSettings, "limits"> | undefined) => ({ ...DEFAULT_LIMITS, ...(w?.limits ?? {}) });

/** "https://www.Motoelan.com/elanlar" və ya "motoelan.com" -> "motoelan.com" */
export function bareHost(domain: string): string {
  const raw = domain.trim().toLowerCase();
  try { return new URL(/^[a-z][a-z0-9+.-]*:\/\//.test(raw) ? raw : `https://${raw}`).hostname.replace(/^www\./, ""); }
  catch { return raw.replace(/^www\./, ""); }
}

/** Sorğunun Origin-i müştərinin domenindən (və alt domenlərindən) və ya əlavə siyahıdan olmalıdır. */
export function originAllowed(origin: string | undefined, tenant: Pick<TenantRecord, "domain" | "widget">): boolean {
  if (!origin) return false;
  let u: URL;
  try { u = new URL(origin); } catch { return false; }
  if (u.protocol !== "https:" && u.protocol !== "http:") return false;
  if (tenant.widget?.origins.includes(u.origin)) return true;
  const d = bareHost(tenant.domain);
  if (!d || !d.includes(".")) return false;
  return u.hostname === d || u.hostname.endsWith(`.${d}`);
}

export const LOGO_MAX_BYTES = 100 * 1024;
/** Loqo: yalnız PNG/JPEG/WebP (SVG yoxdur: skript daşıya bilər), ölçü və başlıq baytları yoxlanır. */
export function parseLogo(body: unknown): WidgetImage {
  const b = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
  if (typeof b.data !== "string" || !b.data || b.data.length > Math.ceil(LOGO_MAX_BYTES * 1.4) + 64) throw new HttpError(400, "Loqo faylı çox böyükdür (maksimum 100 KB)", "LOGO_TOO_LARGE");
  const buf = Buffer.from(b.data, "base64");
  if (!buf.length || buf.length > LOGO_MAX_BYTES) throw new HttpError(400, "Loqo faylı çox böyükdür (maksimum 100 KB)", "LOGO_TOO_LARGE");
  const png = buf.length > 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  const jpeg = buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff;
  const webp = buf.length > 12 && buf.subarray(0, 4).toString("latin1") === "RIFF" && buf.subarray(8, 12).toString("latin1") === "WEBP";
  const mime = png ? "image/png" : jpeg ? "image/jpeg" : webp ? "image/webp" : null;
  if (!mime) throw new HttpError(400, "Loqo PNG, JPG və ya WebP olmalıdır", "LOGO_TYPE");
  return { mime, data: buf.toString("base64"), v: Date.now() };
}

/** Panel girişini yoxlayır; səhv varsa HttpError atır. */
export function parseWidgetPatch(body: unknown, current: WidgetSettings): WidgetSettings {
  const b = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
  const next = { ...current };
  if (b.enabled !== undefined) {
    if (typeof b.enabled !== "boolean") throw new HttpError(400, "enabled true/false olmalıdır");
    next.enabled = b.enabled;
  }
  if (b.title !== undefined) {
    if (typeof b.title !== "string" || !b.title.trim() || b.title.length > 60) throw new HttpError(400, "Başlıq 1-60 simvol olmalıdır");
    next.title = b.title.trim();
  }
  if (b.greeting !== undefined) {
    if (typeof b.greeting !== "string" || !b.greeting.trim() || b.greeting.length > 300) throw new HttpError(400, "Salamlama mesajı 1-300 simvol olmalıdır");
    next.greeting = b.greeting.trim();
  }
  if (b.label !== undefined) {
    if (typeof b.label !== "string" || b.label.length > 40) throw new HttpError(400, "Loqo yazısı ən çox 40 simvol ola bilər");
    next.label = b.label.trim();
  }
  if (b.color !== undefined) {
    if (typeof b.color !== "string" || !/^#[0-9a-fA-F]{6}$/.test(b.color)) throw new HttpError(400, "Rəng #rrggbb formatında olmalıdır");
    next.color = b.color.toLowerCase();
  }
  if (b.theme !== undefined) {
    if (b.theme !== "light" && b.theme !== "dark" && b.theme !== "auto") throw new HttpError(400, "Mövzu light, dark və ya auto olmalıdır");
    next.theme = b.theme;
  }
  if (b.origins !== undefined) {
    if (!Array.isArray(b.origins) || b.origins.length > 10) throw new HttpError(400, "Ən çox 10 əlavə ünvan əlavə edə bilərsən");
    const out = new Set<string>();
    for (const o of b.origins) {
      let u: URL | null = null;
      try { u = typeof o === "string" ? new URL(o.trim()) : null; } catch { /* aşağıda */ }
      if (!u || (u.protocol !== "https:" && u.protocol !== "http:") || u.origin === "null") throw new HttpError(400, `Ünvan düzgün deyil: ${String(o).slice(0, 80)} (məs. https://staging.saytin.az)`);
      out.add(u.origin);
    }
    next.origins = [...out];
  }
  if (b.live !== undefined) {
    const l = (b.live && typeof b.live === "object" ? b.live : null) as Record<string, unknown> | null;
    if (!l || typeof l.enabled !== "boolean") throw new HttpError(400, "live.enabled true/false olmalıdır");
    if (l.csat !== undefined && typeof l.csat !== "boolean") throw new HttpError(400, "live.csat true/false olmalıdır");
    next.live = { enabled: l.enabled, csat: l.csat !== undefined ? l.csat : current.live?.csat, hours: l.hours !== undefined ? parseHours(l.hours) : current.live?.hours ?? null };
    if (next.live.csat === undefined) delete next.live.csat;
  }
  if (b.proactive !== undefined) {
    next.proactive = parseProactive(b.proactive);
  }
  if (b.limits !== undefined) {
    const l = (b.limits && typeof b.limits === "object" ? b.limits : null) as Record<string, unknown> | null;
    if (!l) throw new HttpError(400, "limits obyekt olmalıdır");
    const cur = limitsOf(current);
    const val = (v: unknown, label: string, max: number) => {
      if (v === undefined) return undefined;
      if (typeof v !== "number" || !Number.isInteger(v) || v < 0 || v > max) throw new HttpError(400, `${label} 0 ilə ${max} arasında tam ədəd olmalıdır (0 = limitsiz)`);
      return v;
    };
    next.limits = { perVisitorDay: val(l.perVisitorDay, "Ziyarətçi limiti", 10_000) ?? cur.perVisitorDay, siteHour: val(l.siteHour, "Saytın saatlıq limiti", 1_000_000) ?? cur.siteHour };
  }
  return next;
}

// Elan sahələrindən yalnız vidjetin göstərdiyi sahələr və yalnız etibarlı URL-lər çıxır.
const httpUrl = (v: unknown) => (typeof v === "string" && /^https?:\/\//i.test(v) && v.length < 2000 ? v : undefined);
const str = (v: unknown, max = 200) => (typeof v === "string" ? v.slice(0, max) : undefined);
const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
function publicListing(l: Record<string, unknown>) {
  return {
    id: str(l.id, 100), title: str(l.title), make: str(l.make, 80), model: str(l.model, 80),
    price: num(l.price), currency: str(l.currency, 8), year: num(l.year), mileage: num(l.mileage),
    url: httpUrl(l.url), image: httpUrl(l.image),
  };
}

export const sha = (v: string) => createHash("sha256").update(v).digest();
export const sameToken = (token: unknown, hash: string) => typeof token === "string" && token.length <= 100 && timingSafeEqual(sha(token), Buffer.from(hash, "hex"));
/** Vidjetə yalnız ziyarətçinin görməli olduğu sahələr çıxır. */
const liveView = (c: LiveChat, after: number) => ({
  status: c.status, total: c.messages.length,
  // Ziyarətçinin öz şəkli: yalnız işarə. Operatorun faylı: ziyarətçi onu tokenlə ayrıca yükləyir (/live/:id/file).
  messages: c.messages.slice(after).map((m) => ({ from: m.from, text: m.text, at: m.at, ...(m.file && (m.from === "operator" ? { file: { id: m.file.id, mime: m.file.mime, ...(m.file.name && { name: m.file.name }) } } : { file: true })) })),
});
/** Səhifə yolu: yalnız "/..." və sorğu/hash olmadan; başlıq qısaldılır. */
const cleanPage = (v: unknown): { path: string; title?: string } | undefined => {
  if (!v || typeof v !== "object") return undefined;
  const o = v as { path?: unknown; title?: unknown };
  if (typeof o.path !== "string") return undefined;
  const path = (o.path.split(/[?#]/)[0] ?? "").trim().slice(0, 200);
  if (!path.startsWith("/") || /[\u0000-\u001f]/.test(path)) return undefined;
  const title = typeof o.title === "string" ? o.title.replace(/\s+/g, " ").trim().slice(0, 120) : "";
  return { path, ...(title && { title }) };
};
const cleanChat = (v: unknown) => (Array.isArray(v) ? v : []).slice(-10)
  .filter((m: unknown): m is { role: "user" | "model"; text: string } => !!m && typeof m === "object" && ((m as { role?: unknown }).role === "user" || (m as { role?: unknown }).role === "model") && typeof (m as { text?: unknown }).text === "string")
  .map((m) => ({ role: m.role, text: m.text.trim().slice(0, 600) })).filter((m) => m.text);

let scriptCache: { text: string; at: number } | undefined;
async function widgetScript(): Promise<string> {
  if (scriptCache && Date.now() - scriptCache.at < 60_000) return scriptCache.text;
  const text = await readFile(new URL("../widget/widget.js", import.meta.url), "utf8");
  scriptCache = { text, at: Date.now() };
  return text;
}

export const WIDGET_IMAGE_KINDS: readonly WidgetImageKind[] = ["logo", "avatar"];
export const imageUrl = (portalUrl: string, w: Pick<WidgetSettings, "key" | "logo" | "avatar">, kind: WidgetImageKind) => `${portalUrl}/widget/${w.key}/${kind}?v=${w[kind]?.v ?? 0}`;
export const logoUrl = (portalUrl: string, w: Pick<WidgetSettings, "key" | "logo">) => imageUrl(portalUrl, w, "logo");

/** /widget.js və /widget/:key/* — giriş (cookie) tələb etmir, brauzerdən müştəri saytından çağırılır. */
export function widgetRoutes(deps: Deps) {
  const { store, ai, limiter, mailer } = deps;
  const r = Router();

  r.get("/widget.js", async (_req, res, next) => {
    try {
      res.set({ "Content-Type": "application/javascript; charset=utf-8", "Cache-Control": "public, max-age=300" });
      res.send(await widgetScript());
    } catch (e) { next(e); }
  });

  // Açar -> müştəri; Origin yoxlanır; CORS başlıqları yalnız icazəli saytlara verilir.
  const access: RequestHandler = async (req, res, next) => {
    try {
      const key = String(req.params.key ?? "");
      const tenant = WIDGET_KEY_RE.test(key) ? await store.findTenantByWidgetKey(key) : null;
      // Admin hesabı dayandırıbsa vidjet saytda görünmür (eyni cavab: ziyarətçi səbəbi görmür)
      if (!tenant?.widget?.enabled || tenant.suspended) throw new HttpError(404, "Vidjet tapılmadı və ya söndürülüb", "WIDGET_OFF");
      const origin = req.get("origin");
      if (!originAllowed(origin, tenant)) throw new HttpError(403, "Bu saytdan vidjetə icazə yoxdur", "ORIGIN_NOT_ALLOWED");
      res.set({
        "Access-Control-Allow-Origin": origin!,
        Vary: "Origin",
        "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
        "Access-Control-Allow-Headers": "content-type",
        "Access-Control-Max-Age": "600",
      });
      res.locals.widgetTenant = tenant;
      if (req.method === "OPTIONS") return void res.status(204).end();
      next();
    } catch (e) { next(e); }
  };

  // Loqo (düymə) və profil şəkli (çatın içi): <img> ilə yüklənir (CORS lazım deyil). Yalnız aktiv vidjetin şəkli, keşlənir; skript icrası mümkün deyil.
  for (const kind of WIDGET_IMAGE_KINDS) r.get(`/widget/:key/${kind}`, async (req, res, next) => {
    try {
      const key = String(req.params.key ?? "");
      const tenant = WIDGET_KEY_RE.test(key) ? await store.findTenantByWidgetKey(key) : null;
      const logo = tenant?.widget?.enabled ? tenant.widget[kind] : undefined;
      if (!logo) throw new HttpError(404, kind === "logo" ? "Loqo tapılmadı" : "Profil şəkli tapılmadı", kind === "logo" ? "NO_LOGO" : "NO_AVATAR");
      res.set({
        "Content-Type": logo.mime, "Cache-Control": "public, max-age=86400", "Cross-Origin-Resource-Policy": "cross-origin",
        "Content-Security-Policy": "default-src 'none'; sandbox", "X-Content-Type-Options": "nosniff", "Content-Disposition": "inline",
      });
      res.send(Buffer.from(logo.data, "base64"));
    } catch (e) { next(e); }
  });

  r.options("/widget/:key/{*rest}", access);
  r.get("/widget/:key/config", access, (_req, res) => {
    const w = (res.locals.widgetTenant as TenantRecord).widget!;
    const wt = res.locals.widgetTenant as TenantRecord;
    const mode = modeOf(wt.config);
    // Quraşdırmanın işlədiyini göstərmək üçün: ən çox 10 dəqiqədən bir yazılır
    if (!w.lastSeenAt || Date.now() - new Date(w.lastSeenAt).getTime() > 10 * 60_000) void store.touchWidget(wt.tenantId, new Date()).catch(() => {});
    res.json({ title: w.title, greeting: w.greeting, color: w.color, label: w.label ?? DEFAULT_LABEL, mode, contact: true, live: liveOpenNow(wt), csat: w.live?.csat !== false, proactive: w.proactive?.enabled ? w.proactive.rules.filter((r) => campaignRunning(r, liveOpenNow(wt))).map((r) => ({ id: r.id, text: r.text, delaySec: r.delaySec, match: r.match, ...(r.title && { title: r.title }), ...(r.buttons?.length && { buttons: r.buttons }), ...(r.audience && r.audience !== "all" && { audience: r.audience }), ...(r.device && r.device !== "all" && { device: r.device }), ...(r.freq === "once" && { freq: "once" }) })) : [], // əlaqə forması: cavab tapılmayanda və ya balans bitəndə
      theme: w.theme ?? "light", brand: wt.brandRemoved ? null : { name: deps.config.brandName, url: deps.config.brandUrl }, imageSearch: imageEnabled(wt), presence: Boolean(w.live?.enabled), ...(w.logo && { logo: imageUrl(deps.config.publicPortalUrl, w, "logo") }), ...(w.avatar && { avatar: imageUrl(deps.config.publicPortalUrl, w, "avatar") }) });
  });

  // Operatorla əlaqə (cavab tapılmayanda): sayt ziyarətçisi telefon/e-poçt qoyur, sayt sahibi panelda görür və e-poçtla xəbər alır.
  r.post("/widget/:key/contact", access, async (req, res) => {
    const t = res.locals.widgetTenant as TenantRecord;
    const key = t.widget!.key, ip = req.ip ?? "unknown";
    if (!limiter.hit(`w:lead:${key}:${ip}`, 3, 10 * 60_000) || !limiter.hit(`w:leadday:${key}:${ip}`, 10, 24 * 60 * 60_000) || !limiter.hit(`w:leadkey:${key}`, 100, 60 * 60_000))
      throw new HttpError(429, "Çox sayda müraciət göndərdin, bir az sonra yenidən cəhd et", "RATE_LIMITED");
    const b = req.body ?? {};
    if (typeof b.website === "string" && b.website) return void res.json({ ok: true }); // bot tələsi: gizli sahə doldurulubsa sakitcə qəbul edilmiş kimi
    const contact = cleanContact(b.contact);
    if (!contact) throw new HttpError(400, "Düzgün telefon nömrəsi və ya e-poçt yazın", "BAD_CONTACT");
    const name = typeof b.name === "string" ? b.name.trim().slice(0, 80) : "";
    const question = typeof b.question === "string" ? b.question.trim().slice(0, 500) : "";
    // Söhbətin son hissəsi: sayt sahibi ziyarətçinin nə üçün operator istədiyini başa düşsün
    const conversation = (Array.isArray(b.chat) ? b.chat : []).slice(-10)
      .filter((m: unknown): m is { role: "user" | "model"; text: string } => !!m && typeof m === "object" && ((m as { role?: unknown }).role === "user" || (m as { role?: unknown }).role === "model") && typeof (m as { text?: unknown }).text === "string")
      .map((m: { role: "user" | "model"; text: string }) => ({ role: m.role, text: m.text.trim().slice(0, 600) })).filter((m: { text: string }) => m.text);
    try { await ai.kbAddLead(t.tenantId, { name, contact, question, conversation }); }
    catch (e) {
      if (e instanceof AiError) { console.warn(`[widget] lead ${t.tenantId}: ${e.status} ${e.message}`); throw new HttpError(502, "Müraciət göndərilə bilmədi, bir azdan yenidən cəhd et", "UNAVAILABLE"); }
      throw e;
    }
    // Telegram qrupu / Bitrix24 / webhook (qoşulubsa): ziyarətçini gözlətmir
    void forwardLead(deps, t, { source: "sayt", name, contact, question, conversation, ...(cleanPage(b.page)?.path && { page: cleanPage(b.page)!.path }) });
    // Sayt sahibinə bildiriş (alınmasa da müraciət panelda qalır)
    try {
      const owner = await store.findUserById(t.userId);
      if (owner) await mailer.send(owner.email, `Yeni müraciət: ${t.businessName}`, `Saytınızın çatından yeni müraciət var.\n\nAd: ${name || "-"}\nƏlaqə: ${contact}\nSual: ${question || "-"}${conversation.length ? `\n\nSöhbətin son hissəsi:\n${conversation.slice(-6).map((m: { role: string; text: string }) => `${m.role === "user" ? "Ziyarətçi" : "Çat"}: ${m.text.slice(0, 300)}`).join("\n")}` : ""}\n\nPanelin "Müraciətlər" bölməsində görə bilərsiniz.`);
    } catch (e) { console.warn("[widget] müraciət bildirişi göndərilmədi:", e instanceof Error ? e.message : e); }
    res.status(201).json({ ok: true });
  });

  r.post("/widget/:key/chat", access, async (req, res) => {
    const t = res.locals.widgetTenant as TenantRecord;
    const key = t.widget!.key;
    const ip = req.ip ?? "unknown";
    // Limitləri müştəri özü təyin edir (0 = limitsiz). Ziyarətçi anonim brauzer ID-si (vid) ilə tanınır, yoxdursa IP ilə:
    // eyni şəbəkədən (ofis, mobil operator) çox adam girəndə hamısı bir limiti bölüşməsin.
    const lim = limitsOf(t.widget);
    const vidRaw = (req.body as { vid?: unknown } | undefined)?.vid;
    const vid = typeof vidRaw === "string" && /^[a-f0-9]{16,32}$/.test(vidRaw) ? vidRaw : "";
    const who = vid ? `v:${vid}` : `ip:${ip}`;
    if (vid && isBlocked(t, `v:${pidOf(t.tenantId, vid)}`)) throw new HttpError(403, "Çat hazırda əlçatan deyil", "BLOCKED");
    // Sabit qoruyucular (bot/spam): dəqiqədə ziyarətçi başına 10, IP başına 60. Real insan bu həddə çatmır.
    if (!limiter.hit(`w:min:${key}:${who}`, 10, 60_000) || !limiter.hit(`w:ipmin:${key}:${ip}`, 60, 60_000))
      throw new HttpError(429, "Çox tez-tez mesaj göndərdin, bir az gözləyib yenidən yaz", "RATE_LIMITED");
    if (lim.perVisitorDay > 0) {
      // ID-ni hər dəfə yeniləyib limiti keçməyin qarşısı: IP üzrə gündəlik tavan (ziyarətçi limitinin 10 qatı, ən azı 300)
      if (!limiter.hit(`w:day:${key}:${who}`, lim.perVisitorDay, 24 * 60 * 60_000) || !limiter.hit(`w:ipday:${key}:${ip}`, Math.max(300, lim.perVisitorDay * 10), 24 * 60 * 60_000))
        throw new HttpError(429, "Bu gün üçün sual limitinə çatdınız", "VISITOR_LIMIT");
    }
    if (lim.siteHour > 0 && !limiter.hit(`w:key:${key}`, lim.siteHour, 60 * 60_000)) throw new HttpError(429, "Çat müvəqqəti məşğuldur, bir azdan yenidən cəhd et", "BUSY");

    const { message: msgRaw, history, sid: sidRaw, identity: identityRaw, image: imageRaw } = req.body ?? {};
    // Şəkilli sual: yalnız sahib açıbsa; ziyarətçi başına 10 dəqiqədə 6, sayt üzrə saatda 200 (xərc və sui-istifadə qoruması)
    let image: string | undefined;
    if (imageRaw !== undefined && imageRaw !== null && imageRaw !== "") {
      if (!imageEnabled(t)) throw new HttpError(400, "Şəkillə axtarış bu saytda söndürülüb", "IMAGE_OFF");
      if (!limiter.hit(`w:img:${key}:${who}`, 6, 10 * 60_000) || !limiter.hit(`w:imgkey:${key}`, 200, 60 * 60_000))
        throw new HttpError(429, "Çox şəkil göndərdin, bir az gözləyib yenidən cəhd et", "RATE_LIMITED");
      image = checkBase64Image(imageRaw) ?? undefined;
      if (!image) throw new HttpError(400, "Şəkil oxuna bilmədi (PNG, JPG və ya WebP, ən çox 2MB)", "BAD_IMAGE");
    }
    const message = typeof msgRaw === "string" ? msgRaw : image && msgRaw === undefined ? "" : msgRaw;
    const identity = typeof identityRaw === "string" && identityRaw.length <= 1000 && /^v1\.[\w-]+\.[\w-]+$/.test(identityRaw) ? identityRaw : undefined; // imzanı AI servisi yoxlayır; burada yalnız format
    const sid = typeof sidRaw === "string" && /^[a-f0-9]{16,32}$/.test(sidRaw) ? sidRaw : undefined;
    if (typeof message !== "string" || (!message.trim() && !image) || message.length > 500) throw new HttpError(400, "Mesaj 1-500 simvol olmalıdır");
    const clean = (Array.isArray(history) ? history : []).slice(-10)
      .filter((h: any) => h && (h.role === "user" || h.role === "model") && typeof h.text === "string")
      .map((h: any) => ({ role: h.role, text: h.text.slice(0, 2000) }));
    try {
      const out = await ai.chat(t.tenantId, message.trim(), clean, { sid, identity, channel: "widget", ...(image && { image }) });
      // Balans azalıb/bitibsə sayt sahibinə email (AI servisi eyni vəziyyət üçün yalnız bir dəfə xəbər verir)
      const notify = out.billing?.notify;
      if (notify === "low" || notify === "empty") void notifyBalance(deps, t, notify, out.billing?.balanceAzn);
      const listings = (Array.isArray(out.listings) ? out.listings : []).slice(0, 10).map(publicListing);
      const sources = (Array.isArray(out.sources) ? out.sources : []).slice(0, 3).map((s: Record<string, unknown>) => ({ title: str(s.title, 120) ?? "", url: httpUrl(s.url) }));
      const confirm = publicConfirm(out.confirm);
      res.json({ answer: String(out.answer ?? "").slice(0, 8000), listings, ...(confirm && { confirm }), ...(sources.length && { sources }), ...(typeof out.imageNote === "string" && out.imageNote && { imageNote: out.imageNote.slice(0, 200) }), ...(out.unanswered === true && { unanswered: true }), ...(out.identity === "invalid" && { identity: "invalid" }) });
    } catch (e) {
      // Ziyarətçi müştərinin limit və ya konfiqurasiya məlumatını görməməlidir.
      if (e instanceof AiError) {
        console.warn(`[widget] ${t.tenantId}: ${e.status} ${e.code ?? ""} ${e.message}`);
        // Balans bitib: ziyarətçiyə texniki təfərrüat göstərilmir, çat əlaqə formasına keçir (müraciət itmir)
        if (e.status === 402) {
          if (e.code === "DAILY_LIMIT") void notifyDailyLimit(deps, t);
          throw new HttpError(503, "Çat hazırda cavab vermir", "OFFLINE");
        }
        throw new HttpError(e.status === 429 || e.status === 503 ? 503 : 502, "Çat hazırda cavab verə bilmir, bir azdan yenidən cəhd et", "UNAVAILABLE");
      }
      throw e;
    }
  });

  // ---- Əməliyyat təsdiqi (BƏLİ/XEYR): parametrləri AI serveri saxlayır, brauzer onları dəyişə bilməz ----
  r.post("/widget/:key/action-confirm", access, async (req, res) => {
    const t = res.locals.widgetTenant as TenantRecord;
    const key = t.widget!.key, ip = req.ip ?? "unknown";
    const b = (req.body ?? {}) as { id?: unknown; decision?: unknown; sid?: unknown; identity?: unknown; vid?: unknown };
    const vid = typeof b.vid === "string" && /^[a-f0-9]{16,32}$/.test(b.vid) ? b.vid : "";
    if (!limiter.hit(`w:act:${key}:${vid ? `v:${vid}` : `ip:${ip}`}`, 10, 10 * 60_000) || !limiter.hit(`w:actip:${key}:${ip}`, 30, 10 * 60_000))
      throw new HttpError(429, "Çox tez-tez cəhd etdiniz, bir az gözləyin", "RATE_LIMITED");
    if (typeof b.id !== "string" || !/^[0-9a-f]{32}$/.test(b.id) || (b.decision !== "confirm" && b.decision !== "cancel") || typeof b.sid !== "string" || !/^[a-f0-9]{16,32}$/.test(b.sid))
      throw new HttpError(400, "Sorğu düzgün deyil", "BAD_REQUEST");
    const identity = typeof b.identity === "string" && b.identity.length <= 1000 && /^v1\.[\w-]+\.[\w-]+$/.test(b.identity) ? b.identity : undefined;
    try {
      const out = await ai.actionConfirm(t.tenantId, { id: b.id, decision: b.decision, sid: b.sid, ...(identity && { identity }) });
      const status = ["done", "failed", "unknown", "cancelled", "expired", "denied"].includes(out.status) ? out.status : "failed";
      res.json({ status, message: String(out.message ?? "").slice(0, 400) });
    } catch (e) {
      if (e instanceof AiError && e.code === "AI_UNREACHABLE") return void res.json({ status: "unknown", message: "Əməliyyatın icra olunub-olunmadığı bəlli deyil. Təkrar etməyin, operatorla yoxlayın." });
      if (e instanceof AiError) { console.warn(`[widget] action ${t.tenantId}: ${e.status} ${e.message}`); throw new HttpError(503, "Əməliyyat təsdiqlənə bilmədi, əməliyyat icra olunmayıb. Bir az sonra yenidən cəhd edin.", "UNAVAILABLE"); }
      throw e;
    }
  });

  // ---- "İndi saytda kim var" ----
  // Vidjet açıq tabda 15 saniyədən bir xəbər verir. Cavabda (varsa) operatorun dəvəti qayıdır: canlı söhbətin id və tokeni (yalnız bu ziyarətçiyə, bir dəfə).
  const CHAT_STATES: ChatState[] = ["none", "ai", "live"];
  const lastPush = new Map<string, number>();
  r.post("/widget/:key/presence", access, async (req, res) => {
    const t = res.locals.widgetTenant as TenantRecord;
    if (!t.widget?.live?.enabled) return void res.json({});
    const key = t.widget.key, ip = req.ip ?? "unknown";
    if (!limiter.hit(`w:pres:${key}:${ip}`, 30, 60_000) || !limiter.hit(`w:preskey:${key}`, 6000, 60_000)) return void res.status(429).json({});
    const b = req.body ?? {};
    const vid = typeof b.vid === "string" && /^[a-f0-9]{16,32}$/.test(b.vid) ? b.vid : "";
    if (!vid) throw new HttpError(400, "vid düzgün deyil");
    const str = (v: unknown, n: number) => (typeof v === "string" ? v.replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, n) : "");
    const page = cleanPage({ path: b.path, title: b.title });
    let ref = "";
    try {
      const u = new URL(str(b.ref, 300)), own = req.get("origin") ? new URL(req.get("origin")!).hostname : "";
      if ((u.protocol === "https:" || u.protocol === "http:") && u.hostname !== own) ref = u.hostname; // saytın öz səhifələri mənbə sayılmır
    } catch { /* yoxdur */ }
    if (isBlocked(t, `v:${pidOf(t.tenantId, vid)}`)) return void res.json({});
    const out = beat(t.tenantId, vid, {
      ...parseVisitorInfo(b),
      path: page?.path ?? "/", title: page?.title ?? "", ref, lang: str(b.lang, 12), mobile: b.mobile === true,
      chat: CHAT_STATES.includes(b.chat) ? b.chat : "none",
      ...(typeof b.sid === "string" && /^[a-f0-9]{16,32}$/.test(b.sid) && { sid: b.sid }),
      ...(b.hidden === true && { hidden: true }),
    });
    if (!out) return void res.json({});
    // Yeni ziyarətçi: panel siyahını dərhal yeniləsin (sayt üzrə 3 saniyədə bir siqnal)
    if (out.isNew && Date.now() - (lastPush.get(t.tenantId) ?? 0) > 3000) { lastPush.set(t.tenantId, Date.now()); hub.toOperators(t.tenantId, { t: "visitors", fresh: true, returning: Number(b.visits) > 1 }); }
    const inv = takeInvite(t.tenantId, out.pid);
    res.json(inv ? { invite: inv } : {});
  });

  // ---- Canlı operator söhbəti ----
  // Ziyarətçi söhbəti başladanda gizli token alır (yalnız hash-i saxlanır). Sonra bu token ilə mesaj göndərir və yeni mesajları oxuyur.
  r.post("/widget/:key/live", access, async (req, res) => {
    const t = res.locals.widgetTenant as TenantRecord;
    if (!t.widget?.live?.enabled) throw new HttpError(404, "Canlı söhbət söndürülüb", "LIVE_OFF");
    if (!liveOpenNow(t)) throw new HttpError(409, "Operatorlar hazırda işləmir, əlaqə qoyun", "OUTSIDE_HOURS");
    const key = t.widget.key, ip = req.ip ?? "unknown";
    if (!limiter.hit(`w:live:${key}:${ip}`, 5, 10 * 60_000) || !limiter.hit(`w:liveday:${key}:${ip}`, 20, 24 * 60 * 60_000) || !limiter.hit(`w:livekey:${key}`, 200, 60 * 60_000))
      throw new HttpError(429, "Çox sayda söhbət başladıldı, bir az sonra yenidən cəhd et", "RATE_LIMITED");
    const b = req.body ?? {};
    if (typeof b.website === "string" && b.website) return void res.json({ id: "x", token: "x", status: "open", total: 0, messages: [] }); // bot tələsi
    const name = typeof b.name === "string" ? b.name.trim().slice(0, 80) : "";
    const contactRaw = typeof b.contact === "string" ? b.contact.trim() : "";
    const contact = contactRaw ? cleanContact(contactRaw) : "";
    if (contactRaw && !contact) throw new HttpError(400, "Düzgün telefon nömrəsi və ya e-poçt yazın", "BAD_CONTACT");
    const text = typeof b.message === "string" ? b.message.trim().slice(0, 1000) : "";
    const vid = typeof b.vid === "string" && /^[a-f0-9]{16,32}$/.test(b.vid) ? b.vid : "";
    const pid = vid ? pidOf(t.tenantId, vid) : "";
    if (pid && isBlocked(t, `v:${pid}`)) throw new HttpError(403, "Çat hazırda əlçatan deyil", "BLOCKED");
    const token = randomBytes(24).toString("hex");
    const now = new Date();
    const chat: LiveChat = {
      id: randomUUID(), tenantId: t.tenantId, tokenHash: sha(token).toString("hex"), name, contact: contact || "", status: "open",
      context: cleanChat(b.chat), ...(cleanPage(b.page) && { page: cleanPage(b.page) }), messages: text ? [{ from: "visitor", text, at: now }] : [], createdAt: now, updatedAt: now, visitorSeenAt: now,
      ...(pid && { visitor: { pid, ...parseVisitorInfo(b), ...(typeof b.lang === "string" && { lang: b.lang.slice(0, 12) }), ...(typeof b.mobile === "boolean" && { mobile: b.mobile }) } }),
    };
    await store.createLive(chat);
    // Sayt sahibinə və komandaya bildiriş (10 dəqiqədə bir, spam olmasın)
    void notifyTeam(deps, t, `Canlı söhbət: ${t.businessName}`, `Saytınızın çatında ziyarətçi operatorla yazışmaq istəyir.${text ? `\n\nİlk mesaj: ${text.slice(0, 300)}` : ""}\n\nPanelin "Müraciətlər" bölməsində "Canlı söhbət" tabını açın.`);
    hub.toOperators(t.tenantId, { t: "live", id: chat.id, kind: "start", by: "visitor" });
    void notifyOperators(deps, t, { kind: "start", chatId: chat.id, channel: "sayt", name, text });
    res.status(201).json({ id: chat.id, token, ...liveView(chat, 0) });
  });

  // Bir sorğuda: (varsa) mesajı göndər + `after`-dan sonrakı yeni mesajları qaytar.
  r.post("/widget/:key/live/:id/sync", access, async (req, res) => {
    const t = res.locals.widgetTenant as TenantRecord;
    const b = req.body ?? {};
    const id = String(req.params.id ?? "");
    const chat = id.length <= 60 ? await store.getLive(t.tenantId, id) : null;
    if (!chat || !sameToken(b.token, chat.tokenHash)) throw new HttpError(404, "Söhbət tapılmadı", "LIVE_NOT_FOUND");
    if (!limiter.hit(`w:livesync:${id}`, 40, 60_000)) throw new HttpError(429, "Çox tez-tez sorğu", "RATE_LIMITED");
    if (chat.visitor && isBlocked(t, `v:${chat.visitor.pid}`)) throw new HttpError(403, "Çat hazırda əlçatan deyil", "BLOCKED");
    const after = Number.isInteger(b.after) && b.after >= 0 ? Math.min(b.after, 1000) : 0;
    let text = typeof b.text === "string" ? b.text.trim() : "";
    // Canlı söhbətdə şəkil (yalnız PNG/JPEG/WebP, ən çox 2 MB): baytlar ayrıca saxlanır, mesajda yalnız istinad qalır
    const img = b.image === undefined || b.image === null ? null : checkBase64Image(b.image);
    if (b.image !== undefined && b.image !== null && !img) throw new HttpError(400, "Şəkil PNG, JPG və ya WebP olmalıdır (ən çox 2 MB)", "BAD_IMAGE");
    if (img && !text) text = "📷";
    // Ziyarətçi çatdadır: 30 saniyədən tez yazmırıq (operator cavab verəndə e-poçt göndərilib-göndərilməməsini bu müəyyən edir)
    if (!chat.visitorSeenAt || Date.now() - chat.visitorSeenAt.getTime() > 30_000) await store.patchLive(t.tenantId, id, { visitorSeenAt: new Date() });
    if (text) {
      if (text.length > 1000) throw new HttpError(400, "Mesaj ən çox 1000 simvol ola bilər");
      if (chat.status === "closed") throw new HttpError(409, "Söhbət bağlanıb", "LIVE_CLOSED");
      if (!limiter.hit(`w:livemsg:${id}`, 10, 60_000)) throw new HttpError(429, "Çox tez-tez mesaj göndərdin", "RATE_LIMITED");
      let file: { id: string; mime: string } | undefined;
      if (img) {
        if (!limiter.hit(`w:liveimg:${id}`, 10, 10 * 60_000) || !limiter.hit(`w:liveimgkey:${t.widget!.key}`, 300, 60 * 60_000)) throw new HttpError(429, "Çox sayda şəkil göndərildi, bir az sonra yenidən cəhd edin", "RATE_LIMITED");
        const buf = Buffer.from(img, "base64");
        const mime = buf[0] === 0x89 ? "image/png" : buf[0] === 0xff ? "image/jpeg" : "image/webp";
        file = { id: randomUUID(), mime };
        await store.addLiveFile({ id: file.id, tenantId: t.tenantId, chatId: id, mime, data: img, at: new Date() });
      }
      const next = await store.pushLive(t.tenantId, id, { from: "visitor", text, at: new Date(), ...(file && { file }) });
      hub.toOperators(t.tenantId, { t: "live", id, kind: "message", by: "visitor" });
      void notifyOperators(deps, t, { kind: "message", chatId: id, channel: "sayt", name: chat.name, text });
      return void res.json(liveView(next ?? chat, after));
    }
    res.json(liveView(chat, after));
  });

  // Operatorun göndərdiyi fayl: yalnız söhbətin tokeni ilə, yalnız həmin söhbətin faylı
  r.post("/widget/:key/live/:id/file", access, async (req, res) => {
    const t = res.locals.widgetTenant as TenantRecord;
    const id = String(req.params.id ?? ""), b = req.body ?? {};
    const chat = id.length <= 60 ? await store.getLive(t.tenantId, id) : null;
    if (!chat || !sameToken(b.token, chat.tokenHash)) throw new HttpError(404, "Söhbət tapılmadı", "LIVE_NOT_FOUND");
    if (!limiter.hit(`w:livefile:${id}`, 60, 60_000)) throw new HttpError(429, "Çox tez-tez sorğu", "RATE_LIMITED");
    const fid = typeof b.fid === "string" ? b.fid.slice(0, 60) : "";
    const f = fid ? await store.getLiveFile(t.tenantId, fid) : null;
    if (!f || f.chatId !== chat.id) throw new HttpError(404, "Fayl tapılmadı", "FILE_NOT_FOUND");
    res.set({ "Content-Type": f.mime, "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff" });
    res.send(Buffer.from(f.data, "base64"));
  });
  // Telegram faylı bu müddətli imzalı linkdən özü yükləyir (deliverFileToChannel)
  r.get("/widget/f/:tid/:fid", async (req, res) => {
    const tid = String(req.params.tid ?? ""), fid = String(req.params.fid ?? "").slice(0, 60);
    if (!checkFileSig(deps.config.secretKey, tid, fid, req.query.e, req.query.s)) throw new HttpError(404, "Fayl tapılmadı", "FILE_NOT_FOUND");
    const f = await store.getLiveFile(tid, fid);
    if (!f) throw new HttpError(404, "Fayl tapılmadı", "FILE_NOT_FOUND");
    res.set({ "Content-Type": f.mime, "Cache-Control": "private, max-age=600", "X-Content-Type-Options": "nosniff", "Content-Disposition": f.name ? `inline; filename*=UTF-8''${encodeURIComponent(f.name)}` : "inline" });
    res.send(Buffer.from(f.data, "base64"));
  });

  // Söhbət bağlananda ziyarətçinin qiyməti (1-5): yalnız bağlı söhbət, token sahibi, bir dəfə
  r.post("/widget/:key/live/:id/csat", access, async (req, res) => {
    const t = res.locals.widgetTenant as TenantRecord;
    const b = req.body ?? {};
    const id = String(req.params.id ?? "");
    const chat = id.length <= 60 ? await store.getLive(t.tenantId, id) : null;
    if (!chat || !sameToken(b.token, chat.tokenHash)) throw new HttpError(404, "Söhbət tapılmadı", "LIVE_NOT_FOUND");
    if (!limiter.hit(`w:csat:${id}`, 12, 60 * 60_000)) throw new HttpError(429, "Çox tez-tez sorğu", "RATE_LIMITED");
    if (chat.status !== "closed") throw new HttpError(409, "Söhbət hələ bağlanmayıb", "LIVE_OPEN");
    if (chat.csat) throw new HttpError(409, "Qiymət artıq verilib", "CSAT_DONE");
    if (typeof b.rating !== "number" || !Number.isInteger(b.rating) || b.rating < 1 || b.rating > 5) throw new HttpError(400, "Qiymət 1-5 arası tam ədəd olmalıdır");
    const comment = typeof b.comment === "string" ? b.comment.replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, 300) : "";
    await store.patchLive(t.tenantId, id, { csat: { rating: b.rating, ...(comment && { comment }), at: new Date() } });
    hub.toOperators(t.tenantId, { t: "live", id, kind: "csat" });
    if (b.rating <= 2) void runAutomations(deps, t, { trigger: "bad_rating", source: "csat", rating: b.rating, ...liveEventBase(chat), ...(comment && { comment }) });
    res.status(201).json({ ok: true });
  });

  // Çatdakı kartın klikləndiyini sayır (hesabat üçün); məzmun saxlanmır
  r.post("/widget/:key/click", access, async (req, res) => {
    const t = res.locals.widgetTenant as TenantRecord;
    if (!limiter.hit(`w:click:${t.widget!.key}:${req.ip ?? "unknown"}`, 60, 60 * 60_000)) return void res.status(204).end();
    await store.addClick(t.tenantId, new Date());
    // Hansı söhbətdən hansı elana keçid olub: AI söhbətinə bağlanır (panel "elana keçdi" göstərir)
    const b = req.body ?? {};
    const sid = typeof b.sid === "string" && /^[a-f0-9]{16,32}$/.test(b.sid) ? b.sid : "";
    if (sid && (typeof b.id === "string" || typeof b.id === "number")) void ai.recordClick(t.tenantId, sid, { id: String(b.id).slice(0, 80), title: typeof b.title === "string" ? b.title.slice(0, 120) : "" }).catch(() => {});
    res.status(204).end();
  });

  // Kampaniya statistikası: kart göstərildi / klikləndi / söhbətə çevrildi. Məzmun saxlanmır.
  r.post("/widget/:key/campaign", access, async (req, res) => {
    const t = res.locals.widgetTenant as TenantRecord;
    const b = req.body ?? {};
    const id = typeof b.id === "string" && /^[a-f0-9]{8}$/.test(b.id) ? b.id : "";
    const ev = b.ev === "shown" ? "shown" : b.ev === "click" ? "clicked" : b.ev === "chat" ? "chats" : null;
    if (!id || !ev || !t.widget?.proactive?.rules.some((r) => r.id === id)) return void res.status(204).end();
    if (!limiter.hit(`w:camp:${t.widget.key}:${req.ip ?? "unknown"}:${ev}`, 30, 60 * 60_000)) return void res.status(204).end();
    await store.incCampaignStat(t.tenantId, id, ev);
    res.status(204).end();
  });

  // Cavaba 👍/👎. Sual və cavab mətni yalnız sorğu jurnalı açıqdırsa saxlanır.
  r.post("/widget/:key/feedback", access, async (req, res) => {
    const t = res.locals.widgetTenant as TenantRecord;
    const key = t.widget!.key, ip = req.ip ?? "unknown";
    if (!limiter.hit(`w:fb:${key}:${ip}`, 30, 24 * 60 * 60_000) || !limiter.hit(`w:fbkey:${key}`, 2000, 24 * 60 * 60_000)) throw new HttpError(429, "Çox sayda rəy göndərildi", "RATE_LIMITED");
    const b = req.body ?? {};
    if (b.rating !== 1 && b.rating !== -1) throw new HttpError(400, "rating 1 və ya -1 olmalıdır");
    const logOn = (t.config as { profile?: { logQueries?: unknown } }).profile?.logQueries !== false;
    await store.addFeedback({
      tenantId: t.tenantId, rating: b.rating, at: new Date(),
      question: logOn && typeof b.question === "string" ? b.question.trim().slice(0, 300) : "",
      answer: logOn && typeof b.answer === "string" ? b.answer.trim().slice(0, 600) : "",
    });
        if (b.rating === -1) void runAutomations(deps, t, { trigger: "bad_rating", source: "feedback", rating: -1, channel: "site", ...(logOn && typeof b.question === "string" && { question: b.question.trim().slice(0, 300) }), ...(logOn && typeof b.answer === "string" && { answer: b.answer.trim().slice(0, 600) }) });
    res.status(201).json({ ok: true });
  });

  return r;
}
