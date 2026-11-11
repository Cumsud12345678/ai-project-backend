import { modeOf } from "../widget.js";
import { Router } from "express";
import { deleteAccount } from "../account.js";
import type { Deps } from "../deps.js";
import { isAdmin, isOwner } from "../deps.js";
import { HttpError } from "../http.js";
import { currentUser, requireAdmin, requireAuth } from "../middleware.js";
import { normalizeEmail } from "../security.js";
import { notifyOrderDone, notifyTopupDone, parseAmount } from "../billing.js";
import { invalidateEntitlements } from "../plans.js";
import { publicPlans } from "../public-plans.js";
import { ALERT_KINDS, alertLog, getAlertSettings, healthState, saveAlertSettings, sendAlert } from "../alerts.js";
import { getPartnerSettings, normalizeCode, partnerCustomers, savePartnerSettings, syncThrottled, validCode, validRate } from "../partners.js";
import { notifyAvailable, notifyBotName, sendNotify, userLinkUrl } from "../operator-notify.js";
import type { TenantRecord, User } from "../store/types.js";
import { blockDomain, domainGroups, domainRoot, markDomainOk, unblockDomain } from "../domains.js";
import type { ErrorSource } from "../store/types.js";

const LARGE_AZN = 100;
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

  /** Müştəri ID-lərindən ad, domen və sahibin e-poçtu (yalnız lazım olanlar oxunur, bütün baza yox) */
  const tenantNames = async (tenantIds: string[]) => {
    const tenants = await store.findTenantsByIds([...new Set(tenantIds)]);
    const owners = await store.findUsersByIds([...new Set(tenants.map((t) => t.userId))]);
    const email = new Map(owners.map((u) => [u.id, u.email]));
    const map = new Map(tenants.map((t) => [t.tenantId, { businessName: t.businessName, domain: t.domain, email: email.get(t.userId) ?? "", suspended: Boolean(t.suspended) }]));
    return (id: string) => map.get(id) ?? { businessName: "(silinib)", domain: "", email: "", suspended: false };
  };
  type Balance = { tenantId: string; totalAzn: number; paidAzn: number; spentAzn: number };
  const USER_FILTERS = ["all", "tenants", "unverified", "admins", "lowbal", "suspended"] as const;

  // Səhifələnmiş siyahı: axtarış (e-poçt, sayt adı, domen, müştəri ID) və süzgəc bazada işləyir
  r.get("/users", async (req, res) => {
    const q = typeof req.query.q === "string" ? req.query.q.trim().slice(0, 100) : "";
    const filter = (USER_FILTERS as readonly string[]).includes(String(req.query.filter)) ? String(req.query.filter) as (typeof USER_FILTERS)[number] : "all";
    const limit = Math.min(100, Math.max(5, Number(req.query.limit) || 25));
    const page = Math.max(1, Math.floor(Number(req.query.page) || 1));
    const accounts = await ai.billingAccounts().catch(() => null);
    const balances = new Map(((accounts?.accounts ?? []) as Balance[]).map((a) => [a.tenantId, a]));

    let ids: string[] | undefined;
    if (filter === "tenants") ids = await store.tenantUserIds({});
    else if (filter === "suspended") ids = await store.tenantUserIds({ suspended: true });
    else if (filter === "lowbal") ids = await store.tenantUserIds({ tenantIds: [...balances.values()].filter((b) => b.totalAzn <= 0).map((b) => b.tenantId) });
    const search = q ? { text: q, ids: await store.tenantUserIds({ text: q }) } : undefined;
    const base = { ...(ids && { ids }), ...(search && { search }), ...(filter === "unverified" && { verified: false }), ...(filter === "admins" && { admins: config.adminEmails }) };

    const [{ items, total }, counts] = await Promise.all([
      store.pageUsers({ ...base, skip: (page - 1) * limit, limit }),
      Promise.all([store.countUsers(), store.tenantStats(new Date(0)), store.countUsers({ verified: true }), store.countUsers({ verified: false })]),
    ]);
    const tenants = await store.findTenantsByUserIds(items.map((u) => u.id));
    const byUser = new Map(tenants.map((t) => [t.userId, t]));
    res.json({
      total, page, limit, pages: Math.max(1, Math.ceil(total / limit)),
      counts: { users: counts[0], tenants: counts[1].total, verified: counts[2], unverified: counts[3] },
      users: items.map((u) => {
        const t = byUser.get(u.id);
        return {
          id: u.id, email: u.email, verified: u.verified, isAdmin: isAdmin(config, u), isOwner: isOwner(config, u), createdAt: u.createdAt, twoFactor: Boolean(u.totp),
          tenant: t ? { mode: modeOf(t.config), balance: balances.get(t.tenantId) ?? null, tenantId: t.tenantId, businessName: t.businessName, domain: t.domain, createdAt: t.createdAt, keyRotatedAt: t.keyRotatedAt ?? null, brandRemoved: Boolean(t.brandRemoved), suspended: t.suspended ? { at: t.suspended.at, by: t.suspended.by, reason: t.suspended.reason } : null } : null,
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
    const summary = await ai.usageSummary();
    const rows = (summary.tenants ?? []) as { tenantId: string; requests: number; tokens: number }[];
    const name = await tenantNames(rows.map((x) => x.tenantId));
    res.json({ ...summary, tenants: rows.map((x) => ({ ...x, businessName: name(x.tenantId).businessName, domain: name(x.tenantId).domain })) });
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
    const out = await ai.billingRequests(status);
    const rows = (out.requests ?? []) as { tenantId: string }[];
    const name = await tenantNames(rows.map((x) => x.tenantId));
    res.json({ requests: rows.map((x) => { const n = name(x.tenantId); return { ...x, businessName: n.businessName, domain: n.domain, email: n.email }; }) });
  });
  r.post("/billing/requests/:id/:action", async (req, res) => {
    const action = req.params.action;
    if (action !== "approve" && action !== "reject") throw new HttpError(400, "action approve və ya reject olmalıdır");
    const out = await ai.billingResolve(String(req.params.id), action, currentUser(res).email);
    if (action === "approve" && !out.duplicate && out.request?.tenantId) {
      const t = await tenantInfo(String(out.request.tenantId));
      if (t) void (out.request.kind === "plan" || out.request.kind === "pack" ? notifyOrderDone(deps, t, out) : notifyTopupDone(deps, t, Number(out.request.amountAzn), out.balance?.totalAzn));
    }
    void audit(res, action === "approve" ? "billing.approve" : "billing.reject", String(req.params.id));
    console.log(`[admin] ${currentUser(res).email} yükləmə sorğusunu ${action === "approve" ? "təsdiqlədi" : "rədd etdi"}: ${req.params.id}`);
    res.json(out);
  });
  r.get("/tenants/:tenantId/billing", async (req, res) => { res.json(await ai.billing(await known(req.params.tenantId), true)); });
  r.post("/tenants/:tenantId/billing/topup", async (req, res) => {
    const tenantId = await known(req.params.tenantId);
    const b = (req.body ?? {}) as { amountAzn?: unknown; note?: unknown; confirmLarge?: unknown };
    const amount = parseAmount(b.amountAzn, { allowNegative: true });
    // Səhv rəqəm (artıq sıfır, mənfi işarə) pula başa gəlir: 100 AZN və daha böyük düzəliş ayrıca təsdiq istəyir
    if (Math.abs(amount) >= LARGE_AZN && b.confirmLarge !== true) throw new HttpError(400, "Böyük məbləğ: təsdiq lazımdır", "CONFIRM_REQUIRED");
    const out = await ai.billingTopup(tenantId, { amountAzn: amount, note: typeof b.note === "string" ? b.note.slice(0, 200) : "", by: currentUser(res).email });
    void audit(res, "billing.topup", tenantId, `${amount} AZN${typeof b.note === "string" && b.note ? ` · ${b.note}` : ""}`);
    console.log(`[admin] ${currentUser(res).email} ${tenantId} balansını dəyişdi: ${amount} AZN`);
    if (amount > 0) { const t = await tenantInfo(tenantId); if (t) void notifyTopupDone(deps, t, amount, out.balance?.totalAzn); }
    res.json(out);
  });
  // ---- Abunə planları (admin) ----
  // Kataloq: qiymət, cavab limiti, operator sayı və imkanlar. Dəyişiklik mövcud abunələrin limitinə növbəti dövrdən təsir edir.
  r.get("/billing/plans", async (_req, res) => { res.json(await ai.billingPlans()); });
  r.put("/billing/plans", async (req, res) => {
    const out = await ai.setBillingPlans((req.body ?? {}) as object);
    invalidateEntitlements(); publicPlans.at = 0;
    void audit(res, "billing.plans", "catalog", JSON.stringify((out.plans ?? []).map((p: { id: string; priceAzn: number; replies: number }) => `${p.id}:${p.priceAzn}/${p.replies}`)));
    res.json(out);
  });
  // Müştəriyə plan vermək (pulsuz/endirim, days gün) və ya götürmək (plan: null)
  r.post("/tenants/:tenantId/billing/plan", async (req, res) => {
    const tenantId = await known(req.params.tenantId);
    const b = (req.body ?? {}) as { plan?: unknown; days?: unknown; note?: unknown };
    const plan = b.plan === null ? null : typeof b.plan === "string" && b.plan ? b.plan.slice(0, 20) : undefined;
    if (plan === undefined) throw new HttpError(400, "Plan seçin");
    const days = Number(b.days ?? 30);
    if (plan !== null && (!Number.isFinite(days) || days < 1 || days > 3650)) throw new HttpError(400, "Gün sayı 1–3650 olmalıdır");
    const out = await ai.billingPlanAssign(tenantId, { plan, days, note: typeof b.note === "string" ? b.note.slice(0, 200) : "", by: currentUser(res).email });
    invalidateEntitlements(tenantId);
    void audit(res, "billing.plan", tenantId, plan === null ? "plan götürüldü" : `${plan} · ${days} gün${typeof b.note === "string" && b.note ? ` · ${b.note}` : ""}`);
    res.json(out);
  });

  // "Powered by" yazısını söndürmək/qaytarmaq (ödənişli xidmət, yalnız admin)
  r.patch("/tenants/:tenantId/branding", async (req, res) => {
    const tenantId = await known(req.params.tenantId);
    const removed = (req.body as { removed?: unknown } | undefined)?.removed;
    if (typeof removed !== "boolean") throw new HttpError(400, "removed true/false olmalıdır");
    await store.updateTenant(tenantId, { brandRemoved: removed });
    void audit(res, "branding.set", tenantId, removed ? "yazı silindi" : "yazı qaytarıldı");
    res.json({ ok: true, brandRemoved: removed });
  });
  r.patch("/tenants/:tenantId/billing/settings", async (req, res) => {
    const tenantId = await known(req.params.tenantId);
    const b = (req.body ?? {}) as { markup?: unknown; creditLimitAzn?: unknown; dailyLimitAzn?: unknown };
    const patch: { markup?: number | null; creditLimitAzn?: number; dailyLimitAzn?: number | null } = {};
    if (b.markup !== undefined) patch.markup = b.markup === null || b.markup === "" ? null : Number(b.markup);
    if (b.creditLimitAzn !== undefined) patch.creditLimitAzn = Number(b.creditLimitAzn);
    // null = ümumi qayda (BILLING_DAILY_LIMIT_AZN), 0 = limitsiz
    if (b.dailyLimitAzn !== undefined) patch.dailyLimitAzn = b.dailyLimitAzn === null || b.dailyLimitAzn === "" ? null : Number(b.dailyLimitAzn);
    if ((patch.markup !== undefined && patch.markup !== null && !Number.isFinite(patch.markup)) || (patch.creditLimitAzn !== undefined && !Number.isFinite(patch.creditLimitAzn)) || (patch.dailyLimitAzn != null && !Number.isFinite(patch.dailyLimitAzn))) throw new HttpError(400, "Dəyər düzgün deyil");
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
    // Rol dəyişəndə köhnə (uzun ömürlü) sessiyalar bağlanır: yeni admin qısa sessiya və 2FA ilə yenidən daxil olur
    await store.deleteSessionsForUser(target.id);
    void audit(res, "user.role", target.email, role);
    console.log(`[admin] ${currentUser(res).email} ${target.email} üçün rolu dəyişdi: ${role}`);
    res.json({ ok: true, id: target.id, isAdmin: role === "admin" });
  });

  // Bütün cihazlardan çıxış (məs. hesab oğurlanmış ola bilər). Admin özünün sessiyalarını burada bağlamır: Ayarlar səhifəsindən.
  r.post("/users/:id/revoke-sessions", async (req, res) => {
    const target = await store.findUserById(String(req.params.id));
    if (!target) throw new HttpError(404, "İstifadəçi tapılmadı");
    if (target.id === currentUser(res).id) throw new HttpError(400, "Öz sessiyalarını Ayarlar səhifəsindən bağla", "CANNOT_CHANGE_SELF");
    await store.deleteSessionsForUser(target.id);
    void audit(res, "user.revoke_sessions", target.email);
    res.json({ ok: true });
  });

  // İki addımlı girişi sıfırlayır (telefon itib, ehtiyat kodlar yoxdur). Əsas adminin 2FA-nı yalnız əsas admin sıfırlaya bilər.
  r.post("/users/:id/reset-2fa", async (req, res) => {
    const target = await store.findUserById(String(req.params.id));
    if (!target) throw new HttpError(404, "İstifadəçi tapılmadı");
    const actor = currentUser(res);
    if (target.id === actor.id) throw new HttpError(400, "Öz iki addımlı girişini burada sıfırlaya bilməzsən", "CANNOT_CHANGE_SELF");
    if (isOwner(config, target) && !isOwner(config, actor)) throw new HttpError(403, "Əsas adminin iki addımlı girişini yalnız əsas admin sıfırlaya bilər", "OWNER_ROLE_FIXED");
    await store.updateUser(target.id, { totp: null, totpPending: null });
    await store.deleteSessionsForUser(target.id);
    void audit(res, "user.reset_2fa", target.email);
    res.json({ ok: true });
  });

  // ---- Müştərini dayandırmaq / bərpa etmək ----
  // Dayandırılmış müştərinin vidjeti görünmür, Telegram/WhatsApp cavab vermir, API açarı ilə sorğular 402 alır.
  // Hesab, məlumat və balans silinmir: sahib panelə daxil ola bilir və səbəbi görür.
  const suspendMail = (t: TenantRecord, owner: User | null, on: boolean, reason: string) => {
    if (!owner) return;
    const subject = on ? `Hesab dayandırıldı: ${t.businessName}` : `Hesab bərpa olundu: ${t.businessName}`;
    const body = on
      ? `${t.businessName} (${t.domain}) üçün çat xidməti müvəqqəti dayandırıldı.\n\nSəbəb: ${reason}\n\nMəlumatların və balansın silinməyib. Sual üçün bu məktuba cavab yaz.`
      : `${t.businessName} (${t.domain}) üçün çat xidməti yenidən aktivdir. Vidjet, kanallar və API əvvəlki kimi işləyir.`;
    deps.mailer.send(owner.email, subject, body).catch((e) => console.error("[mail] dayandırma bildirişi:", e));
  };
  r.post("/tenants/:tenantId/suspend", async (req, res) => {
    const tenantId = await known(req.params.tenantId);
    const reason = typeof req.body?.reason === "string" ? req.body.reason.trim().slice(0, 300) : "";
    if (reason.length < 3) throw new HttpError(400, "Səbəbi yaz (sahibə email ilə göndəriləcək)", "REASON_REQUIRED");
    const t = (await store.findTenantById(tenantId))!;
    await ai.suspendTenant(tenantId, true);
    const suspended = { at: new Date(), by: currentUser(res).email, reason };
    await store.updateTenant(tenantId, { suspended });
    void audit(res, "tenant.suspend", tenantId, reason);
    console.log(`[admin] ${currentUser(res).email} müştərini dayandırdı: ${tenantId} (${reason})`);
    if (req.body?.notify !== false) suspendMail(t, await store.findUserById(t.userId), true, reason);
    res.json({ ok: true, suspended });
  });
  // ---- Domenlər: eyni sayt fərqli hesablarda (pulsuz balans sui-istifadəsi), domen bloku ----
  r.get("/domains", async (req, res) => {
    const f = String(req.query.f ?? "dup");
    const q = String(req.query.q ?? "").trim().toLowerCase();
    const all = await domainGroups(store);
    const dup = (g: (typeof all)[number]) => g.suspicious;
    const pick = f === "blocked" ? all.filter((g) => g.block) : f === "all" ? all : f === "ok" ? all.filter((g) => g.ok) : all.filter(dup);
    const found = q ? pick.filter((g) => g.root.includes(q) || g.accounts.some((a) => a.email.toLowerCase().includes(q) || a.businessName.toLowerCase().includes(q) || a.host.includes(q))) : pick;
    res.json({ groups: found.slice(0, 300), counts: { all: all.length, dup: all.filter(dup).length, blocked: all.filter((g) => g.block).length, ok: all.filter((g) => g.ok).length } });
  });
  r.post("/domains/ok", async (req, res) => {
    const domain = domainRoot(String(req.body?.domain ?? ""));
    const g = (await domainGroups(store)).find((x) => x.root === domain);
    if (!g) throw new HttpError(404, "Domen tapılmadı", "NOT_FOUND");
    const ok = req.body?.ok !== false;
    await markDomainOk(store, domain, g.accounts.length, currentUser(res).email, ok);
    void audit(res, ok ? "domain.ok" : "domain.unok", domain);
    res.json({ ok: true });
  });
  r.post("/domains/block", async (req, res) => {
    const domain = domainRoot(String(req.body?.domain ?? ""));
    const reason = typeof req.body?.reason === "string" ? req.body.reason.trim().slice(0, 300) : "";
    if (!domain || !domain.includes(".")) throw new HttpError(400, "Domen düzgün deyil", "BAD_DOMAIN");
    if (reason.length < 3) throw new HttpError(400, "Səbəbi yaz", "REASON_REQUIRED");
    const by = currentUser(res).email;
    const suspendReason = `Domen bloklanıb: ${reason}`;
    try {
      const b = await blockDomain(deps, domain, reason, by, async (tenantId) => {
        try {
          const t = await store.findTenantById(tenantId);
          if (!t) return false;
          await ai.suspendTenant(tenantId, true);
          await store.updateTenant(tenantId, { suspended: { at: new Date(), by, reason: suspendReason } });
          if (req.body?.notify !== false) suspendMail(t, await store.findUserById(t.userId), true, suspendReason);
          return true;
        } catch (e) { console.error(`[admin] domen bloku: ${tenantId} dayandırıla bilmədi`, e); return false; }
      }, req.body?.suspend === true);
      void audit(res, "domain.block", domain, `${reason}${b.suspended.length ? ` · ${b.suspended.length} hesab dayandırıldı` : ""}`);
      res.json({ ok: true, block: b });
    } catch (e) {
      if ((e as { code?: string }).code === "ALREADY_BLOCKED") throw new HttpError(409, "Bu domen artıq bloklanıb", "ALREADY_BLOCKED");
      throw e;
    }
  });
  r.post("/domains/unblock", async (req, res) => {
    const domain = domainRoot(String(req.body?.domain ?? ""));
    const b = await unblockDomain(store, domain);
    if (!b) throw new HttpError(404, "Bu domen bloklanmayıb", "NOT_BLOCKED");
    let restored = 0;
    if (req.body?.restore !== false) {
      for (const tenantId of b.suspended) {
        const t = await store.findTenantById(tenantId);
        // Yalnız blokun dayandırdığı və hələ də o səbəblə dayanan hesablar (sonra başqa səbəblə dayandırılanlara toxunulmur)
        if (!t?.suspended || !t.suspended.reason.startsWith("Domen bloklanıb")) continue;
        try { await ai.suspendTenant(tenantId, false); await store.updateTenant(tenantId, { suspended: null }); restored++; suspendMail(t, await store.findUserById(t.userId), false, ""); }
        catch (e) { console.error(`[admin] domen bloku götürüldü, amma ${tenantId} bərpa olunmadı`, e); }
      }
    }
    void audit(res, "domain.unblock", domain, restored ? `${restored} hesab bərpa olundu` : undefined);
    res.json({ ok: true, restored });
  });

  r.post("/tenants/:tenantId/unsuspend", async (req, res) => {
    const tenantId = await known(req.params.tenantId);
    const t = (await store.findTenantById(tenantId))!;
    await ai.suspendTenant(tenantId, false);
    await store.updateTenant(tenantId, { suspended: null });
    void audit(res, "tenant.unsuspend", tenantId);
    console.log(`[admin] ${currentUser(res).email} müştərini bərpa etdi: ${tenantId}`);
    if (t.suspended && req.body?.notify !== false) suspendMail(t, await store.findUserById(t.userId), false, "");
    res.json({ ok: true });
  });

  // ---- Maliyyə: pul girişi, AI xərci, mənfəət, model və müştəri üzrə ----
  r.get("/finance", async (req, res) => {
    const months = Number(req.query.months) || 6;
    const fin = await ai.billingFinance(months);
    const rows = (fin.tenants ?? []) as { tenantId: string }[];
    const name = await tenantNames(rows.map((x) => x.tenantId));
    res.json({ ...fin, tenants: rows.map((x) => ({ ...x, ...name(x.tenantId) })) });
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
    const now = Date.now();
    const ago = (n: number) => new Date(now - n * day);
    // Hamısı bazada sayılır: istifadəçi və müştəri siyahıları yaddaşa yüklənmir
    const [total, verified, admins, last7d, last30d, signupRows, stats, summary, accounts, pending, errors24, errors7, fin, control, domains] = await Promise.all([
      store.countUsers(), store.countUsers({ verified: true }), store.countUsers({ admins: config.adminEmails }), store.countUsers({ since: ago(7) }), store.countUsers({ since: ago(30) }),
      store.signupsByDay(ago(30)), store.tenantStats(ago(7)),
      ai.usageSummary().catch(() => null), ai.billingAccounts().catch(() => null),
      ai.billingRequests("pending").catch(() => null), store.countErrors(ago(1)), store.countErrors(ago(7)),
      ai.billingFinance(1).catch(() => null), ai.aiControl().catch(() => null),
      domainGroups(store).catch(() => []),
    ]);
    const byDay = new Map(signupRows.map((r) => [r.date, r.users]));
    const series: { date: string; users: number }[] = [];
    for (let i = 29; i >= 0; i--) { const key = ago(i).toISOString().slice(0, 10); series.push({ date: key, users: byDay.get(key) ?? 0 }); }
    const bal = (accounts?.accounts ?? []) as Balance[];
    const topRows = ((summary?.tenants ?? []) as { tenantId: string; requests: number; tokens: number }[]).slice(0, 5);
    const name = await tenantNames(topRows.map((x) => x.tenantId));
    const top = topRows.map((x) => ({ ...x, businessName: name(x.tenantId).businessName }));
    res.json({
      users: { total, verified, admins, last7d, last30d },
      tenants: { total: stats.total, modes: stats.modes, suspended: stats.suspended, widgetActive7d: stats.widgetActive, emptyBalance: bal.filter((b) => b.totalAzn <= 0).length },
      aiControl: control,
      usage: summary ? { today: summary.today, thisMonth: summary.thisMonth, lastMonth: summary.lastMonth } : null,
      pendingTopups: ((pending?.requests ?? []) as unknown[]).length,
      // Əvvəllər burada qalan ödənişli balansların cəmi göstərilirdi (müştəri xərclədikcə azalırdı). İndi: balansa daxil olan real pul.
      revenueAzn: fin?.totals ? Math.round(Number(fin.totals.cashInAzn) * 100) / 100 : null,
      revenueMonthAzn: fin?.totals ? Math.round(Number(fin.totals.cashInMonthAzn) * 100) / 100 : null,
      outstandingPaidAzn: fin?.totals ? Math.round(Number(fin.totals.outstandingPaidAzn) * 100) / 100 : null,
      monthProfitAzn: fin?.months?.length ? Math.round(Number(fin.months[fin.months.length - 1].profitAzn) * 100) / 100 : null,
      errors: { last24h: errors24, last7d: errors7 },
      domains: { suspicious: domains.filter((g) => g.suspicious).length, blocked: domains.filter((g) => g.block).length },
      signups: series, topTenants: top,
    });
  });

  r.get("/health", async (_req, res) => {
    const time = async (fn: () => Promise<unknown>) => { const t0 = Date.now(); try { await fn(); return { ok: true, ms: Date.now() - t0 }; } catch (e) { return { ok: false, ms: Date.now() - t0, error: e instanceof Error ? e.message.slice(0, 120) : "xəta" }; } };
    const [db, aiSvc] = await Promise.all([time(() => store.countUsers({ ids: [] })), time(() => ai.ping())]);
    const mem = process.memoryUsage();
    res.json({
      database: db, ai: aiSvc,
      mail: { configured: Boolean(config.resendApiKey), from: config.mailFrom },
      server: { uptimeSec: Math.round(process.uptime()), node: process.version, memoryMb: Math.round(mem.rss / 1048576), production: config.isProd },
    });
  });

  // ---- Audit jurnalı ----
  // Süzgəc: actor (kim), action (əməliyyat növü, prefiks: "billing", "user.role"), q (hədəf/təfərrüat); before ilə səhifələmə
  r.get("/audit", async (req, res) => {
    const str = (v: unknown, n = 80) => (typeof v === "string" && v.trim() ? v.trim().slice(0, n) : undefined);
    const beforeRaw = str(req.query.before, 40);
    const before = beforeRaw && !Number.isNaN(new Date(beforeRaw).getTime()) ? new Date(beforeRaw) : undefined;
    const limit = Math.min(200, Math.max(10, Number(req.query.limit) || 50));
    const items = await store.queryAudit({ actor: str(req.query.actor), action: str(req.query.action, 40), text: str(req.query.q), before, limit: limit + 1 });
    res.json({ items: items.slice(0, limit), nextBefore: items.length > limit ? items[limit - 1]!.at : null });
  });

  // ---- Elan: bütün müştərilərin panelində yuxarıda göstərilir ----
  // Keçmiş elanlar (son 20): təkrar istifadə və ya silmək üçün
  type AnnHist = { id: string; text: string; level: "info" | "warn" | "critical"; by: string; at: string };
  const HIST = "announcement_history";
  const EXPIRES_H = [1, 6, 24, 72, 168];
  const annView = async () => {
    const a = await store.getAnnouncement();
    const expired = Boolean(a?.expiresAt && new Date(a.expiresAt).getTime() <= Date.now());
    return { announcement: a, expired, history: (await store.getSetting<AnnHist[]>(HIST)) ?? [] };
  };
  r.get("/announcement", async (_req, res) => { res.json(await annView()); });
  r.put("/announcement", async (req, res) => {
    const b = (req.body ?? {}) as { text?: unknown; level?: unknown; active?: unknown; expiresInH?: unknown };
    const text = typeof b.text === "string" ? b.text.trim().slice(0, 300) : "";
    if (!text) throw new HttpError(400, "Elan mətni boşdur");
    const level: AnnHist["level"] = b.level === "warn" || b.level === "critical" ? b.level : "info";
    const prev = await store.getAnnouncement();
    // expiresInH verilməyibsə (məs. "Gizlət") əvvəlki müddət qalır; null = müddətsiz
    const expiresAt = b.expiresInH === undefined ? prev?.expiresAt ?? null
      : typeof b.expiresInH === "number" && EXPIRES_H.includes(b.expiresInH) ? new Date(Date.now() + b.expiresInH * 3_600_000) : null;
    const by = currentUser(res).email;
    const a = { text, level, active: b.active !== false, updatedAt: new Date(), by, expiresAt };
    await store.setAnnouncement({ ...a });
    if (a.active && (prev?.text !== text || prev?.level !== level)) {
      const hist = ((await store.getSetting<AnnHist[]>(HIST)) ?? []).filter((h) => h.text !== text);
      await store.setSetting(HIST, [{ id: Math.random().toString(36).slice(2, 10), text, level, by, at: new Date().toISOString() }, ...hist].slice(0, 20));
    }
    void audit(res, a.active ? "announcement.set" : "announcement.hide", undefined, text);
    res.json(await annView());
  });
  r.delete("/announcement", async (_req, res) => { await store.setAnnouncement(null); void audit(res, "announcement.delete"); res.json(await annView()); });
  r.delete("/announcement/history/:id", async (req, res) => {
    const hist = (await store.getSetting<AnnHist[]>(HIST)) ?? [];
    await store.setSetting(HIST, hist.filter((h) => h.id !== req.params.id));
    res.json(await annView());
  });

  // ---- İstifadəçi siyahısı CSV (Excel-də formul inyeksiyasına qarşı qorunur) ----
  r.get("/users.csv", async (_req, res) => {
    const users = (await store.pageUsers({ skip: 0, limit: 50_000 })).items;
    const tenants = await store.findTenantsByUserIds(users.map((u) => u.id));
    const byUser = new Map(tenants.map((t) => [t.userId, t]));
    const lines = [["email", "verified", "admin", "createdAt", "business", "domain", "mode"].join(",")];
    for (const u of users) { const t = byUser.get(u.id); lines.push([u.email, u.verified, isAdmin(config, u), new Date(u.createdAt).toISOString(), t?.businessName, t?.domain, t ? modeOf(t.config) : ""].map(csvCell).join(",")); }
    void audit(res, "users.export", undefined, `${users.length} sətir`);
    res.set({ "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": 'attachment; filename="users.csv"' }).send("\uFEFF" + lines.join("\n"));
  });

  // ---- Ödənişlər: yükləmə sorğuları və balans hərəkətləri (bütün müştərilər) ----
  const day = (v: unknown, endOfDay = false) => {
    if (typeof v !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return undefined;
    const d = new Date(`${v}T00:00:00.000Z`);
    if (Number.isNaN(d.getTime())) return undefined;
    return new Date(d.getTime() + (endOfDay ? 86_400_000 : 0)).toISOString();
  };
  /** Süzgəclər: from/to (YYYY-MM-DD, daxil), tenant (müştəri ID, ad və ya domen), before (səhifələmə), limit */
  async function payQuery(q: Record<string, unknown>, extra: Record<string, string> = {}) {
    const out: Record<string, string> = { ...extra };
    const from = day(q.from), to = day(q.to, true);
    if (from) out.since = from;
    if (to) out.until = to;
    if (typeof q.before === "string" && !Number.isNaN(new Date(q.before).getTime())) out.before = new Date(q.before).toISOString();
    out.limit = String(Math.min(200, Math.max(10, Number(q.limit) || 50)));
    let tenant: { tenantId: string; businessName: string; domain: string } | null = null;
    const text = typeof q.tenant === "string" ? q.tenant.trim().slice(0, 100) : "";
    if (text) {
      const found = await store.searchTenants(text, 5);
      if (!found.length) return { query: null, tenant: null, matches: [] };
      tenant = { tenantId: found[0]!.tenantId, businessName: found[0]!.businessName, domain: found[0]!.domain };
      out.tenantId = tenant.tenantId;
      return { query: out, tenant, matches: found.map((t) => ({ tenantId: t.tenantId, businessName: t.businessName, domain: t.domain })) };
    }
    return { query: out, tenant, matches: [] };
  }
  r.get("/payments/requests", async (req, res) => {
    const status = ["pending", "approved", "rejected"].includes(String(req.query.status)) ? String(req.query.status) : "all";
    const p = await payQuery(req.query, { status });
    if (!p.query) return void res.json({ requests: [], nextBefore: null, tenant: null, matches: [] });
    const out = await ai.billingRequestsQuery(p.query);
    const rows = (out.requests ?? []) as { tenantId: string }[];
    const name = await tenantNames(rows.map((x) => x.tenantId));
    res.json({ requests: rows.map((x) => ({ ...x, ...name(x.tenantId) })), nextBefore: out.nextBefore ?? null, tenant: p.tenant, matches: p.matches });
  });
  r.get("/payments/ledger", async (req, res) => {
    const kind = ["payment", "manual", "adjust"].includes(String(req.query.kind)) ? { kind: String(req.query.kind) } : ({} as Record<string, string>);
    const p = await payQuery(req.query, kind);
    if (!p.query) return void res.json({ entries: [], nextBefore: null, tenant: null, matches: [], totals: null });
    const out = await ai.billingLedger(p.query);
    const rows = (out.entries ?? []) as { tenantId: string; amountAzn: number; kind: string }[];
    const name = await tenantNames(rows.map((x) => x.tenantId));
    res.json({ entries: rows.map((x) => ({ ...x, ...name(x.tenantId) })), nextBefore: out.nextBefore ?? null, tenant: p.tenant, matches: p.matches });
  });
  // CSV: eyni süzgəclə, ən çox 20 000 sətir (səhifə-səhifə oxunur)
  r.get("/payments/ledger.csv", async (req, res) => {
    const kind = ["payment", "manual", "adjust"].includes(String(req.query.kind)) ? { kind: String(req.query.kind) } : ({} as Record<string, string>);
    const p = await payQuery({ ...req.query, limit: 200, before: undefined }, kind);
    const rows: { id: string; tenantId: string; at: string; kind: string; amountAzn: number; note: string; by: string }[] = [];
    let before: string | undefined;
    while (p.query && rows.length < 20_000) {
      const out = await ai.billingLedger({ ...p.query, ...(before && { before }) });
      rows.push(...((out.entries ?? []) as typeof rows));
      if (!out.nextBefore) break;
      before = String(out.nextBefore);
    }
    const name = await tenantNames(rows.map((x) => x.tenantId));
    const kindLabel: Record<string, string> = { payment: "ödəniş", manual: "əl ilə", adjust: "düzəliş" };
    const lines = [["tarix", "növ", "məbləğ_azn", "müştəri", "domen", "e-poçt", "müştəri_id", "qeyd", "kim"].join(",")];
    for (const x of rows) { const n = name(x.tenantId); lines.push([x.at, kindLabel[x.kind] ?? x.kind, x.amountAzn.toFixed(2), n.businessName, n.domain, n.email, x.tenantId, x.note, x.by].map(csvCell).join(",")); }
    void audit(res, "payments.export", p.tenant?.tenantId, `${rows.length} sətir`);
    res.set({ "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": 'attachment; filename="odenisler.csv"' }).send("\uFEFF" + lines.join("\n"));
  });

  // ---- Kanallar: bütün müştərilər üzrə Telegram və WhatsApp vəziyyəti ----
  r.get("/channels", async (_req, res) => {
    const since = new Date(Date.now() - 86_400_000);
    const [tenants, activity, errs] = await Promise.all([store.listChannelTenants(), store.lastChannelActivity(), store.countErrorsByTenant(since, "channel")]);
    const owners = await store.findUsersByIds([...new Set(tenants.map((t) => t.userId))]);
    const email = new Map(owners.map((u) => [u.id, u.email]));
    const lastAt = new Map(activity.map((a) => [`${a.tenantId}|${a.channel}`, a.at]));
    const stale = Date.now() - 7 * 86_400_000;
    const rows = tenants.map((t) => {
      const wa = t.whatsapp ? deps.whatsapp.view(t, config.secretKey) : null;
      const waLast = lastAt.get(`${t.tenantId}|whatsapp`) ?? null, tgLast = lastAt.get(`${t.tenantId}|telegram`) ?? null;
      const problems: string[] = [];
      if (t.whatsapp?.enabled && wa && wa.state !== "open") problems.push(wa.state === "connecting" ? "wa_connecting" : "wa_down");
      if ((errs[t.tenantId] ?? 0) >= 5) problems.push("errors");
      if (t.suspended) problems.push("suspended");
      return {
        tenantId: t.tenantId, businessName: t.businessName, domain: t.domain, email: email.get(t.userId) ?? "",
        telegram: t.telegram ? { enabled: t.telegram.enabled, bot: t.telegram.botUsername, connectedAt: t.telegram.connectedAt, lastAt: tgLast, idle: !tgLast || new Date(tgLast).getTime() < stale } : null,
        whatsapp: t.whatsapp ? { enabled: t.whatsapp.enabled, phone: t.whatsapp.phone ? `${t.whatsapp.phone.slice(0, 5)}•••${t.whatsapp.phone.slice(-2)}` : null, connectedAt: t.whatsapp.connectedAt, state: wa?.state ?? "off", error: wa?.error ?? null, lastAt: waLast, idle: !waLast || new Date(waLast).getTime() < stale } : null,
        errors24h: errs[t.tenantId] ?? 0, problems,
      };
    }).sort((a, b) => b.problems.length - a.problems.length || b.errors24h - a.errors24h);
    res.json({
      rows,
      summary: {
        telegram: rows.filter((x) => x.telegram).length, whatsapp: rows.filter((x) => x.whatsapp).length,
        waOpen: rows.filter((x) => x.whatsapp?.state === "open").length, problems: rows.filter((x) => x.problems.some((p) => p !== "suspended")).length,
        waCapacity: { used: deps.whatsapp.size(), max: 100 },
      },
    });
  });

  // ---- Xəbərdarlıqlar (admin → Ayarlar) ----
  const alertView = async (res: Parameters<typeof currentUser>[0]) => {
    const me = (await store.findUserById(currentUser(res).id)) ?? currentUser(res);
    const admins = await store.listAdmins(config.adminEmails);
    return {
      settings: await getAlertSettings(deps), kinds: ALERT_KINDS,
      telegram: { available: notifyAvailable(deps), bot: notifyBotName(), me: me.tgNotify ? { name: me.tgNotify.name, at: me.tgNotify.at } : null },
      recipients: admins.filter((u) => u.verified).map((u) => ({ email: u.email, telegram: Boolean(u.tgNotify) })),
      mailConfigured: Boolean(config.resendApiKey) || !config.isProd,
      health: healthState(), log: alertLog().slice(0, 20),
    };
  };
  r.get("/alerts", async (_req, res) => { res.json(await alertView(res)); });
  r.put("/alerts", async (req, res) => {
    const s = await saveAlertSettings(deps, req.body);
    void audit(res, "alerts.settings", undefined, JSON.stringify(s));
    res.json(await alertView(res));
  });
  r.post("/alerts/telegram", async (_req, res) => {
    if (!notifyAvailable(deps)) throw new HttpError(503, "Telegram bildirişləri serverdə qoşulmayıb (NOTIFY_TELEGRAM_TOKEN)", "NOTIFY_OFF");
    if (!deps.limiter.hit(`notify:code:${currentUser(res).id}`, 10, 10 * 60_000)) throw new HttpError(429, "Çox tez-tez sorğu", "RATE_LIMITED");
    res.json(userLinkUrl(currentUser(res).id));
  });
  r.delete("/alerts/telegram", async (_req, res) => {
    const me = (await store.findUserById(currentUser(res).id))!;
    if (me.tgNotify && notifyAvailable(deps)) await sendNotify(deps, me.tgNotify.chatId, "Bildirişlər ayrıldı.");
    await store.updateUser(me.id, { tgNotify: null });
    res.json(await alertView(res));
  });
  r.post("/alerts/test", async (_req, res) => {
    const me = (await store.findUserById(currentUser(res).id))!;
    if (!deps.limiter.hit(`alerts:test:${me.id}`, 5, 10 * 60_000)) throw new HttpError(429, "Çox tez-tez sorğu", "RATE_LIMITED");
    const out = await sendAlert(deps, "test", me.id, "Sınaq bildirişi", `Bu, ${me.email} üçün sınaq bildirişidir. Xəbərdarlıqlar belə görünəcək.`, { force: true, only: [me] });
    res.json(out);
  });

  // ---- Partnyorlar ----
  const partnerRow = (u: User, totals: Record<string, { earned: number; adjust: number; paidOut: number; balance: number }>, counts: Map<string, number>) => ({
    id: u.id, email: u.email, code: u.partner!.code, rate: u.partner!.rate, active: u.partner!.active, since: u.partner!.since, note: u.partner!.note ?? "",
    customers: counts.get(u.id) ?? 0, totals: totals[u.id] ?? { earned: 0, adjust: 0, paidOut: 0, balance: 0 },
  });
  const loadPartner = async (id: string) => {
    const u = await store.findUserById(id);
    if (!u?.partner) throw new HttpError(404, "Partnyor tapılmadı");
    return u;
  };
  const codeFree = async (code: string, selfId?: string) => {
    if (!validCode(code)) throw new HttpError(400, "Kod 3–20 simvol olmalıdır: hərf, rəqəm, - və _", "BAD_CODE");
    const other = await store.findUserByPartnerCode(code);
    if (other && other.id !== selfId) throw new HttpError(409, "Bu kod artıq istifadə olunur", "CODE_TAKEN");
  };

  r.get("/partners", async (_req, res) => {
    await syncThrottled(deps);
    const [partners, settings, referred, totals] = await Promise.all([store.listPartners(), getPartnerSettings(deps), store.listReferred(), store.partnerTotals()]);
    const counts = new Map<string, number>();
    for (const c of referred) counts.set(c.referredBy!.partnerId, (counts.get(c.referredBy!.partnerId) ?? 0) + 1);
    res.json({ settings, partners: partners.map((u) => partnerRow(u, totals, counts)) });
  });
  r.put("/partners/settings", async (req, res) => {
    const s = await savePartnerSettings(deps, req.body);
    void audit(res, "partner.settings", undefined, JSON.stringify(s));
    res.json(s);
  });
  // Mövcud istifadəçini partnyor edir (e-poçtla)
  r.post("/partners", async (req, res) => {
    const email = normalizeEmail(req.body?.email);
    const u = email ? await store.findUserByEmail(email) : null;
    if (!u?.verified) throw new HttpError(404, "Bu e-poçtla təsdiqlənmiş hesab tapılmadı. Partnyor əvvəlcə qeydiyyatdan keçməlidir.", "USER_NOT_FOUND");
    if (u.partner) throw new HttpError(409, "Bu istifadəçi artıq partnyordur", "ALREADY_PARTNER");
    const settings = await getPartnerSettings(deps);
    const code = normalizeCode(req.body?.code) || u.email.split("@")[0]!.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 12);
    await codeFree(code);
    const rate = req.body?.rate === undefined || req.body?.rate === "" ? settings.defaultRate : validRate(req.body.rate);
    await store.updateUser(u.id, { partner: { code, rate, active: true, since: new Date(), note: typeof req.body?.note === "string" ? req.body.note.slice(0, 200) : "" } });
    void audit(res, "partner.create", u.email, `${code} · ${rate}%`);
    res.status(201).json({ ok: true, id: u.id, code });
  });
  r.patch("/partners/:id", async (req, res) => {
    const u = await loadPartner(String(req.params.id));
    const p = { ...u.partner! };
    const b = req.body ?? {};
    const changes: string[] = [];
    if (b.code !== undefined) { const code = normalizeCode(b.code); if (code !== p.code) { await codeFree(code, u.id); changes.push(`kod ${p.code}→${code}`); p.code = code; } }
    if (b.rate !== undefined) { const rate = validRate(b.rate); if (rate !== p.rate) { changes.push(`faiz ${p.rate}→${rate}`); p.rate = rate; } }
    if (typeof b.active === "boolean" && b.active !== p.active) { changes.push(b.active ? "aktiv" : "söndürüldü"); p.active = b.active; }
    if (typeof b.note === "string") p.note = b.note.slice(0, 200);
    await store.updateUser(u.id, { partner: p });
    if (changes.length) void audit(res, "partner.update", u.email, changes.join(", "));
    res.json({ ok: true });
  });
  r.get("/partners/:id", async (req, res) => {
    const u = await loadPartner(String(req.params.id));
    await syncThrottled(deps, u.id);
    const [totals, customers, entries] = await Promise.all([store.partnerTotals([u.id]), partnerCustomers(deps, u.id, { revealEmail: true }), store.listPartnerEntries(u.id, 300)]);
    res.json({
      partner: partnerRow(u, totals, new Map([[u.id, customers.length]])),
      customers, entries,
    });
  });
  // Balansı əl ilə dəyişmək. kind=payout: "ödədim" (məbləğ müsbət yazılır, balansdan çıxılır); kind=adjust: ± düzəliş
  r.post("/partners/:id/entries", async (req, res) => {
    const u = await loadPartner(String(req.params.id));
    const kind = req.body?.kind === "payout" ? "payout" : "adjust";
    const amount = parseAmount(req.body?.amountAzn, { allowNegative: kind === "adjust" });
    const note = typeof req.body?.note === "string" ? req.body.note.trim().slice(0, 200) : "";
    if (kind === "adjust" && note.length < 2) throw new HttpError(400, "Düzəlişin səbəbini yaz", "REASON_REQUIRED");
    const totals = (await store.partnerTotals([u.id]))[u.id];
    if (kind === "payout" && amount > (totals?.balance ?? 0) + 0.001) throw new HttpError(400, "Ödəniş balansdan çox ola bilməz", "OVER_BALANCE");
    const value = Math.round((kind === "payout" ? -Math.abs(amount) : amount) * 100) / 100;
    await store.addPartnerEntry({ partnerId: u.id, kind, amountAzn: value, at: new Date(), note: note || (kind === "payout" ? "Ödənildi" : ""), by: currentUser(res).email });
    void audit(res, kind === "payout" ? "partner.payout" : "partner.adjust", u.email, `${value} AZN${note ? ` · ${note}` : ""}`);
    res.json({ ok: true, totals: (await store.partnerTotals([u.id]))[u.id] });
  });
  // Müştərini partnyora əl ilə bağlamaq / ayırmaq. countPast=true: pəncərə müştərinin qeydiyyat tarixindən başlayır
  r.post("/partners/referrals", async (req, res) => {
    const email = normalizeEmail(req.body?.email);
    const customer = email ? await store.findUserByEmail(email) : null;
    if (!customer) throw new HttpError(404, "Müştəri tapılmadı", "USER_NOT_FOUND");
    const code = normalizeCode(req.body?.code);
    if (!code) {
      if (!customer.referredBy) return void res.json({ ok: true });
      await store.updateUser(customer.id, { referredBy: null });
      void audit(res, "partner.detach", customer.email, customer.referredBy.code);
      return void res.json({ ok: true });
    }
    const partner = await store.findUserByPartnerCode(code);
    if (!partner?.partner) throw new HttpError(404, "Bu kodla partnyor yoxdur", "BAD_REF_CODE");
    if (partner.id === customer.id) throw new HttpError(400, "Partnyor özünü gətirə bilməz", "SELF_REFERRAL");
    const at = req.body?.countPast === true ? customer.createdAt : new Date();
    await store.updateUser(customer.id, { referredBy: { partnerId: partner.id, code, at, source: "admin", bonusAt: customer.referredBy?.bonusAt ?? null } });
    void audit(res, "partner.attach", customer.email, `${code}${req.body?.countPast === true ? " · keçmiş ödənişlər daxil" : ""}`);
    await syncThrottled(deps, partner.id, 0);
    res.json({ ok: true });
  });
  r.post("/partners/sync", async (_req, res) => {
    await syncThrottled(deps, undefined, 0);
    res.json({ ok: true });
  });

  // ---- Ümumi AI açarı: bütün müştərilər üçün AI sorğularını dayandırır (məs. provayder problemi, xərc partlayışı) ----
  r.get("/ai-control", async (_req, res) => { res.json(await ai.aiControl()); });
  r.put("/ai-control", async (req, res) => {
    const b = (req.body ?? {}) as { paused?: unknown; reason?: unknown };
    if (typeof b.paused !== "boolean") throw new HttpError(400, "paused true/false olmalıdır");
    const reason = typeof b.reason === "string" ? b.reason.trim().slice(0, 300) : "";
    if (b.paused && reason.length < 3) throw new HttpError(400, "Səbəbi yaz", "REASON_REQUIRED");
    const by = currentUser(res).email;
    const out = await ai.setAiControl({ paused: b.paused, reason, by });
    void audit(res, b.paused ? "ai.pause" : "ai.resume", undefined, reason);
    console.log(`[admin] ${by} AI-ı ${b.paused ? "dayandırdı" : "yenidən açdı"}${reason ? `: ${reason}` : ""}`);
    void sendAlert(deps, "ai", b.paused ? "pause" : "resume", b.paused ? "AI sorğuları dayandırıldı" : "AI sorğuları yenidən açıldı",
      b.paused ? `${by} bütün müştərilər üçün AI-ı dayandırdı. Səbəb: ${reason}\n\nVidjetlər əlaqə formasını göstərir, kanallar "hazırda cavab vermir" yazır.` : `${by} AI-ı yenidən açdı. Çatlar normal işləyir.`);
    res.json(out);
  });

  return r;
}
