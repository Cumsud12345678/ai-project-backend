import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { startPortal } from "./helpers.js";

let p: Awaited<ReturnType<typeof startPortal>>;
before(async () => { p = await startPortal(); });
after(() => p.close());

test("qeydiyyat → email kodu → təsdiq → sessiya cookie-si (httpOnly)", async () => {
  const c = p.client();
  const reg = await c.call("POST", "/auth/register", { email: "Ali@Example.com", password: "parol12345" });
  assert.equal(reg.status, 201);
  assert.equal(p.mails.at(-1)?.to, "ali@example.com", "email kiçik hərfə çevrilir");
  assert.equal((await c.call("GET", "/auth/me")).status, 401, "təsdiqdən əvvəl sessiya yoxdur");

  const wrong = await c.call("POST", "/auth/verify", { email: "ali@example.com", code: "000000" });
  assert.equal(wrong.status, 400);
  const ok = await c.call("POST", "/auth/verify", { email: "ali@example.com", code: p.lastCode("ali@example.com") });
  assert.equal(ok.status, 200);
  assert.match(ok.setCookie ?? "", /ca_session=.+HttpOnly/i);
  assert.equal(ok.body.role, "user");
  assert.equal((await c.call("GET", "/auth/me")).body.email, "ali@example.com");
});

test("parol bazada açıq saxlanmır (scrypt hash)", async () => {
  const u = await p.store.findUserByEmail("ali@example.com");
  assert.match(u!.passwordHash, /^scrypt\$/);
  assert.ok(!u!.passwordHash.includes("parol12345"));
});

test("eyni email ilə ikinci qeydiyyat → 409; zəif parol və səhv email → 400", async () => {
  const c = p.client();
  assert.equal((await c.call("POST", "/auth/register", { email: "ali@example.com", password: "parol12345" })).status, 409);
  assert.equal((await c.call("POST", "/auth/register", { email: "yeni@example.com", password: "qisa" })).status, 400);
  assert.equal((await c.call("POST", "/auth/register", { email: "email-deyil", password: "parol12345" })).status, 400);
});

test("giriş: düzgün parol 200, yanlış parol və olmayan hesab eyni 401 mesajı", async () => {
  const c = p.client();
  assert.equal((await c.call("POST", "/auth/login", { email: "ali@example.com", password: "parol12345" })).status, 200);
  const bad = await p.client().call("POST", "/auth/login", { email: "ali@example.com", password: "yanlis-parol" });
  const none = await p.client().call("POST", "/auth/login", { email: "yoxdur@example.com", password: "yanlis-parol" });
  assert.equal(bad.status, 401);
  assert.equal(none.status, 401);
  assert.equal(bad.body.error, none.body.error);
});

test("təsdiqlənməmiş hesab girişdə 403 EMAIL_NOT_VERIFIED alır və yeni kod gedir", async () => {
  const c = p.client();
  await c.call("POST", "/auth/register", { email: "gozleyen@example.com", password: "parol12345" });
  const before = p.mails.length;
  const r = await c.call("POST", "/auth/login", { email: "gozleyen@example.com", password: "parol12345" });
  assert.equal(r.status, 403);
  assert.equal(r.body.code, "EMAIL_NOT_VERIFIED");
  assert.equal(p.mails.length, before, "60 saniyəlik gözləmə: təkrar kod göndərilmir");
});

test("kod 5 yanlış cəhddən sonra ləğv olunur", async () => {
  const c = p.client();
  await c.call("POST", "/auth/register", { email: "cehd@example.com", password: "parol12345" });
  const real = p.lastCode("cehd@example.com");
  for (let i = 0; i < 5; i++) assert.equal((await c.call("POST", "/auth/verify", { email: "cehd@example.com", code: real === "111111" ? "222222" : "111111" })).status, 400);
  const r = await c.call("POST", "/auth/verify", { email: "cehd@example.com", code: real });
  assert.equal(r.status, 429, "doğru kod da artıq qəbul edilmir");
});

test("çıxış sessiyanı bazadan silir", async () => {
  const c = await p.signedIn("cixis@example.com");
  const cookie = c.cookie;
  assert.equal((await c.call("GET", "/auth/me")).status, 200);
  assert.equal((await c.call("POST", "/auth/logout")).status, 200);
  const old = p.client();
  assert.equal((await old.call("GET", "/auth/me", undefined, { cookie })).status, 401, "köhnə cookie artıq keçərsizdir");
});

test("parol sıfırlama: kod ilə yeni parol, köhnə sessiyalar bağlanır", async () => {
  const c = await p.signedIn("sifir@example.com", "kohne-parol1");
  await p.client().call("POST", "/auth/forgot", { email: "sifir@example.com" });
  const code = p.lastCode("sifir@example.com");
  const r = await p.client().call("POST", "/auth/reset", { email: "sifir@example.com", code, password: "yeni-parol123" });
  assert.equal(r.status, 200);
  assert.equal((await c.call("GET", "/auth/me")).status, 401, "köhnə cihaz çıxarıldı");
  assert.equal((await p.client().call("POST", "/auth/login", { email: "sifir@example.com", password: "kohne-parol1" })).status, 401);
  assert.equal((await p.client().call("POST", "/auth/login", { email: "sifir@example.com", password: "yeni-parol123" })).status, 200);
});

test("forgot olmayan email üçün də 200 (hesab olub-olmaması bildirilmir)", async () => {
  const before = p.mails.length;
  assert.equal((await p.client().call("POST", "/auth/forgot", { email: "heç-kim@example.com" })).status, 200);
  assert.equal(p.mails.length, before);
});

test("admin rolu ADMIN_EMAILS siyahısından gəlir", async () => {
  const c = await p.signedIn("boss@example.com");
  assert.equal((await c.call("GET", "/auth/me")).body.role, "admin");
});

test("başqa saytdan gələn dəyişdirici sorğu rədd edilir (Origin yoxlaması)", async () => {
  const r = await p.client().call("POST", "/auth/login", { email: "ali@example.com", password: "parol12345" }, { origin: "https://evil.example" });
  assert.equal(r.status, 403);
});

test("giriş cəhdləri limitlənir", async () => {
  const c = p.client();
  let last = 0;
  for (let i = 0; i < 12; i++) last = (await c.call("POST", "/auth/login", { email: "limit@example.com", password: "yanlis-parol" })).status;
  assert.equal(last, 429);
});
