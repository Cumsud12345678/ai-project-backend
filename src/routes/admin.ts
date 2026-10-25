import { modeOf } from "../widget.js";
import { Router } from "express";
import { deleteAccount } from "../account.js";
import type { Deps } from "../deps.js";
import { isAdmin, isOwner } from "../deps.js";
import { HttpError } from "../http.js";
import { currentUser, requireAdmin, requireAuth } from "../middleware.js";
import { notifyTopupDone, parseAmount } from "../billing.js";

export function adminRoutes(deps: Deps) {
  const { store, ai, config } = deps;
  const r = Router();
  r.use(requireAuth, requireAdmin(deps));

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
    console.log(`[admin] ${currentUser(res).email} yükləmə sorğusunu ${action === "approve" ? "təsdiqlədi" : "rədd etdi"}: ${req.params.id}`);
    res.json(out);
  });
  r.get("/tenants/:tenantId/billing", async (req, res) => { res.json(await ai.billing(await known(req.params.tenantId), true)); });
  r.post("/tenants/:tenantId/billing/topup", async (req, res) => {
    const tenantId = await known(req.params.tenantId);
    const b = (req.body ?? {}) as { amountAzn?: unknown; note?: unknown };
    const amount = parseAmount(b.amountAzn, { allowNegative: true });
    const out = await ai.billingTopup(tenantId, { amountAzn: amount, note: typeof b.note === "string" ? b.note.slice(0, 200) : "", by: currentUser(res).email });
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
    console.log(`[admin] ${currentUser(res).email} hesabı sildi: ${target.email}${hadTenant ? " (müştəri ilə birlikdə)" : ""}`);
    res.json({ ok: true });
  });

  return r;
}
