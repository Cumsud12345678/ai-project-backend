import { modeOf } from "../widget.js";
import { Router } from "express";
import { deleteAccount } from "../account.js";
import type { Deps } from "../deps.js";
import { isAdmin, isOwner } from "../deps.js";
import { HttpError } from "../http.js";
import { currentUser, requireAdmin, requireAuth } from "../middleware.js";
import { notifyTopupDone, parseAmount } from "../billing.js";
import type { ErrorSource } from "../store/types.js";

const SOURCES: ErrorSource[] = ["api", "ai", "mail", "widget", "process", "client", "job", "channel"];
const RANGE_DAYS: Record<string, number> = { "1d": 1, "7d": 7, "30d": 30 };
const csvCell = (v: unknown) => {
  let s = String(v ?? "");
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`; // Excel formulu kimi açılmasın
  return /[",\n;]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

export function adminRoutes(deps: Deps) {
  const { store, ai, config } = deps;
  const r = Router();
  r.use(requireAuth, requireAdmin(deps));
  /** Admin əməliyyatlarının izi (kim nə vaxt nəyi dəyişdi). Yazıla bilməsə əməliyyatı dayandırmır. */
  const audit = (res: Parameters<typeof currentUser>[0], action: string, target?: string, detail?: string) =>
    store.addAudit({ actor: currentUser(res).email, action, ...(target ? { target } : {}), ...(detail ? { detail: detail.slice(0, 300) } : {}) }).catch(() => {});

  r.get("/users", async (_req, res) => {
    const [users, tenants, accounts] = await Promise.all([store.listUsers(500), store.listTenants(1000), ai.billingAccounts().catch(() => null)]);
    const byUser = new Map(tenants.map((t) => [t.userId, t]));
    const balances = new Map(((accounts?.accounts ?? []) as { tenantId: string; totalAzn: number; paidAzn: number; spentAzn: number }[]).map((a) => [a.tenantId, a]));
    res.json({
      users: users.map((u) => {
        const t = byUser.get(u.id);
        return {
          id: u.id, email: u.email, verified: u.verified, isAdmin: isAdmin(config, u), isOwner: isOwner(config, u), createdAt: u.createdAt,
          tenant: t ? { mode: modeOf(t.config), balance: balances.get(t.tenantId) ?? null, tenantId: t.tenantId, businessName: t.businessName, domain: t.domain, createdAt: t.createdAt, keyRotatedAt: t.keyRotatedAt ?? null } : null,
        };
      }),
    });
  });

  const known = async (tenantId: string | undefined) => {
    if (!tenantId || !(await store.findTenantById(tenantId))) throw new HttpError(404, "Müştəri tapılmadı");
    return tenantId;
  };

  // Bütün müştərilər üzrə ümumi token/sorğu statistikası (gündəlik, aylıq, müştəri üzrə)
  r.get("/usage", async (_req, res) => {
    const [summary, tenants] = await Promise.all([ai.usageSummary(), store.listTenants(1000)]);
    const names = new Map(tenants.map((t) => [t.tenantId, t]));
    const rows = (summary.tenants ?? []) as { tenantId: string; requests: number; tokens: number }[];
    res.json({
      ...summary,
      tenants: rows.map((x) => ({ ...x, businessName: names.get(x.tenantId)?.businessName ?? "(silinib)", domain: names.get(x.tenantId)?.domain ?? "" })),
    });
  });

  r.get("/tenants/:tenantId/usage", async (req, res) => {
    res.json(await ai.usage(await known(req.params.tenantId)));
  });

  r.post("/tenants/:tenantId/rotate-key", async (req, res) => {
    const tenantId = await known(req.params.tenantId);
    const result = await ai.rotateKey(tenantId);
    await store.updateTenant(tenantId, { keyRotatedAt: new Date() });
    void audit(res, "tenant.rotate_key", tenantId);
    res.json({ tenantId, apiKey: result.apiKey });
  });

  // ---- Balans (admin) ----
  const tenantInfo = async (tenantId: string) => store.findTenantById(tenantId);
  r.get("/billing/requests", async (req, res) => {
    const status = ["pending", "approved", "rejected"].includes(String(req.query.status)) ? String(req.query.status) : "pending";
    const [out, tenants, users] = await Promise.all([ai.billingRequests(status), store.listTenants(1000), store.listUsers(1000)]);
    const tmap = new Map(tenants.map((t) => [t.tenantId, t]));
    const umap = new Map(users.map((u) => [u.id, u.email]));
    res.json({ requests: ((out.requests ?? []) as { tenantId: string }[]).map((x) => { const t = tmap.get(x.tenantId); return { ...x, businessName: t?.businessName ?? "(silinib)", domain: t?.domain ?? "", email: t ? umap.get(t.userId) ?? "" : "" }; }) });
  });
  r.post("/billing/requests/:id/:action", async (req, res) => {
    const action = req.params.action;
    if (action !== "approve" && action !== "reject") throw new HttpError(400, "action approve və ya reject olmalıdır");
    const out = await ai.billingResolve(String(req.params.id), action, currentUser(res).email);
    if (action === "approve" && !out.duplicate && out.request?.tenantId) {
      const t = await tenantInfo(String(out.request.tenantId));
      if (t) void notifyTopupDone(deps, t, Number(out.request.amountAzn), out.balance?.totalAzn);
    }
    void audit(res, action === "approve" ? "billing.approve" : "billing.reject", String(req.params.id));
    console.log(`[admin] ${currentUser(res).email} yükləmə sorğusunu ${action === "approve" ? "təsdiqlədi" : "rədd etdi"}: ${req.params.id}`);
    res.json(out);
  });
  r.get("/tenants/:tenantId/billing", async (req, res) => { res.json(await ai.billing(await known(req.params.tenantId), true)); });
  r.post("/tenants/:tenantId/billing/topup", async (req, res) => {
    const tenantId = await known(req.params.tenantId);
    const b = (req.body ?? {}) as { amountAzn?: unknown; note?: unknown };
    const amount = parseAmount(b.amountAzn, { allowNegative: true });
    const out = await ai.billingTopup(tenantId, { amountAzn: amount, note: typeof b.note === "string" ? b.note.slice(0, 200) : "", by: currentUser(res).email });
    void audit(res, "billing.topup", tenantId, `${amount} AZN${typeof b.note === "string" && b.note ? ` · ${b.note}` : ""}`);
    console.log(`[admin] ${currentUser(res).email} ${tenantId} balansını dəyişdi: ${amount} AZN`);
    if (amount > 0) { const t = await tenantInfo(tenantId); if (t) void notifyTopupDone(deps, t, amount, out.balance?.totalAzn); }
    res.json(out);
  });
  r.patch("/tenants/:tenantId/billing/settings", async (req, res) => {
    const tenantId = await known(req.params.tenantId);
    const b = (req.body ?? {}) as { markup?: unknown; creditLimitAzn?: unknown };
    const patch: { markup?: number | null; creditLimitAzn?: number } = {};
    if (b.markup !== undefined) patch.markup = b.markup === null || b.markup === "" ? null : Number(b.markup);
    if (b.creditLimitAzn !== undefined) patch.creditLimitAzn = Number(b.creditLimitAzn);
    if ((patch.markup !== undefined && patch.markup !== null && !Number.isFinite(patch.markup)) || (patch.creditLimitAzn !== undefined && !Number.isFinite(patch.creditLimitAzn))) throw new HttpError(400, "Dəyər düzgün deyil");
    void audit(res, "billing.settings", tenantId, JSON.stringify(patch));
    res.json(await ai.billingSettings(tenantId, patch));
  });

  // Admin statusu ver / al. Dəyişiklik dərhal qüvvəyə minir (restart lazım deyil).
  r.patch("/users/:id/role", async (req, res) => {
    const role = (req.body as { role?: unknown } | undefined)?.role;
    if (role !== "admin" && role !== "user") throw new HttpError(400, "role “admin” və ya “user” olmalıdır", "BAD_ROLE");
    const target = await store.findUserById(String(req.params.id));
    if (!target) throw new HttpError(404, "İstifadəçi tapılmadı");
    if (target.id === currentUser(res).id) throw new HttpError(400, "Öz rolunu dəyişə bilməzsən", "CANNOT_CHANGE_SELF");
    if (isOwner(config, target)) throw new HttpError(403, "Əsas adminin (.env) rolunu burada dəyişmək olmaz", "OWNER_ROLE_FIXED");
    if (role === "admin" && !target.verified) throw new HttpError(400, "Email təsdiqlənməyib: əvvəlcə hesab təsdiqlənməlidir", "NOT_VERIFIED");
    await store.updateUser(target.id, { role });
    void audit(res, "user.role", target.email, role);
    console.log(`[admin] ${currentUser(res).email} ${target.email} üçün rolu dəyişdi: ${role}`);
    res.json({ ok: true, id: target.id, isAdmin: role === "admin" });
  });

  // İstifadəçini və onun müştərisini (AI servisində də) silir. Geri qaytarmaq olmur.
  r.delete("/users/:id", async (req, res) => {
    const target = await store.findUserById(String(req.params.id));
    if (!target) throw new HttpError(404, "İstifadəçi tapılmadı");
    if (target.id === currentUser(res).id) throw new HttpError(400, "Öz hesabını burada silə bilməzsən. Ayarlar səhifəsindən sil.", "CANNOT_DELETE_SELF");
    if (isAdmin(config, target)) throw new HttpError(403, "Admin hesabını burada silmək olmaz", "CANNOT_DELETE_ADMIN");
    const { hadTenant } = await deleteAccount(deps, target);
    void audit(res, "user.delete", target.email, hadTenant ? "müştəri ilə birlikdə" : "");
    console.log(`[admin] ${currentUser(res).email} hesabı sildi: ${target.email}${hadTenant ? " (müştəri ilə birlikdə)" : ""}`);
    res.json({ ok: true });
  });

  // ---- Xəta jurnalı ----
  // Eyni xətalar qruplaşdırılır (say, ilk/son baş vermə), ən son hadisə nümunə kimi qaytarılır.
  r.get("/errors", async (req, res) => {
    const days = RANGE_DAYS[String(req.query.range)] ?? 7;
    const source = SOURCES.includes(req.query.source as ErrorSource) ? (req.query.source as ErrorSource) : undefined;
    const q = typeof req.query.q === "string" ? req.query.q.trim().toLowerCase().slice(0, 80) : "";
    const since = new Date(Date.now() - days * 86_400_000);
    const all = await store.listErrors({ since, limit: 1500 });
    const bySource: Record<string, number> = {};
    for (const e of all) bySource[e.source] = (bySource[e.source] ?? 0) + 1;
    const rows = all.filter((e) => (!source || e.source === source) && (!q || `${e.message} ${e.path ?? ""} ${e.code ?? ""}`.toLowerCase().includes(q)));
    const groups = new Map<string, { fingerprint: string; source: string; message: string; code?: string; status?: number; path?: string; count: number; firstAt: Date; lastAt: Date; sample: { id: string; stack?: string; method?: string; userId?: string; tenantId?: string } }>();
    for (const e of rows) { // rows ən yenidən köhnəyə sıralıdır
      const g = groups.get(e.fingerprint);
      if (g) { g.count += 1; g.firstAt = e.at; }
      else groups.set(e.fingerprint, { fingerprint: e.fingerprint, source: e.source, message: e.message, code: e.code, status: e.status, path: e.path, count: 1, firstAt: e.at, lastAt: e.at, sample: { id: e.id, stack: e.stack, method: e.method, userId: e.userId, tenantId: e.tenantId } });
    }
    const dayAgo = Date.now() - 86_400_000;
    res.json({ days, total: rows.length, last24h: all.filter((e) => e.at.getTime() >= dayAgo).length, bySource, groups: [...groups.values()].sort((a, b) => b.lastAt.getTime() - a.lastAt.getTime()).slice(0, 200) });
  });
  r.delete("/errors", async (req, res) => {
    const fp = typeof req.query.fingerprint === "string" ? req.query.fingerprint.slice(0, 40) : "";
    const deleted = fp ? await store.deleteErrors({ fingerprint: fp }) : await store.clearErrors();
    void audit(res, fp ? "errors.delete_group" : "errors.clear", fp || undefined, `${deleted} qeyd`);
    res.json({ ok: true, deleted });
  });

  // ---- Ümumi baxış və sistem vəziyyəti ----
  r.get("/overview", async (_req, res) => {
    const day = 86_400_000;
    const [users, tenants, summary, accounts, pending, errors24, errors7] = await Promise.all([
      store.listUsers(5000), store.listTenants(5000), ai.usageSummary().catch(() => null), ai.billingAccounts().catch(() => null),
      ai.billingRequests("pending").catch(() => null), store.countErrors(new Date(Date.now() - day)), store.countErrors(new Date(Date.now() - 7 * day)),
    ]);
    const now = Date.now();
    const since = (n: number) => users.filter((u) => now - new Date(u.createdAt).getTime() < n * day).length;
    const series: { date: string; users: number }[] = [];
    for (let i = 29; i >= 0; i--) {
      const d = new Date(now - i * day); const key = d.toISOString().slice(0, 10);
      series.push({ date: key, users: users.filter((u) => new Date(u.createdAt).toISOString().slice(0, 10) === key).length });
    }
    const modes: Record<string, number> = {};
    for (const t of tenants) { const m = modeOf(t.config); modes[m] = (modes[m] ?? 0) + 1; }
    const bal = new Map(((accounts?.accounts ?? []) as { tenantId: string; totalAzn: number; spentAzn: number; paidAzn: number }[]).map((a) => [a.tenantId, a]));
    const names = new Map(tenants.map((t) => [t.tenantId, t]));
    const top = ((summary?.tenants ?? []) as { tenantId: string; requests: number; tokens: number }[]).slice(0, 5).map((x) => ({ ...x, businessName: names.get(x.tenantId)?.businessName ?? "(silinib)" }));
    res.json({
      users: { total: users.length, verified: users.filter((u) => u.verified).length, admins: users.filter((u) => isAdmin(config, u)).length, last7d: since(7), last30d: since(30) },
      tenants: { total: tenants.length, modes, widgetActive7d: tenants.filter((t) => t.widget?.lastSeenAt && now - new Date(t.widget.lastSeenAt).getTime() < 7 * day).length, emptyBalance: tenants.filter((t) => { const b = bal.get(t.tenantId); return b && b.totalAzn <= 0; }).length },
      usage: summary ? { today: summary.today, thisMonth: summary.thisMonth, lastMonth: summary.lastMonth } : null,
      pendingTopups: ((pending?.requests ?? []) as unknown[]).length,
      revenueAzn: Math.round([...bal.values()].reduce((s, b) => s + (b.paidAzn ?? 0), 0) * 100) / 100,
      errors: { last24h: errors24, last7d: errors7 },
      signups: series, topTenants: top,
    });
  });

  r.get("/health", async (_req, res) => {
    const time = async (fn: () => Promise<unknown>) => { const t0 = Date.now(); try { await fn(); return { ok: true, ms: Date.now() - t0 }; } catch (e) { return { ok: false, ms: Date.now() - t0, error: e instanceof Error ? e.message.slice(0, 120) : "xəta" }; } };
    const [db, aiSvc] = await Promise.all([time(() => store.listUsers(1)), time(() => ai.usageSummary())]);
    const mem = process.memoryUsage();
    res.json({
      database: db, ai: aiSvc,
      mail: { configured: Boolean(config.resendApiKey), from: config.mailFrom },
      server: { uptimeSec: Math.round(process.uptime()), node: process.version, memoryMb: Math.round(mem.rss / 1048576), production: config.isProd },
    });
  });

  // ---- Audit jurnalı ----
  r.get("/audit", async (_req, res) => { res.json({ items: await store.listAudit(200) }); });

  // ---- Elan: bütün müştərilərin panelində yuxarıda göstərilir ----
  r.get("/announcement", async (_req, res) => { res.json({ announcement: await store.getAnnouncement() }); });
  r.put("/announcement", async (req, res) => {
    const b = (req.body ?? {}) as { text?: unknown; level?: unknown; active?: unknown };
    const text = typeof b.text === "string" ? b.text.trim().slice(0, 300) : "";
    if (!text) throw new HttpError(400, "Elan mətni boşdur");
    const level = b.level === "warn" || b.level === "critical" ? b.level : "info";
    const a = { text, level, active: b.active !== false, updatedAt: new Date(), by: currentUser(res).email } as const;
    await store.setAnnouncement({ ...a });
    void audit(res, a.active ? "announcement.set" : "announcement.hide", undefined, text);
    res.json({ announcement: a });
  });
  r.delete("/announcement", async (_req, res) => { await store.setAnnouncement(null); void audit(res, "announcement.delete"); res.json({ ok: true }); });

  // ---- İstifadəçi siyahısı CSV (Excel-də formul inyeksiyasına qarşı qorunur) ----
  r.get("/users.csv", async (_req, res) => {
    const [users, tenants] = await Promise.all([store.listUsers(5000), store.listTenants(5000)]);
    const byUser = new Map(tenants.map((t) => [t.userId, t]));
    const lines = [["email", "verified", "admin", "createdAt", "business", "domain", "mode"].join(",")];
    for (const u of users) { const t = byUser.get(u.id); lines.push([u.email, u.verified, isAdmin(config, u), new Date(u.createdAt).toISOString(), t?.businessName, t?.domain, t ? modeOf(t.config) : ""].map(csvCell).join(",")); }
    void audit(res, "users.export", undefined, `${users.length} sətir`);
    res.set({ "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": 'attachment; filename="users.csv"' }).send("\uFEFF" + lines.join("\n"));
  });

  return r;
}
