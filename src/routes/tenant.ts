import express, { Router } from "express";
import { LIVE_MSG, deliverToChannel, startChannelLive } from "../channel-live.js";
import { MAX_TEAM, memberTenant, nameOf, tenantFor, validEmail } from "../team.js";
import type { Deps } from "../deps.js";
import type { AiResult } from "../ai.js";
import { HttpError } from "../http.js";
import { notifyTopupRequest, parseAmount } from "../billing.js";
import { mailVisitorReply } from "../live.js";
import { exportCsv, funnel, type ExportKind } from "../stats.js";
import { hub } from "../hub.js";
import { makeTicket, wsUrlOf } from "../realtime.js";
import { currentUser, requireAuth } from "../middleware.js";
import { DuplicateError, type LiveChat, type TenantRecord, type User } from "../store/types.js";
import { DEFAULT_GREETING, DEFAULT_GREETING_SUPPORT, DEFAULT_LABEL, defaultWidget, modeOf, limitsOf, newWidgetKey, parseLogo, parseWidgetPatch, logoUrl } from "../widget.js";

const CONFIG_KEYS = ["businessName", "domain", "profile", "source", "apiSecret", "feedText"];
const PROFILE_KEYS = ["language", "tone", "maxResults", "extraInstructions", "logQueries", "mode", "fallbackMessage", "generalKnowledge", "kbAutoRefresh", "imageSearch"];

/** Müştərinin göndərdiyi JSON-dan yalnız tanınan sahələri götürür. */
function extractConfig(body: unknown): Record<string, unknown> {
  const cfg = (body as { config?: unknown } | undefined)?.config;
  if (!cfg || typeof cfg !== "object" || Array.isArray(cfg)) throw new HttpError(400, "Konfiqurasiya JSON obyekt olmalıdır");
  return Object.fromEntries(Object.entries(cfg).filter(([k]) => CONFIG_KEYS.includes(k)));
}

/** Bazada saxlanan nüsxədə sirr olmur. */
function withoutSecrets(cfg: Record<string, unknown>): Record<string, unknown> {
  const { apiSecret: _drop, feedText: _feed, ...rest } = cfg; // yüklənmiş fayl portalda saxlanmır (AI servisindədir)
  const source = rest.source as { auth?: Record<string, unknown> } | undefined;
  if (source?.auth) {
    const { value: _v, secret: _s, valueEnv: _e, encryptedValue: _x, ...auth } = source.auth;
    rest.source = { ...source, auth };
  }
  return rest;
}

const publicTenant = (t: TenantRecord) => ({
  tenantId: t.tenantId, businessName: t.businessName, domain: t.domain, config: t.config,
  createdAt: t.createdAt, updatedAt: t.updatedAt, keyRotatedAt: t.keyRotatedAt ?? null,
});

/** Ziyarətçi yazıb, operator hələ cavab verməyib (və ya söhbəti açmayıb). */
const isWaiting = (c: LiveChat) => {
  const last = c.messages[c.messages.length - 1];
  return c.status === "open" && (!last || last.from === "visitor") && (!c.operatorSeenAt || c.operatorSeenAt < (last?.at ?? c.createdAt));
};
const liveItem = (c: LiveChat) => {
  const last = c.messages[c.messages.length - 1];
  return { id: c.id, channel: c.channel?.type ?? null, assignee: c.assignee ? { id: c.assignee.userId, name: c.assignee.name } : null, name: c.name, contact: c.contact, status: c.status, createdAt: c.createdAt, updatedAt: c.updatedAt, count: c.messages.length, waiting: isWaiting(c), last: last ? { from: last.from, text: last.text.slice(0, 160), at: last.at } : null };
};

export function tenantRoutes(deps: Deps) {
  const { store, ai, limiter, config } = deps;
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
    res.json({ max: MAX_TEAM, members: (t.team ?? []).map((m) => ({ email: m.email, joined: Boolean(m.userId), addedAt: m.addedAt })) });
  });
  r.post("/team", async (req, res) => {
    const user = currentUser(res);
    if (!limiter.hit(`team:add:${user.id}`, 20, 60 * 60_000)) throw new HttpError(429, "Çox tez-tez dəvət göndərirsən", "RATE_LIMITED");
    const t = await mine(user.id);
    const email = typeof req.body?.email === "string" ? req.body.email.trim().toLowerCase() : "";
    if (!validEmail(email)) throw new HttpError(400, "Düzgün e-poçt yaz");
    if (email === user.email.toLowerCase()) throw new HttpError(400, "Bu sənin öz e-poçtundur");
    if ((t.team ?? []).length >= MAX_TEAM) throw new HttpError(400, `Ən çox ${MAX_TEAM} operator əlavə edə bilərsən`, "TEAM_FULL");
    if ((t.team ?? []).some((m) => m.email === email)) throw new HttpError(409, "Bu e-poçt artıq əlavə olunub", "TEAM_EXISTS");
    const other = await store.findUserByEmail(email);
    if (other && (await store.findTenantByUser(other.id))) throw new HttpError(409, "Bu istifadəçinin öz hesabı var, onu operator kimi əlavə etmək olmaz", "HAS_OWN_ACCOUNT");
    if (await store.findTenantByTeamEmail(email)) throw new HttpError(409, "Bu e-poçt başqa hesabın komandasındadır", "IN_OTHER_TEAM");
    const member = { email, ...(other?.verified && { userId: other.id }), addedAt: new Date() };
    await store.updateTenant(t.tenantId, { team: [...(t.team ?? []), member] });
    const panel = config.allowedOrigins[0] ?? "";
    void deps.mailer.send(email, `${t.businessName}: operator dəvəti`, `${t.businessName} sizi operator kimi əlavə etdi. Müştəri söhbətlərinə cavab vermək üçün bu e-poçtla ${other ? "daxil olun" : "qeydiyyatdan keçin"}:\n${panel}${other ? "/login" : "/register"}\n\nOperator yalnız canlı söhbətləri görür, hesab ayarlarına çıxışı olmur.`).catch(() => {});
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
    if (!limiter.hit(`cfgtest:${user.id}`, 30, 10 * 60_000)) throw new HttpError(429, "Çox sınaq oldu, bir neçə dəqiqə sonra yenidən yoxla", "RATE_LIMITED");
    res.json(await ai.testConfig(extractConfig(req.body)));
  });

  r.post("/", async (req, res) => {
    const user = currentUser(res);
    const cfg = extractConfig(req.body);
    if (await store.findTenantByUser(user.id)) throw new HttpError(409, "Artıq aktiv mənbən var. Konfiqurasiyanı yeniləyə bilərsən.", "TENANT_EXISTS");
    if (await memberTenant(store, user)) throw new HttpError(409, "Sən başqa hesabın operatorusan, öz hesabını yaratmaq olmur", "IS_OPERATOR");
    const result = await exclusive(user.id, async () => {
      const created = await ai.createTenant(cfg);
      const now = new Date();
      try {
        await store.createTenant({
          userId: user.id, tenantId: String(created.tenantId), businessName: String(cfg.businessName).trim(), domain: String(cfg.domain).trim(),
          config: withoutSecrets(cfg), createdAt: now, updatedAt: now,
          widget: defaultWidget({ businessName: String(cfg.businessName).trim(), config: cfg }),
        });
      } catch (e) {
        if (e instanceof DuplicateError) throw new HttpError(409, "Artıq aktiv mənbən var", "TENANT_EXISTS");
        console.error(`[tenant] AI servisində ${created.tenantId} yaradıldı, amma bazaya yazıla bilmədi`, e);
        throw e;
      }
      return created;
    });
    const t = await mine(user.id);
    res.status(201).json({ apiKey: result.apiKey, tenant: publicTenant(t), sampleListings: result.sampleListings ?? [] });
  });

  r.put("/config", async (req, res) => {
    const user = currentUser(res);
    const cfg = extractConfig(req.body);
    const t = await mine(user.id);
    const result = await exclusive(user.id, () => ai.updateConfig(t.tenantId, cfg));
    await store.updateTenant(t.tenantId, { config: withoutSecrets(cfg), businessName: String(cfg.businessName).trim(), domain: String(cfg.domain).trim() });
    res.json({ tenant: publicTenant(await mine(user.id)), sampleListings: result.sampleListings ?? [] });
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
      if (t.widget.greeting === oldDefault) await store.updateTenant(t.tenantId, { widget: { ...t.widget, greeting: after === "support" ? DEFAULT_GREETING_SUPPORT : DEFAULT_GREETING } });
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
    widget: { ...widget, logo: undefined, logoUrl: widget.logo ? logoUrl(config.publicPortalUrl, widget) : null, theme: widget.theme ?? "light", label: widget.label ?? DEFAULT_LABEL, limits: limitsOf(widget) }, scriptUrl: `${config.publicPortalUrl}/widget.js`, domain: t.domain, brandRemoved: Boolean(t.brandRemoved), brandName: config.brandName,
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
      await store.updateTenant(t.tenantId, { widget: w });
      return w;
    });
    res.json(widgetView(t, next));
  });

  // Loqo: tək atomik yazma ($set/$unset widget.logo). Bütün vidjet sənədini yenidən yazmırıq.
  const timed = (label: string, t0: number) => {
    const ms = Date.now() - t0;
    if (ms > 1500) console.warn(`[widget-logo] ${label} ${ms}ms (yavaş: əsasən baza gecikməsi)`);
  };
  r.put("/widget/logo", async (req, res) => {
    const t0 = Date.now();
    const user = currentUser(res);
    if (!limiter.hit(`logo:${user.id}`, 20, 10 * 60_000)) throw new HttpError(429, "Çox əməliyyat oldu, bir az gözləyin", "RATE_LIMITED");
    const t = await mine(user.id);
    const logo = parseLogo(req.body);
    const base = await widgetOf(t);
    await store.setWidgetLogo(t.tenantId, logo);
    timed("PUT", t0);
    res.json(widgetView(t, { ...base, logo }));
  });
  r.delete("/widget/logo", async (_req, res) => {
    const t0 = Date.now();
    const user = currentUser(res);
    const t = await mine(user.id);
    const { logo: _gone, ...rest } = await widgetOf(t);
    await store.setWidgetLogo(t.tenantId, null);
    timed("DELETE", t0);
    res.json(widgetView(t, rest));
  });

  // Köhnə açarla qoyulmuş scriptlər dərhal işləməyi dayandırır.
  r.post("/widget/rotate", async (_req, res) => {
    const user = currentUser(res);
    const t = await mine(user.id);
    const next = await exclusive(user.id, async () => {
      const w = { ...(await widgetOf(t)), key: newWidgetKey() };
      await store.updateTenant(t.tenantId, { widget: w });
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
      billing: billing ? { state: billing.state, balanceAzn: billing.balance?.totalAzn, freeAzn: billing.balance?.freeAzn, paidAzn: billing.balance?.paidAzn, monthAzn: billing.spend?.monthAzn, enforced: billing.enforced } : null,
      setup: {
        dataReady: kbOn ? sources.some((s) => s.status === "ready") : true,
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
    res.json({ enabled: Boolean(t.widget?.live?.enabled), open: open.length, waiting: open.filter(isWaiting).length });
  });
  r.get("/live", async (req, res) => {
    const { tenant: t } = await opTenant(currentUser(res));
    const status = req.query.status === "closed" ? "closed" : "open";
    const items = (await store.listLive(t.tenantId, status, 100)).map(liveItem);
    res.json({ items });
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
    const chat = await startChannelLive(deps, t, { channel, chatId, ...(sess.ref && { ref: sess.ref }), name: sess.name ?? "", history: sess.history, quiet: true });
    try { await deliverToChannel(deps, t, chat, text); }
    catch {
      await store.pushLive(t.tenantId, chat.id, { from: "system", text: "closed", at: new Date() }, { status: "closed" });
      throw new HttpError(502, channel === "telegram" ? "Mesaj Telegram-a göndərilə bilmədi" : "Mesaj WhatsApp-a göndərilə bilmədi", "CHANNEL_SEND_FAILED");
    }
    await store.pushLive(t.tenantId, chat.id, { from: "operator", text, at: new Date(), by: who }, { operatorSeenAt: new Date(), assignee: { userId: user.id, name: who } });
    hub.toOperators(t.tenantId, { t: "live", id: chat.id, kind: "start" });
    res.status(201).json({ id: chat.id });
  });

  r.get("/live/:id", async (req, res) => {
    const { tenant: t } = await opTenant(currentUser(res));
    const chat = await store.getLive(t.tenantId, String(req.params.id));
    if (!chat) throw new HttpError(404, "Söhbət tapılmadı", "LIVE_NOT_FOUND");
    const lastAt = (chat.messages[chat.messages.length - 1]?.at ?? chat.createdAt).getTime();
    // "Gördüm" işarəsi yalnız yeni mesaj gələndə yenilənir (operator panelinin təkrar sorğuları sıralamanı pozmasın)
    const c = !chat.operatorSeenAt || chat.operatorSeenAt.getTime() < lastAt ? (await store.pushLive(t.tenantId, chat.id, null, { operatorSeenAt: new Date() })) ?? chat : chat;
    res.json({ chat: { id: c.id, name: c.name, contact: c.contact, status: c.status, context: c.context, messages: c.messages, createdAt: c.createdAt, channel: c.channel?.type ?? null, assignee: c.assignee ?? null } });
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
  r.post("/live/:id/close", async (req, res) => {
    const { tenant: t } = await opTenant(currentUser(res));
    const chat = await store.getLive(t.tenantId, String(req.params.id));
    if (!chat) throw new HttpError(404, "Söhbət tapılmadı", "LIVE_NOT_FOUND");
    if (chat.status === "open") {
      await store.pushLive(t.tenantId, chat.id, { from: "system", text: "closed", at: new Date() }, { status: "closed", operatorSeenAt: new Date() });
      hub.toChat(chat.id, { t: "new", total: chat.messages.length + 1 });
      hub.toOperators(t.tenantId, { t: "live", id: chat.id, kind: "close" });
      if (chat.channel) void deliverToChannel(deps, t, chat, LIVE_MSG.back).catch(() => {}); // bot geri qayıtdı xəbəri (alınmasa vacib deyil)
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
  // Konversiya: söhbətlərin neçəsi operatora/müraciətə çevrildi
  r.get("/funnel", async (req, res) => {
    const t = await mine(currentUser(res).id);
    const d = Number(req.query.days);
    res.json(await funnel(deps, t, Number.isFinite(d) && d > 0 ? Math.min(Math.round(d), 90) : 30));
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
  r.patch("/kb/leads/:id", async (req, res) => {
    if (typeof req.body?.handled !== "boolean") throw new HttpError(400, "handled true/false olmalıdır");
    res.json(await ai.kbHandleLead((await mine(currentUser(res).id)).tenantId, sid(req.params.id), req.body.handled));
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
    void notifyTopupRequest(deps, t, amount);
    res.status(201).json(out);
  });

  r.post("/chat", async (req, res) => {
    const t = await mine(currentUser(res).id);
    const { message, history } = req.body ?? {};
    if (typeof message !== "string" || !message.trim() || message.length > 500) throw new HttpError(400, "Mesaj 1-500 simvol olmalıdır");
    const clean = (Array.isArray(history) ? history : []).slice(-10)
      .filter((h: any) => h && (h.role === "user" || h.role === "model") && typeof h.text === "string")
      .map((h: any) => ({ role: h.role, text: h.text.slice(0, 2000) }));
    res.json(await ai.chat(t.tenantId, message.trim(), clean, { test: true })); // sınaq söhbəti sorğu qeydinə düşmür
  });

  return r;
}
