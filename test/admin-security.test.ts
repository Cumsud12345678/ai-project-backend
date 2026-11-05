// Admin: müştərinin dayandırılması, maliyyə hesabatı, iki addımlı giriş (TOTP), qısa admin sessiyası, sessiyaların bağlanması.
import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { stepOf, totpAt } from "../src/totp.js";
import { startPortal } from "./helpers.js";

let p: Awaited<ReturnType<typeof startPortal>>;
before(async () => { p = await startPortal(); });
after(() => p.close());

const cfg = { businessName: "Mağaza", domain: "magaza.az", profile: { language: "az", mode: "support" } };
let n = 0;
async function tenant() {
  const email = `sec${++n}@example.com`;
  const c = await p.signedIn(email);
  const r = await c.call("POST", "/tenant", { config: cfg });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  const key = (await c.call("GET", "/tenant/widget")).body.widget.key as string;
  return { c, email, key, tenantId: r.body.tenant.tenantId as string };
}
const site = (key: string, path: string) => p.client().call("GET", `/widget/${key}${path}`, undefined, { origin: "https://magaza.az" });
let adminClient: Awaited<ReturnType<typeof p.signedIn>> | undefined;
const admin = async () => (adminClient ??= await p.signedIn("boss@example.com"));
const last = (fn: string) => [...p.ai.calls].reverse().find((x) => x.fn === fn)?.args;
const code = (secret: string, offset = 0) => totpAt(secret, stepOf() + offset);

test("dayandırma: səbəb məcburidir; vidjet görünmür, sahib səbəbi görür, email gedir, audit yazılır; bərpa", async () => {
  const t = await tenant();
  const a = await admin();
  assert.equal((await site(t.key, "/config")).status, 200);
  assert.equal((await a.call("POST", `/admin/tenants/${t.tenantId}/suspend`, { reason: "" })).body.code, "REASON_REQUIRED");
  assert.equal((await t.c.call("POST", `/admin/tenants/${t.tenantId}/suspend`, { reason: "spam" })).status, 403, "adi istifadəçi dayandıra bilmir");

  const s = await a.call("POST", `/admin/tenants/${t.tenantId}/suspend`, { reason: "Ödəniş mübahisəsi" });
  assert.equal(s.status, 200, JSON.stringify(s.body));
  assert.deepEqual(last("suspendTenant"), [t.tenantId, true]);
  assert.equal((await site(t.key, "/config")).status, 404, "vidjet gizlənir");
  const mine = await t.c.call("GET", "/tenant");
  assert.equal(mine.body.tenant.suspended.reason, "Ödəniş mübahisəsi");
  assert.ok(p.mails.some((m) => m.to === t.email && /dayandırıldı/.test(m.subject) && /Ödəniş mübahisəsi/.test(m.text)));
  const users = await a.call("GET", "/admin/users");
  assert.equal(users.body.users.find((u: any) => u.email === t.email).tenant.suspended.reason, "Ödəniş mübahisəsi");
  assert.equal((await a.call("GET", "/admin/overview")).body.tenants.suspended, 1);
  assert.ok((await a.call("GET", "/admin/audit")).body.items.some((x: any) => x.action === "tenant.suspend" && x.target === t.tenantId));

  assert.equal((await a.call("POST", `/admin/tenants/${t.tenantId}/unsuspend`, {})).status, 200);
  assert.deepEqual(last("suspendTenant"), [t.tenantId, false]);
  assert.equal((await site(t.key, "/config")).status, 200);
  assert.equal((await t.c.call("GET", "/tenant")).body.tenant.suspended, null);
  assert.ok(p.mails.some((m) => m.to === t.email && /bərpa/.test(m.subject)));
  assert.equal((await a.call("POST", "/admin/tenants/yoxdur/suspend", { reason: "test" })).status, 404);
});

test("maliyyə: admin müştəri adları ilə hesabat alır; ümumi baxışda real pul girişi göstərilir", async () => {
  const a = await admin();
  const f = await a.call("GET", "/admin/finance?months=3");
  assert.equal(f.status, 200);
  assert.deepEqual(last("billingFinance"), [3]);
  assert.equal(f.body.totals.cashInAzn, 40);
  assert.equal(f.body.models[0].provider, "anthropic");
  assert.ok("businessName" in f.body.tenants[0]);
  const o = await a.call("GET", "/admin/overview");
  assert.equal(o.body.revenueAzn, 40, "qalan balans (5) yox, daxil olan pul");
  assert.equal(o.body.outstandingPaidAzn, 5);
  assert.equal(o.body.monthProfitAzn, 0.8);
  const user = await p.signedIn("fin-plain@example.com");
  assert.equal((await user.call("GET", "/admin/finance")).status, 403);
});

test("2FA: parolla quraşdırma, kodla aktivləşdirmə, girişdə bilet + kod, ehtiyat kod bir dəfə işləyir, kod təkrar işləmir", async () => {
  const email = "twofa@example.com";
  const c = await p.signedIn(email);
  assert.equal((await c.call("POST", "/auth/2fa/setup", { password: "səhv" })).status, 401);
  const setup = await c.call("POST", "/auth/2fa/setup", { password: "parol12345" });
  assert.equal(setup.status, 200, JSON.stringify(setup.body));
  assert.match(setup.body.uri, /^otpauth:\/\/totp\//);
  assert.match(setup.body.qr, /^data:image\/png;base64,/);
  const secret = setup.body.secret as string;
  assert.equal((await c.call("POST", "/auth/2fa/enable", { code: "000000" })).body.code, "BAD_CODE");
  const other = p.client(); // başqa cihaz: aktivləşdirəndən sonra çıxarılmalıdır
  await other.call("POST", "/auth/login", { email, password: "parol12345" });
  assert.equal((await other.call("GET", "/auth/me")).status, 200);
  const en = await c.call("POST", "/auth/2fa/enable", { code: code(secret) });
  assert.equal(en.status, 200, JSON.stringify(en.body));
  assert.equal(en.body.backupCodes.length, 8);
  assert.equal((await c.call("GET", "/auth/me")).body.twoFactor.enabled, true, "bu cihaz daxil olmuş qalır");
  assert.equal((await other.call("GET", "/auth/me")).status, 401, "digər cihazlar çıxarıldı");

  // giriş: parol → bilet, sessiya açılmır
  const d = p.client();
  const first = await d.call("POST", "/auth/login", { email, password: "parol12345" });
  assert.equal(first.status, 200);
  assert.equal(first.body.twoFactor, true);
  assert.equal(first.setCookie, null, "ikinci addımdan əvvəl kuki yoxdur");
  assert.equal((await d.call("GET", "/auth/me")).status, 401);
  assert.equal((await d.call("POST", "/auth/2fa/login", { email, ticket: "a".repeat(64), code: code(secret) })).status, 401, "saxta bilet");
  assert.equal((await d.call("POST", "/auth/2fa/login", { email, ticket: first.body.ticket, code: "123456" })).status, 400);
  // aktivləşdirmədə istifadə olunan kod (eyni addım) təkrar qəbul olunmur, növbəti addımın kodu olur
  assert.equal((await d.call("POST", "/auth/2fa/login", { email, ticket: first.body.ticket, code: code(secret) })).status, 400, "eyni kod ikinci dəfə");
  const ok = await d.call("POST", "/auth/2fa/login", { email, ticket: first.body.ticket, code: code(secret, 1) });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.equal((await d.call("GET", "/auth/me")).body.email, email);
  assert.equal((await d.call("POST", "/auth/2fa/login", { email, ticket: first.body.ticket, code: code(secret, 1) })).status, 401, "bilet bir dəfəlikdir");

  // ehtiyat kod: bir dəfə
  const backup = en.body.backupCodes[0] as string;
  const e1 = p.client();
  const t1 = (await e1.call("POST", "/auth/login", { email, password: "parol12345" })).body.ticket;
  assert.equal((await e1.call("POST", "/auth/2fa/login", { email, ticket: t1, code: backup.toUpperCase() })).status, 200);
  const e2 = p.client();
  const t2 = (await e2.call("POST", "/auth/login", { email, password: "parol12345" })).body.ticket;
  assert.equal((await e2.call("POST", "/auth/2fa/login", { email, ticket: t2, code: backup })).status, 400, "istifadə olunmuş ehtiyat kod");
  assert.equal((await e1.call("GET", "/auth/me")).body.twoFactor.backupLeft, 7);

  // söndürmə: parol + ehtiyat kod
  assert.equal((await e1.call("POST", "/auth/2fa/disable", { password: "parol12345", code: "000000" })).status, 400);
  assert.equal((await e1.call("POST", "/auth/2fa/disable", { password: "parol12345", code: en.body.backupCodes[1] })).status, 200);
  assert.equal((await e1.call("POST", "/auth/login", { email, password: "parol12345" })).body.ticket, undefined, "bilet yoxdur: birbaşa daxil olur");
});

test("bütün digər cihazlardan çıxış: bu cihaz qalır, digərləri çıxır; admin istifadəçinin sessiyalarını bağlaya bilir", async () => {
  const email = "sessions@example.com";
  const a1 = await p.signedIn(email);
  const a2 = p.client();
  await a2.call("POST", "/auth/login", { email, password: "parol12345" });
  assert.equal((await a1.call("POST", "/auth/sessions/revoke-others", {})).status, 200);
  assert.equal((await a1.call("GET", "/auth/me")).status, 200);
  assert.equal((await a2.call("GET", "/auth/me")).status, 401);

  const adm = await admin();
  const id = (await adm.call("GET", "/admin/users")).body.users.find((u: any) => u.email === email).id;
  assert.equal((await adm.call("POST", `/admin/users/${id}/revoke-sessions`, {})).status, 200);
  assert.equal((await a1.call("GET", "/auth/me")).status, 401);
  assert.ok((await adm.call("GET", "/admin/audit")).body.items.some((x: any) => x.action === "user.revoke_sessions"));
});

test("admin sessiyası qısadır; köhnə (createdAt-sız) və ya vaxtı keçmiş admin sessiyası qəbul olunmur; rol dəyişəndə sessiyalar bağlanır", async () => {
  const adm = await admin();
  // Rol verilir → həmin istifadəçinin sessiyası bağlanır
  const email = "promoted@example.com";
  const u = await p.signedIn(email);
  const id = (await adm.call("GET", "/admin/users")).body.users.find((x: any) => x.email === email).id;
  assert.equal((await adm.call("PATCH", `/admin/users/${id}/role`, { role: "admin" })).status, 200);
  assert.equal((await u.call("GET", "/auth/me")).status, 401, "köhnə sessiya bağlandı");

  // Admin sessiyası 12 saatdan köhnədirsə etibarsızdır
  const c = p.client();
  await c.call("POST", "/auth/login", { email, password: "parol12345" });
  assert.equal((await c.call("GET", "/admin/overview")).status, 200);
  const realNow = Date.now;
  try {
    Date.now = () => realNow() + 13 * 3600_000;
    assert.equal((await c.call("GET", "/auth/me")).status, 401);
  } finally { Date.now = realNow; }
});

test("ADMIN_2FA=required: 2FA qurmamış admin admin API-yə girə bilmir, qurandan sonra girir; 2FA söndürülə bilmir; başqa admin sıfırlaya bilir", async () => {
  const q = await startPortal({ adminTwoFactor: "required" });
  try {
    const boss = await q.signedIn("boss@example.com");
    const blocked = await boss.call("GET", "/admin/overview");
    assert.equal(blocked.status, 403);
    assert.equal(blocked.body.code, "TWO_FACTOR_SETUP_REQUIRED");
    assert.equal((await boss.call("GET", "/auth/me")).body.twoFactor.setupNeeded, true);
    const s = await boss.call("POST", "/auth/2fa/setup", { password: "parol12345" });
    const en = await boss.call("POST", "/auth/2fa/enable", { code: code(s.body.secret) });
    assert.equal(en.status, 200);
    assert.equal((await boss.call("GET", "/admin/overview")).status, 200);
    assert.equal((await boss.call("POST", "/auth/2fa/disable", { password: "parol12345", code: en.body.backupCodes[0] })).body.code, "TWO_FACTOR_REQUIRED");

    // adi istifadəçi üçün tələb yoxdur
    const plain = await q.signedIn("plain2@example.com");
    assert.equal((await plain.call("GET", "/auth/me")).body.twoFactor.required, false);
    // əsas admin başqa istifadəçinin 2FA-nı sıfırlayır
    const ps = await plain.call("POST", "/auth/2fa/setup", { password: "parol12345" });
    await plain.call("POST", "/auth/2fa/enable", { code: code(ps.body.secret) });
    const id = (await boss.call("GET", "/admin/users")).body.users.find((x: any) => x.email === "plain2@example.com").id;
    assert.equal((await boss.call("POST", `/admin/users/${id}/reset-2fa`, {})).status, 200);
    const relog = q.client();
    assert.equal((await relog.call("POST", "/auth/login", { email: "plain2@example.com", password: "parol12345" })).body.ticket, undefined, "bilet yoxdur: birbaşa daxil olur");
  } finally { await q.close(); }
});
