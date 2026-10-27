import express, { Router } from "express";
import type { Deps } from "../deps.js";
import type { AiResult } from "../ai.js";
import { HttpError } from "../http.js";
import { notifyTopupRequest, parseAmount } from "../billing.js";
import { mailVisitorReply } from "../live.js";
import { exportCsv, funnel, type ExportKind } from "../stats.js";
import { hub } from "../hub.js";
import { makeTicket, wsUrlOf } from "../realtime.js";
import { currentUser, requireAuth } from "../middleware.js";
import { DuplicateError, type LiveChat, type TenantRecord } from "../store/types.js";
import { DEFAULT_GREETING, DEFAULT_GREETING_SUPPORT, DEFAULT_LABEL, defaultWidget, modeOf, limitsOf, newWidgetKey, parseLogo, parseWidgetPatch, logoUrl } from "../widget.js";

const CONFIG_KEYS = ["businessName", "domain", "profile", "source", "apiSecret"];
const PROFILE_KEYS = ["language", "tone", "maxResults", "extraInstructions", "logQueries", "mode", "fallbackMessage", "generalKnowledge", "kbAutoRefresh"];

/** Müştərinin göndərdiyi JSON-dan yalnız tanınan sahələri götürür. */
function extractConfig(body: unknown): Record<string, unknown> {
  const cfg = (body as { config?: unknown } | undefined)?.config;
  if (!cfg || typeof cfg !== "object" || Array.isArray(cfg)) throw new HttpError(400, "Konfiqurasiya JSON obyekt olmalıdır");
  return Object.fromEntries(Object.entries(cfg).filter(([k]) => CONFIG_KEYS.includes(k)));
}

/** Bazada saxlanan nüsxədə sirr olmur. */
function withoutSecrets(cfg: Record<string, unknown>): Record<string, unknown> {
  const { apiSecret: _drop, ...rest } = cfg;
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
  return { id: c.id, name: c.name, contact: c.contact, status: c.status, createdAt: c.createdAt, updatedAt: c.updatedAt, count: c.messages.length, waiting: isWaiting(c), last: last ? { from: last.from, text: last.text.slice(0, 160), at: last.at } : null };
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

  r.get("/", async (_req, res) => {
    const t = await store.findTenantByUser(currentUser(res).id);
    res.json({ tenant: t ? publicTenant(t) : null, advisorUrl: config.publicAdvisorUrl });
  });

  // Yoxlama: heç nə yaratmır, yalnız konfiqurasiyanı və müştəri API-sinə bağlantını sınayır.
  r.post("/config/test", async (req, res) => {
    const user = currentUser(res);
    if (!limiter.hit(`cfgtest:${user.id}`, 30, 10 * 60_000)) throw new HttpError(429, "Çox sınaq oldu, bir neçə dəqiqə sonra yenidən yoxla", "RATE_LIMITED");
    res.json(await ai.testConfig(extractConfig(req.body)));
  });

  r.post("/", async (req, res) => {
    const user = currentUser(res);
    const cfg = extractConfig(req.body);
    if (await store.findTenantByUser(user.id)) throw new HttpError(409, "Artıq aktiv mənbən var. Konfiqurasiyanı yeniləyə bilərsən.", "TENANT_EXISTS");
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
    widget: { ...widget, logo: undefined, logoUrl: widget.logo ? logoUrl(config.publicPortalUrl, widget) : null, theme: widget.theme ?? "light", label: widget.label ?? DEFAULT_LABEL, limits: limitsOf(widget) }, scriptUrl: `${config.publicPortalUrl}/widget.js`, domain: t.domain,
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
    const t = await mine(currentUser(res).id);
    const open = await store.listLive(t.tenantId, "open", 200);
    res.json({ enabled: Boolean(t.widget?.live?.enabled), open: open.length, waiting: open.filter(isWaiting).length });
  });
  r.get("/live", async (req, res) => {
    const t = await mine(currentUser(res).id);
    const status = req.query.status === "closed" ? "closed" : "open";
    const items = (await store.listLive(t.tenantId, status, 100)).map(liveItem);
    res.json({ items });
  });
  r.get("/live/:id", async (req, res) => {
    const t = await mine(currentUser(res).id);
    const chat = await store.getLive(t.tenantId, String(req.params.id));
    if (!chat) throw new HttpError(404, "Söhbət tapılmadı", "LIVE_NOT_FOUND");
    const lastAt = (chat.messages[chat.messages.length - 1]?.at ?? chat.createdAt).getTime();
    // "Gördüm" işarəsi yalnız yeni mesaj gələndə yenilənir (operator panelinin təkrar sorğuları sıralamanı pozmasın)
    const c = !chat.operatorSeenAt || chat.operatorSeenAt.getTime() < lastAt ? (await store.pushLive(t.tenantId, chat.id, null, { operatorSeenAt: new Date() })) ?? chat : chat;
    res.json({ chat: { id: c.id, name: c.name, contact: c.contact, status: c.status, context: c.context, messages: c.messages, createdAt: c.createdAt } });
  });
  // Real vaxt bağlantısı üçün qısa ömürlü bilet (panel WebSocket-i bununla açır; cookie portalın ünvanına getmir)
  r.post("/live/ws-ticket", async (req, res) => {
    const user = currentUser(res);
    if (!limiter.hit(`live:ticket:${user.id}`, 30, 60_000)) throw new HttpError(429, "Çox tez-tez sorğu", "RATE_LIMITED");
    await mine(user.id);
    res.json({ ticket: makeTicket(deps, user.id), url: wsUrlOf(config.publicPortalUrl) });
  });
  r.post("/live/:id/messages", async (req, res) => {
    const user = currentUser(res);
    if (!limiter.hit(`live:op:${user.id}`, 60, 60_000)) throw new HttpError(429, "Çox tez-tez mesaj göndərirsən", "RATE_LIMITED");
    const t = await mine(user.id);
    const text = typeof req.body?.text === "string" ? req.body.text.trim() : "";
    if (!text || text.length > 1000) throw new HttpError(400, "Mesaj 1-1000 simvol olmalıdır");
    const chat = await store.getLive(t.tenantId, String(req.params.id));
    if (!chat) throw new HttpError(404, "Söhbət tapılmadı", "LIVE_NOT_FOUND");
    if (chat.status === "closed") throw new HttpError(409, "Söhbət bağlanıb", "LIVE_CLOSED");
    const next = await store.pushLive(t.tenantId, chat.id, { from: "operator", text, at: new Date() }, { operatorSeenAt: new Date() });
    void mailVisitorReply(deps, t, chat, text); // yalnız ziyarətçi çatdan ayrılıbsa və e-poçt yazıbsa
    const total = next?.messages.length ?? chat.messages.length;
    hub.toChat(chat.id, { t: "new", total });                                   // ziyarətçi dərhal oxuyur
    hub.toOperators(t.tenantId, { t: "live", id: chat.id, kind: "message" });   // operatorun digər tabları yenilənir
    res.status(201).json({ total: next?.messages.length ?? chat.messages.length });
  });
  r.post("/live/:id/close", async (req, res) => {
    const t = await mine(currentUser(res).id);
    const chat = await store.getLive(t.tenantId, String(req.params.id));
    if (!chat) throw new HttpError(404, "Söhbət tapılmadı", "LIVE_NOT_FOUND");
    if (chat.status === "open") {
      await store.pushLive(t.tenantId, chat.id, { from: "system", text: "closed", at: new Date() }, { status: "closed", operatorSeenAt: new Date() });
      hub.toChat(chat.id, { t: "new", total: chat.messages.length + 1 });
      hub.toOperators(t.tenantId, { t: "live", id: chat.id, kind: "close" });
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
