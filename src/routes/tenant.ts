import express, { Router } from "express";
import { deliverFileToChannel, deliverToChannel, startChannelLive } from "../channel-live.js";
import { parseOperatorFile } from "../live-files.js";
import { channelTexts, chatLang } from "../channel-i18n.js";
import { MAX_TEAM, memberTenant, nameOf, tenantFor, validEmail } from "../team.js";
import type { Deps } from "../deps.js";
import type { AiResult } from "../ai.js";
import { HttpError } from "../http.js";
import { notifyOrder, notifyTopupRequest, parseAmount } from "../billing.js";
import { FEATURE_KEYS, invalidateEntitlements, loadEntitlements } from "../plans.js";
import { getPublicPlans } from "../public-plans.js";
import { mailVisitorReply } from "../live.js";
import { exportCsv, funnel, type ExportKind } from "../stats.js";
import { hub } from "../hub.js";
import { getVisitor, hasInvite, listVisitors, setInvite } from "../presence.js";
import { randomBytes, randomUUID } from "node:crypto";
import { makeTicket, wsUrlOf } from "../realtime.js";
import { currentUser, requireAuth } from "../middleware.js";
import { type LiveChat, type TenantRecord, type User } from "../store/types.js";
import { DEFAULT_GREETING, DEFAULT_GREETING_SUPPORT, DEFAULT_LABEL, defaultWidget, modeOf, limitsOf, newWidgetKey, parseLogo, parseWidgetPatch, imageUrl, widgetColor, WIDGET_IMAGE_KINDS, sha } from "../widget.js";
import { blockOf, domainRoot, recordDomain } from "../domains.js";
import { createTenantFor, withoutSecrets } from "../tenant-create.js";
import { conversationSummary, liveSummary } from "../chat-summary.js";
import { FOLLOWUP_DELAYS, followupOf, parseFollowup } from "../followup.js";

const CONFIG_KEYS = ["businessName", "domain", "profile", "source", "apiSecret", "feedText"];
const PROFILE_KEYS = ["language", "tone", "maxResults", "extraInstructions", "logQueries", "mode", "fallbackMessage", "generalKnowledge", "kbAutoRefresh", "imageSearch", "answerLength", "agentName", "company"];

/** Müştərinin göndərdiyi JSON-dan yalnız tanınan sahələri götürür. */
function extractConfig(body: unknown): Record<string, unknown> {
  const cfg = (body as { config?: unknown } | undefined)?.config;
  if (!cfg || typeof cfg !== "object" || Array.isArray(cfg)) throw new HttpError(400, "Konfiqurasiya JSON obyekt olmalıdır");
  return Object.fromEntries(Object.entries(cfg).filter(([k]) => CONFIG_KEYS.includes(k)));
}

const publicTenant = (t: TenantRecord) => ({
  tenantId: t.tenantId, businessName: t.businessName, domain: t.domain, config: t.config,
  setup: { goals: t.setup?.goals ?? [], tested: Boolean(t.testedAt) },
  createdAt: t.createdAt, updatedAt: t.updatedAt, keyRotatedAt: t.keyRotatedAt ?? null,
  // Sahib panelində xəbərdarlıq göstərmək üçün (kim dayandırıb göstərilmir)
  suspended: t.suspended ? { at: t.suspended.at, reason: t.suspended.reason } : null,
});

/** Ziyarətçi yazıb, operator hələ cavab verməyib (və ya söhbəti açmayıb). */
const isWaiting = (c: LiveChat) => {
  const last = c.messages[c.messages.length - 1];
  return c.status === "open" && (!last || last.from === "visitor") && (!c.operatorSeenAt || c.operatorSeenAt < (last?.at ?? c.createdAt));
};
import { AiError } from "../ai.js";
import { liveOpenNow, parseCanned, parseTags } from "../helpdesk.js";
import { addBlock, blockKeyOfChat, isBlocked } from "../visitors.js";
import { chatClosedEvent, runAutomations } from "../automations.js";
import { buildReport } from "../reports.js";
import { buildCustomers, sessionPhone, type LeadLite } from "../customers.js";
const liveItem = (c: LiveChat) => {
  const last = c.messages[c.messages.length - 1];
  return { id: c.id, channel: c.channel?.type ?? null, assignee: c.assignee ? { id: c.assignee.userId, name: c.assignee.name } : null, name: c.name, contact: c.contact, status: c.status, createdAt: c.createdAt, updatedAt: c.updatedAt, count: c.messages.length, waiting: isWaiting(c), tags: c.tags ?? [], csat: c.csat?.rating ?? null, notes: c.notes?.length ?? 0, last: last ? { from: last.from, text: last.text.slice(0, 160), at: last.at } : null };
};

export function tenantRoutes(deps: Deps) {
  const { store, ai, limiter, config } = deps;
  // Operator sayı planın yerlərindən asılıdır (sahib də bir yerdir)
  const teamMax = async (tenantId: string) => Math.min(MAX_TEAM, Math.max(0, (await loadEntitlements(deps, tenantId)).seats - 1));
  const r = Router();
  r.use(requireAuth);

  const busy = new Set<string>();
  async function exclusive<T>(userId: string, fn: () => Promise<T>): Promise<T> {
    if (busy.has(userId)) throw new HttpError(409, "Əvvəlki əməliyyat hələ bitməyib, bir az gözlə");
    busy.add(userId);
    try { return await fn(); } finally { busy.delete(userId); }
  }
  const mine = async (userId: string) => {
    const t = await store.findTenantByUser(userId);
    if (!t) throw new HttpError(404, "Əvvəlcə elan mənbəyini qoş", "NO_TENANT");
    return t;
  };

  /** Sahib və ya komanda üzvü (operator): canlı söhbət marşrutları ikisinə də açıqdır. */
  const opTenant = async (user: User) => {
    const x = await tenantFor(store, user);
    if (!x) throw new HttpError(404, "Əvvəlcə elan mənbəyini qoş", "NO_TENANT");
    return x;
  };

  r.get("/", async (_req, res) => {
    const user = currentUser(res);
    const x = await tenantFor(store, user);
    if (x?.role === "operator") { // işçi yalnız ad və domen görür
      const o = x.tenant;
      return void res.json({ tenant: { tenantId: o.tenantId, businessName: o.businessName, domain: o.domain, config: {}, createdAt: o.createdAt, updatedAt: o.updatedAt, keyRotatedAt: null }, role: "operator", advisorUrl: config.publicAdvisorUrl });
    }
    res.json({ tenant: x ? publicTenant(x.tenant) : null, role: "owner", advisorUrl: config.publicAdvisorUrl });
  });

  // ---- Operator komandası (yalnız sahib) ----
  r.get("/team", async (_req, res) => {
    const t = await mine(currentUser(res).id);
    res.json({ max: await teamMax(t.tenantId), members: (t.team ?? []).map((m) => ({ email: m.email, joined: Boolean(m.userId), addedAt: m.addedAt })) });
  });
  r.post("/team", async (req, res) => {
    const user = currentUser(res);
    if (!limiter.hit(`team:add:${user.id}`, 20, 60 * 60_000)) throw new HttpError(429, "Çox tez-tez dəvət göndərirsən", "RATE_LIMITED");
    const t = await mine(user.id);
    const email = typeof req.body?.email === "string" ? req.body.email.trim().toLowerCase() : "";
    if (!validEmail(email)) throw new HttpError(400, "Düzgün e-poçt yaz");
    if (email === user.email.toLowerCase()) throw new HttpError(400, "Bu sənin öz e-poçtundur");
    const max = await teamMax(t.tenantId);
    if ((t.team ?? []).length >= max) throw new HttpError(400, max === 0 ? "Planınızda operator əlavə etmək yoxdur" : `Planınızda ən çox ${max} operator əlavə etmək olar`, "TEAM_FULL");
    if ((t.team ?? []).some((m) => m.email === email)) throw new HttpError(409, "Bu e-poçt artıq əlavə olunub", "TEAM_EXISTS");
    const other = await store.findUserByEmail(email);
    if (other && (await store.findTenantByUser(other.id))) throw new HttpError(409, "Bu istifadəçinin öz hesabı var, onu operator kimi əlavə etmək olmaz", "HAS_OWN_ACCOUNT");
    if (await store.findTenantByTeamEmail(email)) throw new HttpError(409, "Bu e-poçt başqa hesabın komandasındadır", "IN_OTHER_TEAM");
    const member = { email, ...(other?.verified && { userId: other.id }), addedAt: new Date() };
    await store.updateTenant(t.tenantId, { team: [...(t.team ?? []), member] });
    const panel = config.allowedOrigins[0] ?? "";
    void deps.mailer.send(email, `${t.businessName}: operator dəvəti`, `${t.businessName} sizi operator kimi əlavə etdi. Müştəri söhbətlərinə cavab vermək üçün bu e-poçtla ${other ? "daxil olun" : "qeydiyyatdan keçin"}:\n${panel}${other ? "/login" : "/register"}\n\nOperator yalnız canlı söhbətləri görür, hesab ayarlarına çıxışı olmur.`, { action: other ? "Daxil ol" : "Qeydiyyatdan keç", preheader: `${t.businessName} sizi komandaya dəvət etdi` }).catch(() => {});
    res.status(201).json({ ok: true });
  });
  r.delete("/team/:email", async (req, res) => {
    const t = await mine(currentUser(res).id);
    const email = decodeURIComponent(String(req.params.email)).toLowerCase();
    const m = (t.team ?? []).find((x) => x.email === email);
    if (!m) throw new HttpError(404, "Operator tapılmadı");
    await store.updateTenant(t.tenantId, { team: (t.team ?? []).filter((x) => x.email !== email) });
    if (m.userId) for (const c of await store.listLive(t.tenantId, "open", 200)) if (c.assignee?.userId === m.userId) await store.pushLive(t.tenantId, c.id, null, { assignee: null }); // götürdüyü söhbətlər sərbəst qalır
    hub.toOperators(t.tenantId, { t: "live", id: "", kind: "assign" });
    res.json({ ok: true });
  });

  // Yoxlama: heç nə yaratmır, yalnız konfiqurasiyanı və müştəri API-sinə bağlantını sınayır.
  // ---- Fayl/link ilə qoşulma (CSV, JSON, XML): API-siz onboarding ----
  r.post("/feed/preview", async (req, res) => {
    const user = currentUser(res);
    if (!limiter.hit(`feedprev:${user.id}`, 20, 10 * 60_000)) throw new HttpError(429, "Çox sınaq oldu, bir neçə dəqiqə sonra yenidən yoxla", "RATE_LIMITED");
    const b = (req.body ?? {}) as Record<string, unknown>;
    const body = Object.fromEntries(Object.entries(b).filter(([k]) => ["feedText", "url", "format", "itemsPath", "delimiter"].includes(k)));
    res.json(await ai.feedPreview(body));
  });
  r.get("/feed", async (_req, res) => {
    const t = await mine(currentUser(res).id);
    res.json(await ai.feedStatus(t.tenantId));
  });
  r.post("/feed/refresh", async (req, res) => {
    const user = currentUser(res);
    if (!limiter.hit(`feedref:${user.id}`, 10, 10 * 60_000)) throw new HttpError(429, "Çox tez-tez yeniləyirsən, bir az gözlə", "RATE_LIMITED");
    const t = await mine(user.id);
    const text = (req.body as { feedText?: unknown } | undefined)?.feedText;
    res.json(await exclusive(user.id, () => ai.feedRefresh(t.tenantId, typeof text === "string" ? { feedText: text } : {})));
  });

  r.post("/config/test", async (req, res) => {
    const user = currentUser(res);
    if (!limiter.hit(`cfgtest:${user.id}`, 60, 10 * 60_000)) throw new HttpError(429, "Çox sınaq oldu, bir neçə dəqiqə sonra yenidən yoxla", "RATE_LIMITED");
    // testFilters: sehirbazda bir filtri sınamaq üçün (məs. { "make": "Honda" }), yalnız sadə dəyərlər
    const tf = (req.body as { testFilters?: unknown } | undefined)?.testFilters;
    const testFilters = tf && typeof tf === "object" && !Array.isArray(tf)
      ? Object.fromEntries(Object.entries(tf as Record<string, unknown>).filter(([k, v]) => /^[A-Za-z][A-Za-z0-9]{0,40}$/.test(k) && ["string", "number", "boolean"].includes(typeof v)).slice(0, 10))
      : undefined;
    res.json(await ai.testConfig({ ...extractConfig(req.body), ...(testFilters && { testFilters }) }));
  });

  r.post("/config/sample", async (req, res) => {
    const user = currentUser(res);
    if (!limiter.hit(`cfgsample:${user.id}`, 40, 10 * 60_000)) throw new HttpError(429, "Çox sorğu oldu, bir neçə dəqiqə sonra yenidən yoxla", "RATE_LIMITED");
    const b = (req.body ?? {}) as Record<string, unknown>;
    const pick = ["url", "method", "body", "auth", "apiSecret"];
    res.json(await ai.fetchSample(Object.fromEntries(Object.entries(b).filter(([k]) => pick.includes(k)))));
  });

  r.post("/", async (req, res) => {
    const user = currentUser(res);
    const cfg = extractConfig(req.body);
    if (await blockOf(store, String(cfg.domain ?? ""))) throw new HttpError(403, "Bu domen üçün qeydiyyat bağlanıb. Səhv olduğunu düşünürsənsə, dəstəyə yaz.", "DOMAIN_BLOCKED");
    if (await store.findTenantByUser(user.id)) throw new HttpError(409, "Artıq aktiv mənbən var. Konfiqurasiyanı yeniləyə bilərsən.", "TENANT_EXISTS");
    if (await memberTenant(store, user)) throw new HttpError(409, "Sən başqa hesabın operatorusan, öz hesabını yaratmaq olmur", "IS_OPERATOR");
    const result = await exclusive(user.id, () => createTenantFor(deps, user, cfg));
    const t = await mine(user.id);
    void recordDomain(deps, t, user.email);
    res.status(201).json({ apiKey: result.apiKey, tenant: publicTenant(t), sampleListings: result.sampleListings ?? [] });
  });

  r.put("/config", async (req, res) => {
    const user = currentUser(res);
    const cfg = extractConfig(req.body);
    const t = await mine(user.id);
    const domainChanged = domainRoot(String(cfg.domain ?? "")) !== domainRoot(t.domain);
    if (domainChanged && await blockOf(store, String(cfg.domain ?? ""))) throw new HttpError(403, "Bu domen üçün qeydiyyat bağlanıb. Səhv olduğunu düşünürsənsə, dəstəyə yaz.", "DOMAIN_BLOCKED");
    const result = await exclusive(user.id, () => ai.updateConfig(t.tenantId, cfg));
    // Profil AI servisində birləşdirilir (JSON-da olmayan ayarlar, məs. rejim, saxlanır): panel həmin son vəziyyəti görməlidir
    const profile = result.profile && typeof result.profile === "object" ? result.profile : undefined;
    await store.updateTenant(t.tenantId, { config: { ...withoutSecrets(cfg), ...(profile && { profile }) }, businessName: String(cfg.businessName).trim(), domain: String(cfg.domain).trim() });
    const fresh = await mine(user.id);
    if (domainChanged) void recordDomain(deps, fresh, user.email);
    res.json({ tenant: publicTenant(fresh), sampleListings: result.sampleListings ?? [], ...(result.modeChanged === true && profile && { modeChanged: profile.mode }) });
  });

  // Sehirbazın "Məqsəd" addımı: serverdə saxlanır ki, hazırlıq göstəricisi hər cihazda və hər səhifədə eyni olsun
  r.put("/setup", async (req, res) => {
    const t = await mine(currentUser(res).id);
    const raw = (req.body as { goals?: unknown } | undefined)?.goals;
    const goals = Array.isArray(raw) ? [...new Set(raw.filter((g): g is "answer" | "catalog" => g === "answer" || g === "catalog"))] : [];
    if (!goals.length) throw new HttpError(400, "Ən azı bir məqsəd seç");
    await store.updateTenant(t.tenantId, { setup: { goals, at: new Date() } });
    res.json({ goals });
  });

  r.patch("/profile", async (req, res) => {
    const user = currentUser(res);
    const input = Object.fromEntries(Object.entries(req.body ?? {}).filter(([k]) => PROFILE_KEYS.includes(k)));
    const t = await mine(user.id);
    const result = await ai.patchProfile(t.tenantId, input);
    await store.updateTenant(t.tenantId, { config: { ...t.config, profile: result.profile } });
    // Rejim dəyişəndə dəyişdirilməmiş defolt salamlama yeni rejimə uyğunlaşdırılır
    const before = modeOf(t.config), after = modeOf({ profile: result.profile });
    if (t.widget && before !== after && (before === "support") !== (after === "support")) {
      const oldDefault = before === "support" ? DEFAULT_GREETING_SUPPORT : DEFAULT_GREETING;
      if (t.widget.greeting === oldDefault) await store.patchWidget(t.tenantId, { greeting: after === "support" ? DEFAULT_GREETING_SUPPORT : DEFAULT_GREETING });
    }
    res.json({ profile: result.profile });
  });

  r.post("/key/rotate", async (_req, res) => {
    const t = await mine(currentUser(res).id);
    const result = await ai.rotateKey(t.tenantId);
    await store.updateTenant(t.tenantId, { keyRotatedAt: new Date() });
    res.json({ apiKey: result.apiKey });
  });

  // ---- Çat vidjeti (müştəri saytına qoyulan script) ----
  const widgetOf = async (t: TenantRecord) => {
    if (t.widget) return t.widget;
    const widget = defaultWidget(t); // vidjetdən əvvəl yaradılmış hesablar üçün ilk dəfə açılanda yaradılır
    await store.updateTenant(t.tenantId, { widget });
    return widget;
  };
  const widgetView = (t: TenantRecord, widget: NonNullable<TenantRecord["widget"]>) => ({
    // Loqonun baytları panelə qayıtmır: yalnız ünvan
    widget: { ...widget, color: widgetColor(widget), colorSet: undefined, logo: undefined, avatar: undefined, logoUrl: widget.logo ? imageUrl(config.publicPortalUrl, widget, "logo") : null, avatarUrl: widget.avatar ? imageUrl(config.publicPortalUrl, widget, "avatar") : null, theme: widget.theme ?? "light", label: widget.label ?? DEFAULT_LABEL, limits: limitsOf(widget) }, scriptUrl: `${config.publicPortalUrl}/widget.js`, domain: t.domain, brandRemoved: Boolean(t.brandRemoved), brandName: config.brandName,
  });

  r.get("/widget", async (_req, res) => {
    const user = currentUser(res);
    const t = await mine(user.id);
    res.json(widgetView(t, await exclusive(user.id, () => widgetOf(t))));
  });

  r.put("/widget", async (req, res) => {
    const user = currentUser(res);
    const t = await mine(user.id);
    const next = await exclusive(user.id, async () => {
      const w = parseWidgetPatch(req.body, await widgetOf(t));
      // Yalnız ayar sahələri yazılır: eyni anda yüklənən loqo/profil şəkli köhnə nüsxə ilə üstünə yazılıb silinməsin
      const { logo: _l, avatar: _a, ...fields } = w;
      await store.patchWidget(t.tenantId, fields);
      return w;
    });
    res.json(widgetView(t, next));
  });

  // Loqo: tək atomik yazma ($set/$unset widget.logo). Bütün vidjet sənədini yenidən yazmırıq.
  const timed = (label: string, t0: number) => {
    const ms = Date.now() - t0;
    if (ms > 1500) console.warn(`[widget-logo] ${label} ${ms}ms (yavaş: əsasən baza gecikməsi)`);
  };
  // /widget/logo = çat düyməsi, /widget/avatar = çatın içindəki profil şəkli. Hər biri ayrıca saxlanır və silinir.
  for (const kind of WIDGET_IMAGE_KINDS) {
    r.put(`/widget/${kind}`, async (req, res) => {
      const t0 = Date.now();
      const user = currentUser(res);
      if (!limiter.hit(`logo:${user.id}`, 20, 10 * 60_000)) throw new HttpError(429, "Çox əməliyyat oldu, bir az gözləyin", "RATE_LIMITED");
      const t = await mine(user.id);
      const img = parseLogo(req.body);
      const base = await widgetOf(t);
      await store.setWidgetLogo(t.tenantId, img, kind);
      timed(`PUT ${kind}`, t0);
      res.json(widgetView(t, { ...base, [kind]: img }));
    });
    r.delete(`/widget/${kind}`, async (_req, res) => {
      const t0 = Date.now();
      const user = currentUser(res);
      const t = await mine(user.id);
      const rest = { ...(await widgetOf(t)) };
      delete rest[kind];
      await store.setWidgetLogo(t.tenantId, null, kind);
      timed(`DELETE ${kind}`, t0);
      res.json(widgetView(t, rest));
    });
  }

  // Köhnə açarla qoyulmuş scriptlər dərhal işləməyi dayandırır.
  r.post("/widget/rotate", async (_req, res) => {
    const user = currentUser(res);
    const t = await mine(user.id);
    const next = await exclusive(user.id, async () => {
      const w = { ...(await widgetOf(t)), key: newWidgetKey() };
      await store.patchWidget(t.tenantId, { key: w.key });
      return w;
    });
    res.json(widgetView(t, next));
  });

  // Panelin ilk səhifəsi: quraşdırma addımları, diqqət tələb edənlər, keyfiyyət göstəriciləri, ən çox verilən suallar
  r.get("/overview", async (_req, res) => {
    const t = await mine(currentUser(res).id);
    const mode = modeOf(t.config);
    const kbOn = mode !== "listings";
    const ok = <T,>(r: PromiseSettledResult<T>) => (r.status === "fulfilled" ? r.value : null);
    const since30 = new Date(Date.now() - 30 * 86_400_000);
    const [liveOpen, fb] = await Promise.all([store.listLive(t.tenantId, "open", 200).catch(() => []), store.feedbackCounts(t.tenantId, since30).catch(() => ({ up: 0, down: 0 }))]);
    const liveWaiting = liveOpen.filter(isWaiting).length;
    const [stats, kb, un, leads, billing] = (await Promise.allSettled([
      ai.queryStats(t.tenantId, 30),
      kbOn ? ai.kbInfo(t.tenantId) : Promise.resolve(null),
      kbOn ? ai.kbUnanswered(t.tenantId) : Promise.resolve(null),
      ai.kbLeads(t.tenantId), // əlaqə forması bütün rejimlərdə var (balans bitəndə ziyarətçi müraciət qoyur)
      ai.billing(t.tenantId),
    ])).map(ok) as [AiResult | null, AiResult | null, AiResult | null, AiResult | null, AiResult | null];

    const sources = (kb?.sources ?? []) as { status: string }[];
    // Hazırlıq: quraşdırma sehirbazının addımları ilə eyni (Məlumat → Sınaq → Yayım)
    const src = t.config.source as { type?: string } | undefined;
    const company = (t.config.profile as { company?: Record<string, unknown> } | undefined)?.company;
    const catalogReady = mode !== "support" && Boolean(src?.type);
    const kbReady = sources.some((s) => s.status === "ready") || Boolean(company && Object.values(company).some((v) => typeof v === "string" && v.trim()));
    const channels = { telegram: Boolean(t.telegram?.enabled), whatsapp: Boolean(t.whatsapp?.enabled) };
    const goals = t.setup?.goals ?? [];
    const week = Date.now() - 7 * 86_400_000;
    const unanswered7 = ((un?.items ?? []) as { at: string }[]).filter((x) => new Date(x.at).getTime() >= week).length;
    const failed = sources.filter((s) => s.status === "failed").length;
    const attention: { kind: string; count: number }[] = [];
    if (t.widget && !t.widget.enabled) attention.push({ kind: "widgetOff", count: 1 });
    if (liveWaiting > 0) attention.push({ kind: "live", count: liveWaiting });
    if (leads && leads.open > 0) attention.push({ kind: "leads", count: leads.open });
    if (unanswered7 > 0) attention.push({ kind: "unanswered", count: unanswered7 });
    if (failed > 0) attention.push({ kind: "sourceErrors", count: failed });
    if (!kbOn && stats && stats.noResults > 0) attention.push({ kind: "noResults", count: stats.noResults });

    const total = Number(stats?.total ?? 0), noResults = Number(stats?.noResults ?? 0), errors = Number(stats?.errors ?? 0);
    const since = Date.now() - 30 * 86_400_000;
    res.json({
      mode,
      limits: limitsOf(t.widget),
      live: { enabled: Boolean(t.widget?.live?.enabled), open: liveOpen.length, waiting: liveWaiting },
      feedback: fb,
      billing: billing ? { state: billing.state, balanceAzn: billing.balance?.totalAzn, freeAzn: billing.balance?.freeAzn, paidAzn: billing.balance?.paidAzn, monthAzn: billing.spend?.monthAzn, enforced: billing.enforced,
        // Abunə: üst zolaqda plan və limit göstərilir
        plan: billing.subscription ? { name: billing.subscription.planName, status: billing.subscription.status, used: billing.subscription.used, included: billing.subscription.included, packLeft: billing.packLeft ?? 0, end: billing.subscription.end } : null,
        trial: billing.trial ? { left: billing.trial.left, total: billing.trial.total, until: billing.trial.until } : null } : null,
      setup: {
        // both: elan mənbəyi VƏ YA bilik kifayətdir; listings: yalnız mənbə; support: yalnız bilik (və ya şirkət məlumatı)
        // Məqsəd seçilibsə sehirbazla eyni qayda: elan axtarışı seçilibsə kataloq, yalnız suallar seçilibsə bilik.
        // Seçilməyibsə (köhnə hesablar) rejimə görə.
        dataReady: goals.length ? (goals.includes("catalog") ? catalogReady : kbReady) : mode === "listings" ? catalogReady : mode === "support" ? kbReady : catalogReady || kbReady,
        goals, goalsSet: goals.length > 0,
        catalogReady, kbReady,
        tested: Boolean(t.testedAt) || total > 0,
        hasSite: !String(t.domain).toLowerCase().endsWith(".invalid"),
        channels,
        // Yayımda: vidjet saytda görünüb və ya Telegram/WhatsApp qoşulub (saytı olmayan müştəri üçün də)
        launched: Boolean(t.widget?.lastSeenAt) || channels.telegram || channels.whatsapp,
        dataCount: sources.filter((s) => s.status === "ready").length,
        widgetInstalled: Boolean(t.widget?.lastSeenAt),
        widgetEnabled: t.widget?.enabled ?? true,
        firstQuestion: total > 0,
        queriesLogged: stats?.enabled !== false,
      },
      attention,
      quality: {
        total, noResults, errors,
        answerRate: total > 0 ? Math.round(((total - noResults - errors) / total) * 100) : null,
        handoffs: ((leads?.items ?? []) as { at: string }[]).filter((x) => new Date(x.at).getTime() >= since).length || (kbOn ? 0 : null),
      },
      top: (stats?.top ?? []).slice(0, 5),
    });
  });


  // ---- Canlı operator söhbəti ----
  r.get("/live/count", async (_req, res) => {
    const { tenant: t } = await opTenant(currentUser(res));
    const open = await store.listLive(t.tenantId, "open", 200);
    // openNow: işçi saatları nəzərə alınmaqla ziyarətçiyə hazırda "Operatorla yaz" göstərilirmi
    res.json({ enabled: Boolean(t.widget?.live?.enabled), openNow: liveOpenNow(t), hasHours: Boolean(t.widget?.live?.hours), open: open.length, waiting: open.filter(isWaiting).length });
  });
  r.get("/live", async (req, res) => {
    const { tenant: t } = await opTenant(currentUser(res));
    const status = req.query.status === "closed" ? "closed" : "open";
    const items = (await store.listLive(t.tenantId, status, 100)).map(liveItem);
    const rated = items.filter((i) => typeof i.csat === "number") as { csat: number }[];
    res.json({ items, csat: { count: rated.length, avg: rated.length ? Math.round((rated.reduce((a, b) => a + b.csat, 0) / rated.length) * 10) / 10 : null } });
  });
  // Komandanın götürdüyü söhbət: "Mən götürürəm" / buraxmaq
  r.post("/live/:id/claim", async (req, res) => {
    const user = currentUser(res);
    const { tenant: t } = await opTenant(user);
    const chat = await store.getLive(t.tenantId, String(req.params.id));
    if (!chat || chat.status === "closed") throw new HttpError(404, "Söhbət tapılmadı", "LIVE_NOT_FOUND");
    await store.pushLive(t.tenantId, chat.id, null, { assignee: { userId: user.id, name: nameOf(user) }, operatorSeenAt: new Date() });
    hub.toOperators(t.tenantId, { t: "live", id: chat.id, kind: "assign" });
    res.json({ ok: true });
  });
  r.post("/live/:id/release", async (req, res) => {
    const { tenant: t } = await opTenant(currentUser(res));
    const chat = await store.getLive(t.tenantId, String(req.params.id));
    if (!chat) throw new HttpError(404, "Söhbət tapılmadı", "LIVE_NOT_FOUND");
    await store.pushLive(t.tenantId, chat.id, null, { assignee: null });
    hub.toOperators(t.tenantId, { t: "live", id: chat.id, kind: "assign" });
    res.json({ ok: true });
  });

  // Operator öz tərəfindən yazır: yalnız botla artıq yazışmış Telegram/WhatsApp müştərilərinə (soyuq mesaj yoxdur)
  r.get("/live/contacts", async (req, res) => {
    const { tenant: t } = await opTenant(currentUser(res));
    const list = await store.listChannelSessions(t.tenantId, 60);
    const items = list.filter((s) => (s.channel === "telegram" ? t.telegram?.enabled : t.whatsapp?.enabled) && (s.channel !== "whatsapp" || s.ref)).slice(0, 30).map((s) => {
      const last = [...s.history].reverse().find((m) => m.role === "user");
      return { channel: s.channel, chatId: s.chatId, name: s.name ?? "", last: last ? last.text.slice(0, 120) : "", updatedAt: s.updatedAt };
    });
    res.json({ items });
  });
  // Telegram/WhatsApp-da AI ilə gedən söhbətlər (operatora ötürülməmiş olanlar da): panelin "Kanallar" qovluqları üçün.
  // Əvvəl kanal qovluqlarında yalnız canlı (operator) söhbətlər görünürdü, botun cavab verdiyi yazışmalar heç yerdə çıxmırdı.
  r.get("/channel-chats", async (req, res) => {
    const { tenant: t } = await opTenant(currentUser(res));
    const want = req.query.channel === "telegram" ? "telegram" : req.query.channel === "whatsapp" ? "whatsapp" : null;
    const [sessions, open] = await Promise.all([store.listChannelSessions(t.tenantId, 200), store.listLive(t.tenantId, "open", 100)]);
    const liveOf = new Map(open.filter((c) => c.channel).map((c) => [`${c.channel!.type}:${c.channel!.chatId}`, c.id]));
    const items = sessions.filter((s) => !want || s.channel === want).slice(0, 100).map((s) => {
      const lastUser = [...s.history].reverse().find((m) => m.role === "user");
      const lastBot = [...s.history].reverse().find((m) => m.role === "model");
      return {
        channel: s.channel, chatId: s.chatId, sid: s.sid, name: s.name ?? "", ref: s.ref ?? "", phone: sessionPhone(s),
        // Bu müştəri ilə bütün söhbətlər (köhnədən yeniyə): panel hamısını ardıcıl göstərir
        sids: [...(s.prevSids ?? []).map((x) => x.sid), s.sid],
        last: lastUser ? lastUser.text.slice(0, 140) : "", lastAnswer: lastBot ? lastBot.text.slice(0, 140) : "",
        messages: s.history.length, updatedAt: s.updatedAt, liveId: liveOf.get(`${s.channel}:${s.chatId}`) ?? null,
        // Növbəti mesaja qədər qısa yaddaş (fallback): sorğu jurnalı söndürülübsə yazışma buradan göstərilir
        history: s.history.slice(-10),
      };
    });
    const day = Date.now() - 24 * 3600_000;
    const counts = { telegram: 0, whatsapp: 0 };
    for (const s of sessions) if (new Date(s.updatedAt).getTime() > day) counts[s.channel]++;
    res.json({ items, counts, enabled: { telegram: Boolean(t.telegram?.enabled), whatsapp: Boolean(t.whatsapp?.enabled) } });
  });

  r.post("/live/start", async (req, res) => {
    const user = currentUser(res);
    if (!limiter.hit(`live:start:${user.id}`, 20, 10 * 60_000)) throw new HttpError(429, "Çox tez-tez söhbət başladırsan", "RATE_LIMITED");
    const { tenant: t } = await opTenant(user);
    const channel = req.body?.channel === "telegram" ? "telegram" : req.body?.channel === "whatsapp" ? "whatsapp" : null;
    const chatId = typeof req.body?.chatId === "string" ? req.body.chatId : "";
    const text = typeof req.body?.text === "string" ? req.body.text.trim() : "";
    if (!channel || !chatId || !text || text.length > 1000) throw new HttpError(400, "Kanal, müştəri və 1-1000 simvolluq mesaj lazımdır");
    const existing = await store.findLiveByChannel(t.tenantId, channel, chatId);
    if (existing) return void res.json({ id: existing.id, existing: true });
    const sess = await store.getChannelSession(t.tenantId, channel, chatId);
    if (!sess) throw new HttpError(404, "Bu müştəri botla yazışmayıb: ona yalnız o yazandan sonra cavab vermək olar", "CONTACT_NOT_FOUND");
    const who = nameOf(user);
    const chat = await startChannelLive(deps, t, { channel, chatId, ...(sess.ref && { ref: sess.ref }), ...(sess.phone && { phone: sess.phone }), name: sess.name ?? "", history: sess.history, quiet: true });
    try { await deliverToChannel(deps, t, chat, text); }
    catch {
      await store.pushLive(t.tenantId, chat.id, { from: "system", text: "closed", at: new Date() }, { status: "closed" });
      throw new HttpError(502, channel === "telegram" ? "Mesaj Telegram-a göndərilə bilmədi" : "Mesaj WhatsApp-a göndərilə bilmədi", "CHANNEL_SEND_FAILED");
    }
    await store.pushLive(t.tenantId, chat.id, { from: "operator", text, at: new Date(), by: who }, { operatorSeenAt: new Date(), assignee: { userId: user.id, name: who } });
    hub.toOperators(t.tenantId, { t: "live", id: chat.id, kind: "start" });
    res.status(201).json({ id: chat.id });
  });

  // ---- Operator helpdesk: daxili qeydlər, etiketlər, hazır cavablar, AI qaralaması ----
  const hdChat = async (user: User, id: string) => {
    const x = await opTenant(user);
    const chat = await store.getLive(x.tenant.tenantId, id);
    if (!chat) throw new HttpError(404, "Söhbət tapılmadı", "LIVE_NOT_FOUND");
    return { t: x.tenant, chat };
  };
  r.post("/live/:id/notes", async (req, res) => {
    const user = currentUser(res);
    if (!limiter.hit(`live:note:${user.id}`, 40, 10 * 60_000)) throw new HttpError(429, "Çox tez-tez qeyd yazırsan", "RATE_LIMITED");
    const text = typeof req.body?.text === "string" ? req.body.text.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, " ").trim() : "";
    if (!text || text.length > 1000) throw new HttpError(400, "Qeyd 1-1000 simvol olmalıdır");
    const { t, chat } = await hdChat(user, String(req.params.id));
    if ((chat.notes?.length ?? 0) >= 50) throw new HttpError(400, "Bir söhbətdə ən çox 50 qeyd ola bilər", "NOTES_FULL");
    const notes = [...(chat.notes ?? []), { text, by: nameOf(user), at: new Date() }];
    await store.patchLive(t.tenantId, chat.id, { notes });
    hub.toOperators(t.tenantId, { t: "live", id: chat.id, kind: "note" });
    res.status(201).json({ notes });
  });
  r.put("/live/:id/tags", async (req, res) => {
    const user = currentUser(res);
    const tags = parseTags(req.body?.tags);
    const { t, chat } = await hdChat(user, String(req.params.id));
    await store.patchLive(t.tenantId, chat.id, { tags });
    hub.toOperators(t.tenantId, { t: "live", id: chat.id, kind: "tags" });
    res.json({ tags });
  });
  // Hazır cavablar: hamı oxuyur (operatorlar da), yalnız sahib dəyişir
  r.get("/canned", async (_req, res) => { const { tenant: t } = await opTenant(currentUser(res)); res.json({ items: t.canned ?? [] }); });
  r.put("/canned", async (req, res) => {
    const user = currentUser(res);
    const t = await mine(user.id);
    const items = parseCanned(req.body?.items);
    await store.updateTenant(t.tenantId, { canned: items });
    res.json({ items });
  });
  // AI qaralaması: operator mesajı özü yazır, AI yalnız təklif verir (heç nə ziyarətçiyə avtomatik getmir)
  r.post("/live/:id/draft", async (req, res) => {
    const user = currentUser(res);
    if (!limiter.hit(`live:draft:${user.id}`, 20, 10 * 60_000)) throw new HttpError(429, "Çox tez-tez qaralama istəyirsən", "RATE_LIMITED");
    const { t, chat } = await hdChat(user, String(req.params.id));
    if (!chat.messages.some((m) => m.from === "visitor")) throw new HttpError(400, "Ziyarətçi hələ yazmayıb", "NO_VISITOR_MESSAGE");
    try {
      const out = await ai.draft(t.tenantId, {
        messages: chat.messages.filter((m) => m.from !== "system").slice(-12).map((m) => ({ from: m.from, text: m.text.slice(0, 600) })),
        context: chat.context.slice(-6).map((m) => ({ role: m.role, text: m.text.slice(0, 400) })),
      });
      res.json({ draft: String(out.draft ?? "").slice(0, 1000) });
    } catch (e) {
      if (e instanceof AiError) throw new HttpError(e.status === 402 ? 402 : 502, e.status === 402 ? "Balans bitib, AI qaralaması mümkün deyil" : "AI qaralama hazırlaya bilmədi, bir az sonra yenidən cəhd et", e.code ?? "AI_FAILED");
      throw e;
    }
  });

  // AI xülasəsi: niyyət, əhval, etirazlar, növbəti addım (operator və sahib). Yeni mesaj yoxdursa saxlanmış nəticə, pulsuz.
  r.post("/live/:id/summary", async (req, res) => {
    const user = currentUser(res);
    const force = req.body?.force === true;
    const { t, chat } = await hdChat(user, String(req.params.id));
    // Limit yalnız AI çağırılanda: saxlanmış təzə xülasəni açmaq pulsuz və limitsizdir
    const fresh = chat.summary && chat.summary.count === chat.context.length + chat.messages.length;
    if ((force || !fresh) && !limiter.hit(`live:sum:${user.id}`, 20, 10 * 60_000)) throw new HttpError(429, "Çox tez-tez xülasə istəyirsən", "RATE_LIMITED");
    res.json(await liveSummary(deps, t.tenantId, chat, force));
  });

  r.get("/live/:id", async (req, res) => {
    const { tenant: t } = await opTenant(currentUser(res));
    const chat = await store.getLive(t.tenantId, String(req.params.id));
    if (!chat) throw new HttpError(404, "Söhbət tapılmadı", "LIVE_NOT_FOUND");
    const lastAt = (chat.messages[chat.messages.length - 1]?.at ?? chat.createdAt).getTime();
    // "Gördüm" işarəsi yalnız yeni mesaj gələndə yenilənir (operator panelinin təkrar sorğuları sıralamanı pozmasın)
    const c = !chat.operatorSeenAt || chat.operatorSeenAt.getTime() < lastAt ? (await store.pushLive(t.tenantId, chat.id, null, { operatorSeenAt: new Date() })) ?? chat : chat;
    // Eyni əlaqə (e-poçt/telefon) və ya eyni Telegram/WhatsApp söhbəti ilə əvvəlki yazışmalar: operator kontekst görsün
    const same = (o: LiveChat) => o.id !== c.id && ((c.contact && o.contact === c.contact) || (c.channel && o.channel?.type === c.channel.type && o.channel.chatId === c.channel.chatId));
    const previous = c.contact || c.channel
      ? [...(await store.listLive(t.tenantId, "closed", 300).catch(() => [])), ...(await store.listLive(t.tenantId, "open", 100).catch(() => []))]
        .filter(same).sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime()).slice(0, 5)
        .map((o) => ({ id: o.id, createdAt: o.createdAt, status: o.status, count: o.messages.length, tags: o.tags ?? [], csat: o.csat?.rating ?? null, first: o.messages[0]?.text.slice(0, 120) ?? "" }))
      : [];
    res.json({ chat: { id: c.id, name: c.name, contact: c.contact, status: c.status, context: c.context, messages: c.messages, createdAt: c.createdAt, channel: c.channel?.type ?? null, assignee: c.assignee ?? null, notes: c.notes ?? [], tags: c.tags ?? [], csat: c.csat ?? null, page: c.page ?? null, previous, visitor: c.visitor ? { ...c.visitor, pid: undefined } : null, blocked: isBlocked(t, blockKeyOfChat(c)),
      ...(c.summary && { summary: { ...c.summary, stale: c.summary.count !== c.context.length + c.messages.length } }) } });
  });
  // Canlı söhbətdə ziyarətçinin göndərdiyi şəkil: yalnız bu hesabın operatorları, yalnız həmin söhbətin faylı
  r.get("/live/:id/files/:fid", async (req, res) => {
    const { tenant: t } = await opTenant(currentUser(res));
    const f = await store.getLiveFile(t.tenantId, String(req.params.fid ?? "").slice(0, 60));
    if (!f || f.chatId !== String(req.params.id)) throw new HttpError(404, "Fayl tapılmadı", "FILE_NOT_FOUND");
    res.set({ "Content-Type": f.mime, "Cache-Control": "private, max-age=3600", "Content-Security-Policy": "default-src 'none'; sandbox", "X-Content-Type-Options": "nosniff", "Content-Disposition": f.name ? `inline; filename*=UTF-8''${encodeURIComponent(f.name)}` : "inline" });
    res.send(Buffer.from(f.data, "base64"));
  });

  // ---- İndi saytda kim var + operatorun ilk yazması ----
  r.get("/visitors", async (_req, res) => {
    const { tenant: t } = await opTenant(currentUser(res));
    const on = Boolean(t.widget?.live?.enabled);
    res.json({ enabled: on, items: on ? listVisitors(t.tenantId).map((v) => ({ ...v, invited: hasInvite(t.tenantId, v.pid) })) : [] });
  });
  r.post("/visitors/:pid/invite", async (req, res) => {
    const user = currentUser(res);
    if (!limiter.hit(`live:invite:${user.id}`, 30, 10 * 60_000)) throw new HttpError(429, "Çox tez-tez dəvət göndərirsən", "RATE_LIMITED");
    const { tenant: t } = await opTenant(user);
    if (!t.widget?.live?.enabled) throw new HttpError(409, "Canlı söhbət söndürülüb", "LIVE_OFF");
    const pid = String(req.params.pid ?? "");
    const text = typeof req.body?.text === "string" ? req.body.text.trim() : "";
    if (!text || text.length > 1000) throw new HttpError(400, "Mesaj 1-1000 simvol olmalıdır");
    const v = /^[a-f0-9]{16}$/.test(pid) ? getVisitor(t.tenantId, pid) : null;
    if (!v) throw new HttpError(404, "Ziyarətçi artıq saytda deyil", "VISITOR_GONE");
    if (v.chat === "live") throw new HttpError(409, "Bu ziyarətçi artıq operatorla yazışır", "VISITOR_IN_LIVE");
    if (hasInvite(t.tenantId, pid)) throw new HttpError(409, "Bu ziyarətçiyə artıq yazmısan, cavab gözlənilir", "ALREADY_INVITED");
    const who = nameOf(user), now = new Date(), token = randomBytes(24).toString("hex");
    // Ziyarətçi AI ilə yazışırdısa (operator söhbəti "ələ alır"): son yazışma kontekst kimi söhbətə düşür
    let context: LiveChat["context"] = [];
    if (v.sid) {
      try {
        const conv = await ai.conversation(t.tenantId, v.sid);
        const msgs = (Array.isArray(conv.messages) ? conv.messages : []) as { message?: unknown; answer?: unknown }[];
        context = msgs.slice(-5).flatMap((m) => [
          ...(typeof m.message === "string" && m.message ? [{ role: "user" as const, text: m.message.slice(0, 1000) }] : []),
          ...(typeof m.answer === "string" && m.answer ? [{ role: "model" as const, text: m.answer.slice(0, 1000) }] : []),
        ]).slice(-10);
      } catch { /* sorğu jurnalı söndürülüb və ya AI servisi cavab vermədi: kontekstsiz davam */ }
    }
    const chat: LiveChat = {
      id: randomUUID(), tenantId: t.tenantId, tokenHash: sha(token).toString("hex"), name: "", contact: "", status: "open", context,
      page: { path: v.path, ...(v.title && { title: v.title }) },
      visitor: { pid, ...(v.tz && { tz: v.tz }), ...(v.first && { first: v.first }), ...(v.visits && { visits: v.visits }), ...(v.lang && { lang: v.lang }), mobile: v.mobile, ...(v.ref && { ref: v.ref }) },
      messages: [{ from: "operator", text, at: now, by: who }], createdAt: now, updatedAt: now, operatorSeenAt: now, assignee: { userId: user.id, name: who },
    };
    await store.createLive(chat);
    setInvite(t.tenantId, pid, { id: chat.id, token }); // ziyarətçinin növbəti xəbərində (≤15 san) ona çatır
    hub.toOperators(t.tenantId, { t: "live", id: chat.id, kind: "start" });
    res.status(201).json({ id: chat.id });
  });

  // Real vaxt bağlantısı üçün qısa ömürlü bilet (panel WebSocket-i bununla açır; cookie portalın ünvanına getmir)
  r.post("/live/ws-ticket", async (req, res) => {
    const user = currentUser(res);
    if (!limiter.hit(`live:ticket:${user.id}`, 30, 60_000)) throw new HttpError(429, "Çox tez-tez sorğu", "RATE_LIMITED");
    await opTenant(user);
    res.json({ ticket: makeTicket(deps, user.id), url: wsUrlOf(config.publicPortalUrl) });
  });
  r.post("/live/:id/messages", async (req, res) => {
    const user = currentUser(res);
    if (!limiter.hit(`live:op:${user.id}`, 60, 60_000)) throw new HttpError(429, "Çox tez-tez mesaj göndərirsən", "RATE_LIMITED");
    const { tenant: t } = await opTenant(user);
    const text = typeof req.body?.text === "string" ? req.body.text.trim() : "";
    if (!text || text.length > 1000) throw new HttpError(400, "Mesaj 1-1000 simvol olmalıdır");
    const chat = await store.getLive(t.tenantId, String(req.params.id));
    if (!chat) throw new HttpError(404, "Söhbət tapılmadı", "LIVE_NOT_FOUND");
    if (chat.status === "closed") throw new HttpError(409, "Söhbət bağlanıb", "LIVE_CLOSED");
    // Kanal (Telegram/WhatsApp) söhbətində əvvəlcə çatdırılır: alınmasa mesaj yazılmır, operator xətanı görür
    if (chat.channel) {
      try { await deliverToChannel(deps, t, chat, text); }
      catch { throw new HttpError(502, chat.channel.type === "telegram" ? "Mesaj Telegram-a göndərilə bilmədi" : "Mesaj WhatsApp-a göndərilə bilmədi", "CHANNEL_SEND_FAILED"); }
    }
    const who = nameOf(user);
    const next = await store.pushLive(t.tenantId, chat.id, { from: "operator", text, at: new Date(), by: who }, { operatorSeenAt: new Date(), ...(!chat.assignee && { assignee: { userId: user.id, name: who } }) });
    void mailVisitorReply(deps, t, chat, text); // yalnız ziyarətçi çatdan ayrılıbsa və e-poçt yazıbsa
    const total = next?.messages.length ?? chat.messages.length;
    hub.toChat(chat.id, { t: "new", total });                                   // ziyarətçi dərhal oxuyur
    hub.toOperators(t.tenantId, { t: "live", id: chat.id, kind: "message" });   // operatorun digər tabları və komanda yenilənir
    res.status(201).json({ total: next?.messages.length ?? chat.messages.length });
  });
  // Operatorun faylı: şəkil və ya PDF (+ istəyə bağlı izah). Kanal söhbətində əvvəlcə kanala çatdırılır.
  r.post("/live/:id/files", async (req, res) => {
    const user = currentUser(res);
    if (!limiter.hit(`live:opfile:${user.id}`, 20, 10 * 60_000)) throw new HttpError(429, "Çox sayda fayl göndərdin, bir az gözlə", "RATE_LIMITED");
    const { tenant: t } = await opTenant(user);
    const f = parseOperatorFile(req.body);
    const caption = typeof req.body?.text === "string" ? req.body.text.trim().slice(0, 1000) : "";
    const chat = await store.getLive(t.tenantId, String(req.params.id));
    if (!chat) throw new HttpError(404, "Söhbət tapılmadı", "LIVE_NOT_FOUND");
    if (chat.status === "closed") throw new HttpError(409, "Söhbət bağlanıb", "LIVE_CLOSED");
    const id = randomUUID();
    if (chat.channel) {
      try { await deliverFileToChannel(deps, t, chat, { id, b64: f.b64, mime: f.mime, name: f.name, caption }); }
      catch { throw new HttpError(502, chat.channel.type === "telegram" ? "Fayl Telegram-a göndərilə bilmədi" : "Fayl WhatsApp-a göndərilə bilmədi", "CHANNEL_SEND_FAILED"); }
    }
    await store.addLiveFile({ id, tenantId: t.tenantId, chatId: chat.id, mime: f.mime, name: f.name, data: f.b64, at: new Date() });
    const who = nameOf(user);
    const text = caption || (f.mime === "application/pdf" ? `📄 ${f.name}` : "📷");
    const next = await store.pushLive(t.tenantId, chat.id, { from: "operator", text, at: new Date(), by: who, file: { id, mime: f.mime, name: f.name } }, { operatorSeenAt: new Date(), ...(!chat.assignee && { assignee: { userId: user.id, name: who } }) });
    const total = next?.messages.length ?? chat.messages.length;
    hub.toChat(chat.id, { t: "new", total });
    hub.toOperators(t.tenantId, { t: "live", id: chat.id, kind: "message" });
    res.status(201).json({ total });
  });
  // Bağlanmış söhbəti silmək (yalnız hesab sahibi; açıq söhbət əvvəl bağlanmalıdır)
  r.delete("/live/:id", async (req, res) => {
    const t = await mine(currentUser(res).id);
    const chat = await store.getLive(t.tenantId, String(req.params.id));
    if (!chat) throw new HttpError(404, "Söhbət tapılmadı", "LIVE_NOT_FOUND");
    if (chat.status === "open") throw new HttpError(409, "Açıq söhbəti silmək olmaz, əvvəl bağla", "LIVE_OPEN");
    await store.deleteLive(t.tenantId, chat.id);
    hub.toOperators(t.tenantId, { t: "live", id: chat.id, kind: "close" });
    res.json({ ok: true });
  });

  r.post("/live/:id/close", async (req, res) => {
    const { tenant: t } = await opTenant(currentUser(res));
    const chat = await store.getLive(t.tenantId, String(req.params.id));
    if (!chat) throw new HttpError(404, "Söhbət tapılmadı", "LIVE_NOT_FOUND");
    if (chat.status === "open") {
      await store.pushLive(t.tenantId, chat.id, { from: "system", text: "closed", at: new Date() }, { status: "closed", operatorSeenAt: new Date() });
      hub.toChat(chat.id, { t: "new", total: chat.messages.length + 1 });
      hub.toOperators(t.tenantId, { t: "live", id: chat.id, kind: "close" });
      void runAutomations(deps, t, chatClosedEvent(chat, nameOf(currentUser(res))));
      if (chat.channel) void deliverToChannel(deps, t, chat, channelTexts(chatLang(t, [...chat.messages].reverse().find((m) => m.from === "visitor")?.text ?? ""), 0, 0).live.back).catch(() => {}); // bot geri qayıtdı xəbəri (alınmasa vacib deyil)
    }
    res.json({ ok: true });
  });

  // 👍/👎: sayt ziyarətçilərinin cavablara rəyi
  r.get("/feedback", async (req, res) => {
    const t = await mine(currentUser(res).id);
    const days = Math.min(Math.max(Number(req.query.days) || 30, 1), 90);
    const since = new Date(Date.now() - days * 86_400_000);
    const [counts, rows] = await Promise.all([store.feedbackCounts(t.tenantId, since), store.feedbackSince(t.tenantId, since, 200)]);
    res.json({ days, ...counts, bad: rows.filter((f) => f.rating === -1 && f.question).slice(0, 20).map((f) => ({ at: f.at, question: f.question, answer: f.answer })) });
  });

  r.get("/usage", async (_req, res) => {
    res.json(await ai.usage((await mine(currentUser(res).id)).tenantId));
  });

  // Sayt istifadəçilərinin sualları (telefon/email maskalanıb, müddət bitəndə avtomatik silinir)
  const QUERY_PARAMS = ["limit", "noResults", "q", "days", "before"];
  r.get("/queries", async (req, res) => {
    const t = await mine(currentUser(res).id);
    const qs = new URLSearchParams();
    for (const k of QUERY_PARAMS) { const v = req.query[k]; if (typeof v === "string" && v) qs.set(k, v.slice(0, 100)); }
    res.json(await ai.queries(t.tenantId, qs.toString()));
  });
  r.get("/queries/stats", async (req, res) => {
    const t = await mine(currentUser(res).id);
    const days = Number(req.query.days);
    res.json(await ai.queryStats(t.tenantId, Number.isFinite(days) && days > 0 ? days : undefined));
  });
  // Söhbət tarixçəsi: suallar + AI cavabları söhbətlər üzrə qruplaşdırılır
  r.get("/conversations", async (req, res) => {
    const t = await mine(currentUser(res).id);
    const qs = new URLSearchParams();
    for (const k of ["limit", "days", "before"]) { const v = req.query[k]; if (typeof v === "string" && v) qs.set(k, v.slice(0, 40)); }
    res.json(await ai.conversations(t.tenantId, qs.toString()));
  });
  r.get("/conversations/:sid", async (req, res) => {
    const t = await mine(currentUser(res).id);
    res.json(await ai.conversation(t.tenantId, sid(req.params.sid)));
  });
  r.post("/conversations/:sid/summary", async (req, res) => {
    const user = currentUser(res);
    if (!limiter.hit(`conv:sum:${user.id}`, 30, 10 * 60_000)) throw new HttpError(429, "Çox tez-tez xülasə istəyirsən", "RATE_LIMITED");
    const t = await mine(user.id);
    res.json(await conversationSummary(deps, t.tenantId, sid(req.params.sid), req.body?.force === true));
  });
  // Konversiya: söhbətlərin neçəsi operatora/müraciətə çevrildi
  r.get("/funnel", async (req, res) => {
    const t = await mine(currentUser(res).id);
    const d = Number(req.query.days);
    res.json(await funnel(deps, t, Number.isFinite(d) && d > 0 ? Math.min(Math.round(d), 90) : 30));
  });
  // Hesabatlar: dövr (7/30/90 gün) + əvvəlki dövrlə müqayisə, gündəlik bölgü, komanda
  r.get("/reports", async (req, res) => {
    const t = await mine(currentUser(res).id);
    const d = Number(req.query.days);
    const days = [7, 30, 90].includes(d) ? d : 7;
    res.set("cache-control", "no-store").json(await buildReport(deps, t, days));
  });
  // Analitika: gündəlik trend + bəyənmə nisbəti (pulsuz), mövzu/boşluq təhlili (AI, sahib basanda)
  r.get("/insights/trend", async (req, res) => {
    const t = await mine(currentUser(res).id);
    const d = Number(req.query.days);
    const days = Number.isFinite(d) && d > 0 ? Math.min(Math.round(d), 90) : 30;
    const [trend, fb] = await Promise.all([ai.queryTrend(t.tenantId, days), store.feedbackCounts(t.tenantId, new Date(Date.now() - days * 86_400_000)).catch(() => ({ up: 0, down: 0 }))]);
    res.json({ days, enabled: trend.enabled !== false, daily: trend.daily ?? [], feedback: { up: fb.up, down: fb.down, satisfaction: fb.up + fb.down ? Math.round((fb.up / (fb.up + fb.down)) * 100) : null } });
  });
  r.post("/insights/analyze", async (req, res) => {
    const user = currentUser(res);
    if (!limiter.hit(`insights:${user.id}`, 6, 60 * 60_000)) throw new HttpError(429, "Təhlil çox tez-tez istənilir, bir az gözləyin", "RATE_LIMITED");
    const t = await mine(user.id);
    const d = Number(req.body?.days);
    const days = Number.isFinite(d) && d > 0 ? Math.min(Math.round(d), 90) : 30;
    const bad = (await store.feedbackSince(t.tenantId, new Date(Date.now() - days * 86_400_000), 200).catch(() => [])).filter((f) => f.rating === -1 && f.question).slice(0, 20).map((f) => f.question);
    res.json(await ai.insights(t.tenantId, { days, ...(req.body?.fresh === true && { fresh: true }), disliked: bad }));
  });
  // CSV ixracı (Excel/Google Sheets)
  r.get("/export/:kind", async (req, res) => {
    const user = currentUser(res);
    if (!limiter.hit(`export:${user.id}`, 10, 10 * 60_000)) throw new HttpError(429, "Çox tez-tez ixrac edirsən, bir az gözlə", "RATE_LIMITED");
    const kind = String(req.params.kind) as ExportKind;
    if (!["queries", "conversations", "leads", "unanswered", "live"].includes(kind)) throw new HttpError(400, "Yanlış ixrac növü");
    const t = await mine(user.id);
    const d = Number(req.query.days);
    const out = await exportCsv(deps, t, kind, Number.isFinite(d) && d > 0 ? Math.min(Math.round(d), 90) : 30);
    res.set({ "content-type": "text/csv; charset=utf-8", "content-disposition": `attachment; filename="${out.filename}"`, "x-truncated": out.truncated ? "1" : "0", "cache-control": "no-store" }).send(out.csv);
  });
  // ---- Müştəriyə məxsus məlumat (sifariş / ödəniş): sayt istifadəçisinə öz məlumatını göstərmək ----
  const pdWrite = (userId: string) => { if (!limiter.hit(`pd:${userId}`, 20, 10 * 60_000)) throw new HttpError(429, "Çox əməliyyat oldu, bir az gözləyin", "RATE_LIMITED"); };
  // ---- Susan müştəriyə xatırlatma (Telegram/WhatsApp) ----
  r.get("/followup", async (_req, res) => { const t = await mine(currentUser(res).id); res.json({ followup: followupOf(t), delays: FOLLOWUP_DELAYS }); });
  r.put("/followup", async (req, res) => {
    const t = await mine(currentUser(res).id);
    const followup = parseFollowup(req.body);
    await store.updateTenant(t.tenantId, { followup });
    res.json({ followup, delays: FOLLOWUP_DELAYS });
  });

  // ---- API-siz sifariş forması: AI söhbətdə sahələri soruşur, təsdiqdən sonra sifariş müraciətlər qutusuna düşür ----
  r.get("/order-form", async (_req, res) => { res.json(await ai.orderForm((await mine(currentUser(res).id)).tenantId)); });
  r.put("/order-form", async (req, res) => {
    const user = currentUser(res);
    if (!limiter.hit(`orderform:${user.id}`, 30, 10 * 60_000)) throw new HttpError(429, "Çox tez-tez yadda saxlayırsan, bir az gözlə", "RATE_LIMITED");
    res.json(await ai.setOrderForm((await mine(user.id)).tenantId, req.body ?? {}));
  });
  r.delete("/order-form", async (_req, res) => { res.json(await ai.deleteOrderForm((await mine(currentUser(res).id)).tenantId)); });

  r.get("/private-data", async (_req, res) => { res.json(await ai.privateData((await mine(currentUser(res).id)).tenantId)); });
  r.put("/private-data", async (req, res) => {
    const user = currentUser(res); pdWrite(user.id);
    const t = await mine(user.id);
    res.json(await ai.setPrivateData(t.tenantId, req.body ?? {}));
  });
  r.delete("/private-data", async (_req, res) => { const user = currentUser(res); pdWrite(user.id); res.json(await ai.deletePrivateData((await mine(user.id)).tenantId)); });
  r.post("/private-data/identity-secret", async (_req, res) => {
    const user = currentUser(res); pdWrite(user.id);
    res.set("cache-control", "no-store").status(201).json(await ai.newIdentitySecret((await mine(user.id)).tenantId));
  });
  r.post("/private-data/test", async (req, res) => {
    const user = currentUser(res); pdWrite(user.id);
    const b = (req.body ?? {}) as { kind?: unknown; userId?: unknown };
    if (typeof b.kind !== "string" || typeof b.userId !== "string") throw new HttpError(400, "kind və userId tələb olunur");
    res.set("cache-control", "no-store").json(await ai.testPrivateData((await mine(user.id)).tenantId, { kind: b.kind, userId: b.userId }));
  });

  // Girişsiz sifariş statusunun sınağı: sahib real sifariş nömrəsi və telefonla yoxlayır (nəticə maskalanmış)
  r.post("/private-data/lookup-test", async (req, res) => {
    const user = currentUser(res); pdWrite(user.id);
    const b = (req.body ?? {}) as { orderId?: unknown; phone?: unknown };
    if (typeof b.orderId !== "string" || typeof b.phone !== "string" || b.orderId.length > 60 || b.phone.length > 40) throw new HttpError(400, "Sifariş nömrəsi və telefon tələb olunur");
    res.set("cache-control", "no-store").json(await ai.testOrderLookup((await mine(user.id)).tenantId, { orderId: b.orderId, phone: b.phone }));
  });

  // ---- Əməliyyatlar (yazma): sahibin konfiqurasiyası, sınaq və jurnal ----
  const actWrite = (userId: string) => { if (!limiter.hit(`act:${userId}`, 30, 10 * 60_000)) throw new HttpError(429, "Çox əməliyyat oldu, bir az gözləyin", "RATE_LIMITED"); };
  r.get("/actions", async (_req, res) => { res.set("cache-control", "no-store").json(await ai.actions((await mine(currentUser(res).id)).tenantId)); });
  r.put("/actions", async (req, res) => {
    const user = currentUser(res); actWrite(user.id);
    res.set("cache-control", "no-store").json(await ai.setActions((await mine(user.id)).tenantId, req.body ?? {}));
  });
  r.delete("/actions", async (_req, res) => { const user = currentUser(res); actWrite(user.id); res.json(await ai.deleteActions((await mine(user.id)).tenantId)); });
  r.post("/actions/signing-secret", async (_req, res) => {
    const user = currentUser(res); actWrite(user.id);
    res.set("cache-control", "no-store").status(201).json(await ai.newSigningSecret((await mine(user.id)).tenantId));
  });
  r.post("/actions/test", async (req, res) => {
    const user = currentUser(res);
    const b = (req.body ?? {}) as { key?: unknown; params?: unknown; send?: unknown; userId?: unknown };
    if (typeof b.key !== "string") throw new HttpError(400, "key tələb olunur");
    // Real sorğu göndərən sınaq daha sərt limitlidir
    if (b.send === true && !limiter.hit(`act-send:${user.id}`, 10, 10 * 60_000)) throw new HttpError(429, "Çox real sınaq göndərildi, bir az gözləyin", "RATE_LIMITED");
    actWrite(user.id);
    res.set("cache-control", "no-store").json(await ai.testAction((await mine(user.id)).tenantId, { key: b.key, params: b.params, send: b.send === true, ...(typeof b.userId === "string" && { userId: b.userId }) }));
  });
  r.get("/actions/stats", async (_req, res) => { res.set("cache-control", "no-store").json(await ai.actionStats((await mine(currentUser(res).id)).tenantId)); });
  r.get("/actions/log", async (_req, res) => { res.set("cache-control", "no-store").json(await ai.actionLog((await mine(currentUser(res).id)).tenantId)); });
  r.delete("/actions/log", async (_req, res) => { const user = currentUser(res); actWrite(user.id); res.json(await ai.clearActionLog((await mine(user.id)).tenantId)); });

  // Aylıq e-poçt hesabatı: oxu / aç-söndür
  r.get("/report", async (_req, res) => { const t = await mine(currentUser(res).id); res.json({ monthly: t.report?.monthly !== false }); });
  r.put("/report", async (req, res) => {
    const t = await mine(currentUser(res).id);
    if (typeof req.body?.monthly !== "boolean") throw new HttpError(400, "monthly true/false olmalıdır");
    await store.updateTenant(t.tenantId, { report: { ...t.report, monthly: req.body.monthly } });
    res.json({ monthly: req.body.monthly });
  });
  r.delete("/queries", async (_req, res) => {
    const t = await mine(currentUser(res).id);
    res.json(await ai.clearQueries(t.tenantId));
  });

  // ---- Bilik bazası (dəstək botu) ----
  const kbWrite = (userId: string) => { if (!limiter.hit(`kb:${userId}`, 40, 10 * 60_000)) throw new HttpError(429, "Çox əməliyyat oldu, bir az gözləyin", "RATE_LIMITED"); };
  const sid = (v: unknown) => { const x = String(v ?? ""); if (!/^[A-Za-z0-9-]{8,64}$/.test(x)) throw new HttpError(400, "Yanlış identifikator"); return x; };

  r.get("/kb", async (_req, res) => { res.json(await ai.kbInfo((await mine(currentUser(res).id)).tenantId)); });
  r.post("/kb/files", express.json({ limit: "9mb" }), async (req, res) => {
    const user = currentUser(res); kbWrite(user.id);
    const { name, mime, data } = req.body ?? {};
    if (typeof name !== "string" || !name.trim() || typeof data !== "string" || !data) throw new HttpError(400, "Fayl göndərilməyib");
    const t = await mine(user.id);
    res.status(202).json(await ai.kbAddFile(t.tenantId, { name: name.trim().slice(0, 200), mime: typeof mime === "string" ? mime.slice(0, 100) : "", data }));
  });
  r.post("/kb/urls", async (req, res) => {
    const user = currentUser(res); kbWrite(user.id);
    const url = typeof req.body?.url === "string" ? req.body.url.trim() : "";
    if (!/^https?:\/\//i.test(url) || url.length > 2000) throw new HttpError(400, "Ünvan http:// və ya https:// ilə başlamalıdır");
    const t = await mine(user.id);
    res.status(202).json(await ai.kbAddUrl(t.tenantId, url, req.body?.crawl === true));
  });
  r.post("/kb/texts", async (req, res) => {
    const user = currentUser(res); kbWrite(user.id);
    const { title, text } = req.body ?? {};
    if (typeof text !== "string" || text.trim().length < 20) throw new HttpError(400, "Mətn ən azı 20 simvol olmalıdır");
    const t = await mine(user.id);
    res.status(202).json(await ai.kbAddText(t.tenantId, typeof title === "string" ? title.slice(0, 160) : "", text));
  });
  // Sual-cavab cütləri: yoxlamanı AI servisi edir, burada yalnız forma və tip
  const qaBody = (b: unknown) => {
    const o = (b ?? {}) as { questions?: unknown; answer?: unknown };
    const questions = Array.isArray(o.questions) ? o.questions.filter((q): q is string => typeof q === "string").slice(0, 12).map((q) => q.slice(0, 300)) : [];
    return { questions, answer: typeof o.answer === "string" ? o.answer.slice(0, 3000) : "" };
  };
  r.post("/kb/qa", async (req, res) => {
    const user = currentUser(res); kbWrite(user.id);
    res.status(201).json(await ai.kbAddQa((await mine(user.id)).tenantId, qaBody(req.body)));
  });
  r.put("/kb/qa/:id", async (req, res) => {
    const user = currentUser(res); kbWrite(user.id);
    res.json(await ai.kbUpdateQa((await mine(user.id)).tenantId, sid(req.params.id), qaBody(req.body)));
  });
  // Ssenarilər: ad + nə vaxt işləməli (ifadələr) + addım-addım qayda
  const procBody = (b: unknown) => {
    const o = (b && typeof b === "object" ? b : {}) as Record<string, unknown>;
    const triggers = (Array.isArray(o.triggers) ? o.triggers : []).filter((q): q is string => typeof q === "string" && q.length <= 300).slice(0, 12);
    return { name: typeof o.name === "string" ? o.name.slice(0, 200) : "", triggers, steps: typeof o.steps === "string" ? o.steps.slice(0, 4000) : "" };
  };
  r.post("/kb/proc", async (req, res) => {
    const user = currentUser(res); kbWrite(user.id);
    res.status(201).json(await ai.kbAddProc((await mine(user.id)).tenantId, procBody(req.body)));
  });
  r.put("/kb/proc/:id", async (req, res) => {
    const user = currentUser(res); kbWrite(user.id);
    res.json(await ai.kbUpdateProc((await mine(user.id)).tenantId, sid(req.params.id), procBody(req.body)));
  });
  r.post("/kb/sources/:id/refresh", async (req, res) => {
    const user = currentUser(res); kbWrite(user.id);
    res.status(202).json(await ai.kbRefresh((await mine(user.id)).tenantId, sid(req.params.id)));
  });
  r.delete("/kb/sources/:id", async (req, res) => { res.json(await ai.kbDelete((await mine(currentUser(res).id)).tenantId, sid(req.params.id))); });
  r.get("/kb/unanswered", async (_req, res) => { res.json(await ai.kbUnanswered((await mine(currentUser(res).id)).tenantId)); });
  r.delete("/kb/unanswered/:id", async (req, res) => { res.json(await ai.kbDeleteUnanswered((await mine(currentUser(res).id)).tenantId, sid(req.params.id))); });
  r.get("/kb/leads", async (_req, res) => { res.json(await ai.kbLeads((await mine(currentUser(res).id)).tenantId)); });
  // Müraciət: status, prioritet, məsul, daxili qeyd (kim etdiyi tarixçəyə yazılır)
  r.patch("/kb/leads/:id", async (req, res) => {
    const user = currentUser(res), b = req.body ?? {};
    const patch: Record<string, unknown> = { by: nameOf(user) };
    if (b.handled !== undefined && typeof b.handled !== "boolean") throw new HttpError(400, "handled true/false olmalıdır");
    if (b.status !== undefined && !["new", "open", "pending", "solved"].includes(b.status)) throw new HttpError(400, "Status düzgün deyil");
    if (b.priority !== undefined && !["low", "normal", "high"].includes(b.priority)) throw new HttpError(400, "Prioritet düzgün deyil");
    if (b.assignee !== undefined && b.assignee !== null && !(typeof b.assignee?.name === "string" && b.assignee.name.trim())) throw new HttpError(400, "Məsul düzgün deyil");
    if (b.note !== undefined && (typeof b.note !== "string" || b.note.length > 1000)) throw new HttpError(400, "Qeyd 1000 simvoldan uzun ola bilməz");
    for (const k of ["handled", "status", "priority", "assignee", "note"] as const) if (b[k] !== undefined) patch[k] = b[k];
    if (Object.keys(patch).length === 1) throw new HttpError(400, "Dəyişiklik yoxdur");
    res.json(await ai.kbUpdateLead((await mine(user.id)).tenantId, sid(req.params.id), patch));
  });

  // ---- Bloklama (spam, təhqir): ziyarətçi çata yaza bilmir, kanalda bot cavab vermir ----
  // Kampaniyaların statistikası (göstərilib / klik / söhbət); yalnız mövcud kampaniyalar
  r.get("/campaigns/stats", async (_req, res) => {
    const t = await mine(currentUser(res).id);
    const ids = new Set((t.widget?.proactive?.rules ?? []).map((x) => x.id));
    res.json({ stats: Object.fromEntries(Object.entries(t.campaignStats ?? {}).filter(([id]) => ids.has(id))) });
  });
  r.delete("/campaigns/:id/stats", async (req, res) => {
    const t = await mine(currentUser(res).id);
    const id = String(req.params.id ?? "");
    const { [id]: _drop, ...rest } = t.campaignStats ?? {};
    await store.updateTenant(t.tenantId, { campaignStats: rest });
    res.json({ ok: true });
  });
  r.get("/blocks", async (_req, res) => {
    const t = await mine(currentUser(res).id);
    res.json({ items: (t.blocked ?? []).map((b) => ({ key: b.key, label: b.label, at: b.at, by: b.by })) });
  });
  const block = async (user: User, t: TenantRecord, key: string, label: string) => {
    await store.updateTenant(t.tenantId, { blocked: addBlock(t.blocked, { key, label: label.slice(0, 80), at: new Date(), by: nameOf(user) }) });
  };
  r.post("/live/:id/block", async (req, res) => {
    const user = currentUser(res);
    const { tenant: t } = await opTenant(user);
    const chat = await store.getLive(t.tenantId, String(req.params.id));
    if (!chat) throw new HttpError(404, "Söhbət tapılmadı", "LIVE_NOT_FOUND");
    const key = blockKeyOfChat(chat);
    if (!key) throw new HttpError(409, "Bu söhbəti bloklamaq olmur (ziyarətçi tanınmır)", "NOT_BLOCKABLE");
    await block(user, t, key, chat.name || chat.contact || (chat.channel ? chat.channel.type : "Ziyarətçi"));
    if (chat.status === "open") {
      await store.pushLive(t.tenantId, chat.id, { from: "system", text: "closed", at: new Date() }, { status: "closed", operatorSeenAt: new Date() });
      hub.toChat(chat.id, { t: "new", total: chat.messages.length + 1 });
    }
    hub.toOperators(t.tenantId, { t: "live", id: chat.id, kind: "close" });
    res.json({ ok: true });
  });
  r.post("/visitors/:pid/block", async (req, res) => {
    const user = currentUser(res);
    const { tenant: t } = await opTenant(user);
    const pid = String(req.params.pid ?? "");
    if (!/^[a-f0-9]{16}$/.test(pid)) throw new HttpError(400, "Ziyarətçi düzgün deyil");
    const v = getVisitor(t.tenantId, pid);
    await block(user, t, `v:${pid}`, v?.title ? `Ziyarətçi · ${v.title}` : "Ziyarətçi");
    res.json({ ok: true });
  });
  r.delete("/blocks/:key", async (req, res) => {
    const t = await mine(currentUser(res).id);
    const key = String(req.params.key ?? "");
    await store.updateTenant(t.tenantId, { blocked: (t.blocked ?? []).filter((b) => b.key !== key) });
    res.json({ ok: true });
  });

  // ---- Müştərilər: canlı söhbətlər, kanal yazışmaları və müraciətlər bir kartda (telefon/e-poçt/kanal ID-si ilə birləşir) ----
  r.get("/customers", async (req, res) => {
    const t = await mine(currentUser(res).id);
    const [open, closed, leadsRes, sessions] = await Promise.all([
      store.listLive(t.tenantId, "open", 300).catch(() => []), store.listLive(t.tenantId, "closed", 700).catch(() => []), ai.kbLeads(t.tenantId).catch(() => ({ items: [] })),
      store.listChannelSessions(t.tenantId, 500).catch(() => []),
    ]);
    res.json({ items: buildCustomers(t, [...open, ...closed], (leadsRes.items ?? []) as LeadLite[], typeof req.query.q === "string" ? req.query.q : "", sessions) });
  });
  r.delete("/kb/leads/:id", async (req, res) => { res.json(await ai.kbDeleteLead((await mine(currentUser(res).id)).tenantId, sid(req.params.id))); });

  r.get("/listings", async (req, res) => {
    const t = await mine(currentUser(res).id);
    const query = (req.url.split("?")[1] ?? "").slice(0, 500);
    res.json(await ai.listings(t.tenantId, query));
  });

  // Balans: qalıq, xərc, orta sorğu, jurnal. Yükləmə sorğusu ödəniş provayderindən asılıdır (hazırda admin təsdiqi).
  r.get("/billing", async (_req, res) => {
    const t = await mine(currentUser(res).id);
    res.json(await ai.billing(t.tenantId));
  });
  r.post("/billing/topup-request", async (req, res) => {
    const user = currentUser(res);
    const t = await mine(user.id);
    const amount = parseAmount((req.body as { amountAzn?: unknown } | undefined)?.amountAzn);
    const out = await ai.billingTopupRequest(t.tenantId, amount);
    void notifyTopupRequest(deps, t, amount, typeof out.request?.id === "string" ? out.request.id : undefined);
    res.status(201).json(out);
  });

  // Abunə: plan/paket sifarişi. Məbləği AI servisi hesablayır (müştəri göndərmir). ?dryRun=1 — yalnız qiymət.
  r.post("/billing/order", async (req, res) => {
    const user = currentUser(res);
    const t = await mine(user.id);
    const b = (req.body ?? {}) as Record<string, unknown>;
    const s = (v: unknown) => (typeof v === "string" ? v.slice(0, 20) : undefined);
    const body = { kind: s(b.kind) ?? "", plan: s(b.plan), cycle: b.cycle === "year" ? "year" : "month", pack: s(b.pack) };
    if (body.kind !== "plan" && body.kind !== "pack") throw new HttpError(400, "kind plan və ya pack olmalıdır");
    const dry = req.query.dryRun === "1";
    if (!dry && !limiter.hit(`order:${t.tenantId}`, 10, 60 * 60_000)) throw new HttpError(429, "Çox tez-tez sifariş göndərirsən", "RATE_LIMITED");
    const out = await ai.billingOrder(t.tenantId, body, dry);
    if (!dry && out.request) void notifyOrder(deps, t, out.request);
    res.status(dry ? 200 : 201).json(out);
  });
  // Panel: plan imkanları və hər bağlı imkanın açıldığı ən ucuz plan ("Biznes planında" nişanı üçün)
  r.get("/entitlements", async (_req, res) => {
    const t = await mine(currentUser(res).id);
    const ent = await loadEntitlements(deps, t.tenantId);
    const cat = await getPublicPlans(deps).catch(() => null);
    const plans = ([...((cat?.plans ?? []) as { name: string; priceAzn: number; features: Record<string, boolean> }[])]).sort((a, b) => a.priceAzn - b.priceAzn);
    const unlock = Object.fromEntries(FEATURE_KEYS.map((k) => [k, plans.find((p) => p.features?.[k])?.name ?? null]));
    res.json({ ...ent, unlock });
  });
  // Növbəti dövrdən başqa (ucuz) plana keçid; plan: null — ləğv
  r.post("/billing/plan/next", async (req, res) => {
    const t = await mine(currentUser(res).id);
    const p = (req.body as { plan?: unknown } | undefined)?.plan;
    const out = await ai.billingPlanNext(t.tenantId, typeof p === "string" && p ? p.slice(0, 20) : null);
    invalidateEntitlements(t.tenantId);
    res.json(out);
  });

  r.post("/chat", async (req, res) => {
    const t = await mine(currentUser(res).id);
    const { message, history } = req.body ?? {};
    if (typeof message !== "string" || !message.trim() || message.length > 500) throw new HttpError(400, "Mesaj 1-500 simvol olmalıdır");
    const clean = (Array.isArray(history) ? history : []).slice(-10)
      .filter((h: any) => h && (h.role === "user" || h.role === "model") && typeof h.text === "string")
      .map((h: any) => ({ role: h.role, text: h.text.slice(0, 2000) }));
    const r = await ai.chat(t.tenantId, message.trim(), clean, { test: true }); // sınaq söhbəti sorğu qeydinə düşmür
    // Quraşdırmanın "Sınaq" addımı: köməkçi müştərinin öz məlumatı ilə cavab veribsə (elan və ya bilik mənbəyi) bir dəfə qeyd olunur
    const fromData = (Array.isArray(r.listings) && r.listings.length > 0) || (Array.isArray(r.sources) && r.sources.length > 0);
    if (!t.testedAt && fromData && !r.unanswered) await store.updateTenant(t.tenantId, { testedAt: new Date() }).catch(() => {});
    res.json(r);
  });

  return r;
}
