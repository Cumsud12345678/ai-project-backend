import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { AiError } from "../src/ai.js";
import { startPortal } from "./helpers.js";

let p: Awaited<ReturnType<typeof startPortal>>;
before(async () => { p = await startPortal(); });
after(() => p.close());

const config = {
  businessName: "Motoelan", domain: "motoelan.com", apiSecret: "GIZLI-SIRR", email: "oz@example.com", bos: 1,
  profile: { language: "az" },
  source: { type: "rest", baseUrl: "https://api.example.com", auth: { type: "header", name: "X-Api-Key", value: "olmamali" }, search: { method: "GET", path: "/a" }, response: { itemsPath: "data", fields: { id: "id", title: "t", price: "p" } } },
};

test("giriş olmadan tenant və admin endpoint-ləri 401", async () => {
  const c = p.client();
  for (const [m, path] of [["GET", "/tenant"], ["POST", "/tenant"], ["POST", "/tenant/chat"], ["GET", "/admin/users"]] as const)
    assert.equal((await c.call(m, path)).status, 401, `${m} ${path}`);
});

test("hələ mənbə yoxdursa: tenant null; istifadə/söhbət 404 NO_TENANT", async () => {
  const c = await p.signedIn("t1@example.com");
  assert.equal((await c.call("GET", "/tenant")).body.tenant, null);
  const u = await c.call("GET", "/tenant/usage");
  assert.equal(u.status, 404);
  assert.equal(u.body.code, "NO_TENANT");
});

test("konfiqurasiya düzgün obyekt deyilsə 400", async () => {
  const c = await p.signedIn("t2@example.com");
  assert.equal((await c.call("POST", "/tenant/config/test", { config: "mətn" })).status, 400);
  assert.equal((await c.call("POST", "/tenant/config/test", { config: [1] })).status, 400);
  assert.equal((await c.call("POST", "/tenant/config/test", {})).status, 400);
});

test("aktivləşdirmə: AI servisinə yalnız tanınan sahələr gedir, açar bir dəfə qaytarılır, bazada sirr yoxdur", async () => {
  const c = await p.signedIn("t3@example.com");
  const r = await c.call("POST", "/tenant", { config });
  assert.equal(r.status, 201);
  assert.match(r.body.apiKey, /^ca_live_/);
  const sent = p.ai.calls.find((x) => x.fn === "createTenant")!.args[0] as Record<string, unknown>;
  assert.equal(sent.apiSecret, "GIZI-SIRR".replace("GIZI", "GIZLI"), "sirr AI servisinə şifrələnmək üçün ötürülür");
  assert.ok(!("email" in sent) && !("bos" in sent), "tanınmayan sahələr atılır");

  const stored = await p.store.findTenantByUser((await p.store.findUserByEmail("t3@example.com"))!.id);
  const dump = JSON.stringify(stored);
  assert.ok(!dump.includes("GIZLI-SIRR") && !dump.includes("olmamali"), "sirr və auth.value bazada saxlanmır");
  assert.equal(stored!.businessName, "Motoelan");

  const again = await c.call("GET", "/tenant");
  assert.ok(!JSON.stringify(again.body).includes("ca_live_"), "açar bir daha qaytarılmır");
  assert.equal(again.body.tenant.domain, "motoelan.com");
  assert.equal(again.body.advisorUrl, "https://advisor.test");
});

test("ikinci aktivləşdirmə → 409; AI servisi çağırılmır", async () => {
  const c = await p.signedIn("t4@example.com");
  await c.call("POST", "/tenant", { config });
  const calls = p.ai.calls.filter((x) => x.fn === "createTenant").length;
  assert.equal((await c.call("POST", "/tenant", { config })).status, 409);
  assert.equal(p.ai.calls.filter((x) => x.fn === "createTenant").length, calls);
});

test("AI servisi konfiqurasiyanı rədd etsə (422) müştəriyə mesaj göstərilir və tenant yaranmır", async () => {
  const c = await p.signedIn("t5@example.com");
  p.ai.failNext = new AiError(422, "Elanlar oxundu, amma sahə xəritələməsi səhvdir: title yoxdur", "MAPPING_FAILED", { debug: { dropped: ["title yoxdur"] } });
  const r = await c.call("POST", "/tenant", { config });
  assert.equal(r.status, 422);
  assert.match(r.body.error, /xəritələmə/);
  assert.equal(r.body.code, "MAPPING_FAILED");
  assert.equal((await c.call("GET", "/tenant")).body.tenant, null);
});

test("AI servisi çöküb və ya token yanlışdırsa müştəri daxili detal görmür (502)", async () => {
  const c = await p.signedIn("t6@example.com");
  p.ai.failNext = new AiError(401, "Servis icazəsi yoxdur");
  const r = await c.call("POST", "/tenant/config/test", { config });
  assert.equal(r.status, 502);
  assert.ok(!r.body.error.includes("icazə"));
});

test("söhbət: tarixçə təmizlənir və tenantId ilə AI servisinə gedir, 500 simvoldan uzun mesaj rədd edilir", async () => {
  const c = await p.signedIn("t7@example.com");
  await c.call("POST", "/tenant", { config });
  const r = await c.call("POST", "/tenant/chat", { message: " salam ", history: [{ role: "user", text: "a" }, { role: "admin", text: "pis" }, { role: "model", text: 5 }] });
  assert.equal(r.body.answer, "Salam");
  const call = p.ai.calls.filter((x) => x.fn === "chat").at(-1)!;
  assert.equal(call.args[1], "salam");
  assert.deepEqual(call.args[2], [{ role: "user", text: "a" }]);
  assert.equal((await c.call("POST", "/tenant/chat", { message: "x".repeat(501) })).status, 400);
  assert.deepEqual(call.args[3], { test: true }, "sınaq söhbəti AI servisinə test işarəsi ilə gedir");
});

test("sorğular: siyahı yalnız icazəli parametrlərlə, xülasə, söndürmə (logQueries) və təmizləmə", async () => {
  const c = await p.signedIn("q1@example.com");
  await c.call("POST", "/tenant", { config });
  const r = await c.call("GET", "/tenant/queries?limit=10&noResults=1&hack=1&q=toyota");
  assert.equal(r.status, 200);
  assert.equal(r.body.queries[0].message, "toyota");
  const call = p.ai.calls.filter((x) => x.fn === "queries").at(-1)!;
  assert.equal(call.args[1], "limit=10&noResults=1&q=toyota", "hack parametri ötürülmür");
  assert.equal((await c.call("GET", "/tenant/queries/stats?days=7")).body.top[0].count, 1);
  assert.equal((await c.call("PATCH", "/tenant/profile", { logQueries: false })).status, 200);
  assert.deepEqual(p.ai.calls.filter((x) => x.fn === "patchProfile").at(-1)!.args[1], { logQueries: false });
  assert.equal((await c.call("DELETE", "/tenant/queries")).status, 200);
  assert.equal(p.ai.calls.at(-1)!.fn, "clearQueries");
  assert.equal((await p.client().call("GET", "/tenant/queries")).status, 401);
});

test("müştərilər bir-birinin məlumatını görmür: hər kəs yalnız öz tenantId-si ilə işləyir", async () => {
  const a = await p.signedIn("a@example.com"), b = await p.signedIn("b@example.com");
  await a.call("POST", "/tenant", { config });
  await b.call("POST", "/tenant", { config });
  const ta = (await a.call("GET", "/tenant")).body.tenant.tenantId, tb = (await b.call("GET", "/tenant")).body.tenant.tenantId;
  assert.notEqual(ta, tb);
  await a.call("GET", "/tenant/usage");
  assert.equal(p.ai.calls.filter((x) => x.fn === "usage").at(-1)!.args[0], ta);
});

test("profil: yalnız tanınan açarlar AI servisinə gedir və bazadakı nüsxə yenilənir", async () => {
  const c = await p.signedIn("t8@example.com");
  await c.call("POST", "/tenant", { config });
  const r = await c.call("PATCH", "/tenant/profile", { tone: "rəsmi", limits: { monthlyRequests: 999999 } });
  assert.equal(r.body.profile.tone, "rəsmi");
  const sent = p.ai.calls.filter((x) => x.fn === "patchProfile").at(-1)!.args[1];
  assert.deepEqual(sent, { tone: "rəsmi" }, "limits kimi sahələr müştəridən qəbul edilmir");
  assert.equal((await c.call("GET", "/tenant")).body.tenant.config.profile.tone, "rəsmi");
});

test("konfiqurasiya yeniləmə və açar yeniləmə", async () => {
  const c = await p.signedIn("t9@example.com");
  await c.call("POST", "/tenant", { config });
  const upd = await c.call("PUT", "/tenant/config", { config: { ...config, businessName: "Yeni Ad" } });
  assert.equal(upd.status, 200);
  assert.equal(upd.body.tenant.businessName, "Yeni Ad");
  const rot = await c.call("POST", "/tenant/key/rotate");
  assert.match(rot.body.apiKey, /^ca_live_rotated/);
  assert.ok((await c.call("GET", "/tenant")).body.tenant.keyRotatedAt);
});

test("admin: adi istifadəçi 403, admin siyahı görür və başqa müştərinin açarını yeniləyir (parolsuz hash yox)", async () => {
  const user = await p.signedIn("adi@example.com");
  assert.equal((await user.call("GET", "/admin/users")).status, 403);
  const admin = await p.signedIn("boss@example.com");
  const list = await admin.call("GET", "/admin/users");
  assert.equal(list.status, 200);
  assert.ok(list.body.users.length > 3);
  assert.ok(!JSON.stringify(list.body).includes("scrypt"), "parol hash-i çıxmır");
  const withTenant = list.body.users.find((u: any) => u.email === "t3@example.com");
  assert.equal(withTenant.tenant.businessName, "Motoelan");
  const rot = await admin.call("POST", `/admin/tenants/${withTenant.tenant.tenantId}/rotate-key`);
  assert.match(rot.body.apiKey, /^ca_live_rotated/);
  assert.equal((await admin.call("POST", "/admin/tenants/yoxdur/rotate-key")).status, 404);
  assert.equal((await user.call("POST", `/admin/tenants/${withTenant.tenant.tenantId}/rotate-key`)).status, 403);
});
