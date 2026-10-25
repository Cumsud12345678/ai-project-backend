import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { AiError } from "../src/ai.js";
import { startPortal } from "./helpers.js";

let p: Awaited<ReturnType<typeof startPortal>>;
let admin: Awaited<ReturnType<typeof p.signedIn>>;
before(async () => { p = await startPortal(); admin = await p.signedIn("boss@example.com"); });
after(() => p.close());

const config = {
  businessName: "Silinən Avto", domain: "silinen.az",
  source: { type: "rest", baseUrl: "https://api.example.com", search: { method: "GET", path: "/a" }, response: { itemsPath: "data", fields: { id: "id", title: "t", price: "p" } } },
};
const userId = async (email: string) => (await p.store.findUserByEmail(email))!.id;

test("admin istifadəçini silir: AI-dakı müştəri də silinir, giriş və sessiya işləmir, siyahıdan çıxır", async () => {
  const victim = await p.signedIn("qurban@example.com");
  const act = await victim.call("POST", "/tenant", { config });
  assert.equal(act.status, 201);
  const tenantId = act.body.tenant.tenantId;

  const del = await admin.call("DELETE", `/admin/users/${await userId("qurban@example.com")}`);
  assert.equal(del.status, 200);
  assert.deepEqual(p.ai.calls.filter((c) => c.fn === "deleteTenant").at(-1)!.args, [tenantId]);
  assert.equal((await p.store.findTenantById(tenantId)), null);
  assert.equal(await p.store.findUserByEmail("qurban@example.com"), null);
  assert.equal((await victim.call("GET", "/auth/me")).status, 401, "köhnə sessiya işləmir");
  const list = await admin.call("GET", "/admin/users");
  assert.ok(!list.body.users.some((u: any) => u.email === "qurban@example.com"));
  const again = p.client();
  assert.equal((await again.call("POST", "/auth/login", { email: "qurban@example.com", password: "parol12345" })).status, 401);
});

test("admin: müştərisi olmayan istifadəçi AI çağırılmadan silinir; naməlum id 404; öz hesabı və admin qorunur; adi istifadəçi 403", async () => {
  const plain = await p.signedIn("sade@example.com");
  const before = p.ai.calls.filter((c) => c.fn === "deleteTenant").length;
  assert.equal((await admin.call("DELETE", `/admin/users/${await userId("sade@example.com")}`)).status, 200);
  assert.equal(p.ai.calls.filter((c) => c.fn === "deleteTenant").length, before);
  assert.equal((await admin.call("DELETE", "/admin/users/000000000000000000000000")).status, 404);
  assert.equal((await admin.call("DELETE", `/admin/users/${await userId("boss@example.com")}`)).body.code, "CANNOT_DELETE_SELF");
  const other = await p.signedIn("user2@example.com");
  assert.equal((await other.call("DELETE", `/admin/users/${await userId("boss@example.com")}`)).status, 403);
  assert.equal((await plain.call("GET", "/auth/me")).status, 401);
});

test("admin başqa adminə toxuna bilmir (403)", async () => {
  const two = await startPortal({ adminEmails: ["boss@example.com", "boss2@example.com"] });
  try {
    const a1 = await two.signedIn("boss@example.com");
    await two.signedIn("boss2@example.com");
    const id2 = (await two.store.findUserByEmail("boss2@example.com"))!.id;
    const r = await a1.call("DELETE", `/admin/users/${id2}`);
    assert.equal(r.status, 403);
    assert.equal(r.body.code, "CANNOT_DELETE_ADMIN");
    assert.ok(await two.store.findUserByEmail("boss2@example.com"));
  } finally { await two.close(); }
});

test("AI servisi silinməyibsə (xəta) hesab SİLİNMİR; AI-da artıq yoxdursa (404) davam edir", async () => {
  const c = await p.signedIn("yarimcdiq@example.com");
  await c.call("POST", "/tenant", { config });
  const id = await userId("yarimcdiq@example.com");

  p.ai.failNext = new AiError(502, "AI servisinə qoşulmaq olmur", "AI_UNREACHABLE");
  const fail = await admin.call("DELETE", `/admin/users/${id}`);
  assert.ok(fail.status >= 500);
  assert.ok(await p.store.findUserByEmail("yarimcdiq@example.com"), "istifadəçi qalır, yenidən cəhd oluna bilər");
  assert.ok(await p.store.findTenantByUser(id), "müştəri yetim qalmır");

  p.ai.failNext = new AiError(404, "Müştəri tapılmadı");
  assert.equal((await admin.call("DELETE", `/admin/users/${id}`)).status, 200);
  assert.equal(await p.store.findUserByEmail("yarimcdiq@example.com"), null);
});

test("istifadəçi öz hesabını silir: parol tələb olunur, yanlış parol silmir, düzgün parol silir və cookie təmizlənir", async () => {
  const c = await p.signedIn("ozum@example.com");
  await c.call("POST", "/tenant", { config });
  assert.equal((await c.call("POST", "/auth/delete-account", {})).status, 400);
  assert.equal((await c.call("POST", "/auth/delete-account", { password: "yanlis-parol" })).status, 401);
  assert.ok(await p.store.findUserByEmail("ozum@example.com"));
  const ok = await c.call("POST", "/auth/delete-account", { password: "parol12345" });
  assert.equal(ok.status, 200);
  assert.equal(await p.store.findUserByEmail("ozum@example.com"), null);
  assert.equal((await c.call("GET", "/auth/me")).status, 401);
  assert.ok(p.ai.calls.some((x) => x.fn === "deleteTenant"));
});

test("giriş olmadan silmə 401; admin özünü /auth/delete-account ilə silə bilmir", async () => {
  const anon = p.client();
  assert.equal((await anon.call("POST", "/auth/delete-account", { password: "x" })).status, 401);
  assert.equal((await admin.call("POST", "/auth/delete-account", { password: "parol12345" })).status, 403);
  assert.equal((await anon.call("DELETE", "/admin/users/abc")).status, 401);
});

test("admin: ümumi istifadə statistikası müştəri adları ilə gəlir; silinmiş müştəri “(silinib)”; adi istifadəçiyə 403", async () => {
  const c = await p.signedIn("stat@example.com");
  const act = await c.call("POST", "/tenant", { config: { ...config, businessName: "Stat Avto", domain: "stat.az" } });
  assert.equal(act.status, 201);
  const tenantId = act.body.tenant.tenantId;
  p.ai.usageSummary = async () => ({ today: { requests: 2, tokens: 60 }, thisMonth: { requests: 5, tokens: 150 }, lastMonth: { requests: 0, tokens: 0 }, daily: [], monthly: [], tenants: [{ tenantId, requests: 5, tokens: 150 }, { tenantId: "gone", requests: 1, tokens: 1 }] });
  const r = await admin.call("GET", "/admin/usage");
  assert.equal(r.status, 200);
  assert.equal(r.body.thisMonth.tokens, 150);
  assert.deepEqual(r.body.tenants.map((t: any) => t.businessName), ["Stat Avto", "(silinib)"]);
  assert.equal((await c.call("GET", "/admin/usage")).status, 403);
});

test("admin başqa istifadəçiyə admin statusu verir/alır; restart lazım deyil, dərhal qüvvəyə minir", async () => {
  const c = await p.signedIn("yeni-admin@example.com");
  assert.equal((await c.call("GET", "/auth/me")).body.role, "user");
  assert.equal((await c.call("GET", "/admin/users")).status, 403);
  const id = await userId("yeni-admin@example.com");

  assert.equal((await admin.call("PATCH", `/admin/users/${id}/role`, { role: "superuser" })).body.code, "BAD_ROLE");
  assert.equal((await admin.call("PATCH", `/admin/users/000000000000000000000000/role`, { role: "admin" })).status, 404);
  assert.equal((await c.call("PATCH", `/admin/users/${id}/role`, { role: "admin" })).status, 403, "adi istifadəçi özünü admin edə bilmir");

  assert.equal((await admin.call("PATCH", `/admin/users/${id}/role`, { role: "admin" })).body.isAdmin, true);
  assert.equal((await c.call("GET", "/auth/me")).body.role, "admin", "eyni sessiya, yeni giriş lazım deyil");
  const list = (await c.call("GET", "/admin/users")).body.users.find((u: { id: string }) => u.id === id);
  assert.equal(list.isAdmin, true);
  assert.equal(list.isOwner, false);
  assert.equal((await c.call("DELETE", `/admin/users/${await userId("boss@example.com")}`)).body.code, "CANNOT_DELETE_ADMIN");

  assert.equal((await admin.call("PATCH", `/admin/users/${id}/role`, { role: "user" })).body.isAdmin, false);
  assert.equal((await c.call("GET", "/admin/users")).status, 403);
});

test("rol: öz rolunu və .env adminini dəyişmək olmaz; təsdiqlənməmişə admin verilmir", async () => {
  const boss = await userId("boss@example.com");
  assert.equal((await admin.call("PATCH", `/admin/users/${boss}/role`, { role: "user" })).body.code, "CANNOT_CHANGE_SELF");
  const two = await startPortal({ adminEmails: ["boss@example.com", "boss2@example.com"] });
  try {
    const a1 = await two.signedIn("boss@example.com");
    await two.signedIn("boss2@example.com");
    const id2 = (await two.store.findUserByEmail("boss2@example.com"))!.id;
    assert.equal((await a1.call("PATCH", `/admin/users/${id2}/role`, { role: "user" })).body.code, "OWNER_ROLE_FIXED");
    const u = await two.store.createUser({ email: "tesdiqsiz@example.com", passwordHash: "x" });
    assert.equal((await a1.call("PATCH", `/admin/users/${u.id}/role`, { role: "admin" })).body.code, "NOT_VERIFIED");
  } finally { await two.close(); }
});
