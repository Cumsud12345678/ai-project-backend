import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { AiError } from "../src/ai.js";
import { bareHost, originAllowed } from "../src/widget.js";
import { startPortal } from "./helpers.js";

let p: Awaited<ReturnType<typeof startPortal>>;
before(async () => { p = await startPortal(); });
after(() => p.close());

const config = { businessName: "Motoelan", domain: "motoelan.com", source: { type: "rest" } };
let n = 0;
/** Mənbəyi qoşulmuş müştəri + onun vidjet açarı. */
async function tenantWithWidget() {
  const c = await p.signedIn(`w${++n}@example.com`);
  assert.equal((await c.call("POST", "/tenant", { config })).status, 201);
  const w = await c.call("GET", "/tenant/widget");
  assert.equal(w.status, 200);
  return { c, key: w.body.widget.key as string };
}
/** Brauzer kimi: başqa saytın Origin-i ilə, cookie olmadan. */
const site = (origin: string | null) => {
  const c = p.client();
  return {
    get: (key: string, path: string) => c.call("GET", `/widget/${key}${path}`, undefined, origin === null ? { origin: "" } : { origin }),
    chat: (key: string, body: unknown) => c.call("POST", `/widget/${key}/chat`, body, origin === null ? { origin: "" } : { origin }),
  };
};
const raw = (path: string, init: RequestInit = {}) => fetch(p.base + path, init);

test("bareHost və originAllowed: domen, www, alt domen; oxşar yad domenlər yox", () => {
  assert.equal(bareHost("https://www.Motoelan.com/elanlar"), "motoelan.com");
  assert.equal(bareHost("motoelan.com"), "motoelan.com");
  const t = { domain: "motoelan.com", widget: { key: "k", enabled: true, origins: ["http://localhost:5500"], title: "", greeting: "", color: "#000000" } };
  for (const o of ["https://motoelan.com", "https://www.motoelan.com", "http://m.motoelan.com", "http://localhost:5500"]) assert.ok(originAllowed(o, t), o);
  for (const o of ["https://evilmotoelan.com", "https://motoelan.com.evil.com", "http://localhost:3000", "ftp://motoelan.com", "null", "", undefined]) assert.ok(!originAllowed(o as string, t), String(o));
  assert.ok(!originAllowed("https://localhost", { domain: "localhost", widget: undefined }), "nöqtəsiz domen alt domen kimi qəbul edilmir");
});

test("/widget.js ictimaidir, JavaScript kimi və qısa keş ilə verilir", async () => {
  const res = await raw("/widget.js");
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type") ?? "", /javascript/);
  assert.match(res.headers.get("cache-control") ?? "", /max-age=300/);
  const text = await res.text();
  assert.match(text, /Car Advisor çat vidjeti/);
  const assigned = [...text.matchAll(/\.innerHTML\s*=\s*([^;]+);/g)].map((m) => m[1]!.trim());
  assert.ok(assigned.length > 0 && assigned.every((v) => /^ICON_[A-Z]+$/.test(v)), `innerHTML yalnız sabit SVG üçün: ${assigned}`);
  assert.ok(!/insertAdjacentHTML|document\.write|eval\(/.test(text));
});

test("giriş olmadan /tenant/widget 401; mənbə yoxdursa 404 NO_TENANT", async () => {
  assert.equal((await p.client().call("GET", "/tenant/widget")).status, 401);
  const c = await p.signedIn(`w${++n}@example.com`);
  const r = await c.call("GET", "/tenant/widget");
  assert.equal(r.status, 404);
  assert.equal(r.body.code, "NO_TENANT");
});

test("mənbə aktivləşəndə vidjet açarı yaranır; scriptUrl göstərilir; açar sabitdir", async () => {
  const { c, key } = await tenantWithWidget();
  assert.match(key, /^wk_[a-f0-9]{32}$/);
  const again = await c.call("GET", "/tenant/widget");
  assert.equal(again.body.widget.key, key);
  assert.equal(again.body.scriptUrl, "https://portal.test/widget.js");
  assert.equal(again.body.widget.enabled, true);
  assert.equal(again.body.widget.title, "Motoelan");
  assert.ok(!JSON.stringify(again.body).includes("ca_live_"), "gizli API açarı heç vaxt qaytarılmır");
});

test("config: icazəli saytlar CORS alır, yadlar 403 və CORS başlığı almır", async () => {
  const { key } = await tenantWithWidget();
  for (const origin of ["https://motoelan.com", "https://www.motoelan.com", "https://m.motoelan.com"]) {
    const res = await raw(`/widget/${key}/config`, { headers: { origin } });
    assert.equal(res.status, 200, origin);
    assert.equal(res.headers.get("access-control-allow-origin"), origin);
    assert.match(res.headers.get("vary") ?? "", /Origin/i);
    const body = (await res.json()) as any;
    assert.deepEqual(Object.keys(body).sort(), ["brand", "color", "contact", "greeting", "imageSearch", "label", "live", "mode", "theme", "title"], "yalnız ictimai sahələr");
  }
  for (const origin of ["https://evil.com", "https://motoelan.com.evil.com", "https://evilmotoelan.com"]) {
    const res = await raw(`/widget/${key}/config`, { headers: { origin } });
    assert.equal(res.status, 403, origin);
    assert.equal(res.headers.get("access-control-allow-origin"), null);
  }
  assert.equal((await raw(`/widget/${key}/config`)).status, 403, "Origin yoxdursa icazə yoxdur");
});

test("preflight (OPTIONS): icazəli sayta 204 + başlıqlar, yada 403", async () => {
  const { key } = await tenantWithWidget();
  const ok = await raw(`/widget/${key}/chat`, { method: "OPTIONS", headers: { origin: "https://motoelan.com", "access-control-request-method": "POST", "access-control-request-headers": "content-type" } });
  assert.equal(ok.status, 204);
  assert.equal(ok.headers.get("access-control-allow-origin"), "https://motoelan.com");
  assert.match(ok.headers.get("access-control-allow-methods") ?? "", /POST/);
  assert.match(ok.headers.get("access-control-allow-headers") ?? "", /content-type/i);
  const bad = await raw(`/widget/${key}/chat`, { method: "OPTIONS", headers: { origin: "https://evil.com", "access-control-request-method": "POST" } });
  assert.equal(bad.status, 403);
  assert.equal(bad.headers.get("access-control-allow-origin"), null);
});

test("yanlış və ya tanınmayan açar: 404", async () => {
  const s = site("https://motoelan.com");
  for (const key of ["wk_" + "0".repeat(32), "wk_qisa", "ca_live_abc", "..%2F..%2Ftenant"]) assert.equal((await s.get(key, "/config")).status, 404, key);
});

test("chat: mesaj AI servisinə həmin müştərinin tenantId-si ilə gedir; usage və artıq sahələr çıxmır", async () => {
  const { c, key } = await tenantWithWidget();
  const tenantId = (await c.call("GET", "/tenant")).body.tenant.tenantId;
  const orig = p.ai.chat;
  p.ai.chat = async (...a) => { p.ai.calls.push({ fn: "chat", args: a }); return { answer: "Tapdım", usage: { tokens: 99 }, listings: [
    { id: "1", title: "Tufan M50", price: 1900, currency: "AZN", year: 2026, mileage: 3000, url: "https://motoelan.com/elanlar/1", image: "javascript:alert(1)", secret: "x" },
    { id: "2", title: "B", price: 1, url: "javascript:alert(1)" },
  ] }; };
  try {
    const r = await site("https://motoelan.com").chat(key, { message: " Salam ", history: [{ role: "user", text: "a" }, { role: "system", text: "hack" }, { role: "model", text: "b" }] });
    assert.equal(r.status, 200);
    assert.equal(r.body.answer, "Tapdım");
    assert.ok(!("usage" in r.body));
    assert.equal(r.body.listings[0].url, "https://motoelan.com/elanlar/1");
    assert.equal(r.body.listings[0].image, undefined, "javascript: şəkil ünvanı atılır");
    assert.equal(r.body.listings[1].url, undefined, "javascript: link atılır");
    assert.ok(!("secret" in r.body.listings[0]));
    const call = p.ai.calls.filter((x) => x.fn === "chat").at(-1)!;
    assert.deepEqual(call.args, [tenantId, "Salam", [{ role: "user", text: "a" }, { role: "model", text: "b" }], { sid: undefined, identity: undefined }]);
    // söhbət identifikatoru yalnız düzgün formatda ötürülür
    await site("https://motoelan.com").chat(key, { message: "x", sid: "0123456789abcdef0123456789abcdef" });
    assert.equal((p.ai.calls.filter((x) => x.fn === "chat").at(-1)!.args[3] as any).sid, "0123456789abcdef0123456789abcdef");
    await site("https://motoelan.com").chat(key, { message: "x", sid: "../../etc" });
    assert.equal((p.ai.calls.filter((x) => x.fn === "chat").at(-1)!.args[3] as any).sid, undefined);
  } finally { p.ai.chat = orig; }
});

test("chat: yararsız mesaj 400; yad saytdan 403 (AI servisinə sorğu getmir)", async () => {
  const { key } = await tenantWithWidget();
  const before = p.ai.calls.length;
  const s = site("https://motoelan.com");
  for (const body of [{}, { message: "" }, { message: 5 }, { message: "x".repeat(501) }]) assert.equal((await s.chat(key, body)).status, 400);
  assert.equal((await site("https://evil.com").chat(key, { message: "salam" })).status, 403);
  assert.equal(p.ai.calls.length, before);
});

test("chat: AI xətası ziyarətçiyə müştərinin limit/konfiqurasiya məlumatını açmır", async () => {
  const { key } = await tenantWithWidget();
  const s = site("https://motoelan.com");
  p.ai.failNext = new AiError(429, "Aylıq limit bitib: 500/500 (müştəri daxili)", "MONTHLY_LIMIT", { debug: { gizli: 1 } });
  const r1 = await s.chat(key, { message: "salam" });
  assert.equal(r1.status, 503);
  assert.ok(!JSON.stringify(r1.body).match(/500|limit|gizli/i), JSON.stringify(r1.body));
  p.ai.failNext = new AiError(500, "stack trace burada", "X");
  const r2 = await s.chat(key, { message: "salam" });
  assert.equal(r2.status, 502);
  assert.ok(!JSON.stringify(r2.body).includes("stack"));
});

const vid = (n: number) => n.toString(16).padStart(16, "0");

test("chat: ziyarətçi başına dəqiqədə 10 mesaj (anonim ID ilə); eyni IP-dən başqa ziyarətçiyə təsir etmir", async () => {
  const { key } = await tenantWithWidget();
  const a = site("https://motoelan.com");
  for (let i = 0; i < 10; i++) assert.equal((await a.chat(key, { message: `m${i}`, vid: vid(1) })).status, 200, `m${i}`);
  const blocked = await a.chat(key, { message: "on birinci", vid: vid(1) });
  assert.equal(blocked.status, 429);
  assert.equal(blocked.body.code, "RATE_LIMITED");
  assert.equal((await a.chat(key, { message: "salam", vid: vid(2) })).status, 200, "eyni şəbəkədən başqa ziyarətçi");
});

test("limitlər: defolt ziyarətçi başına gündə 30, sayt üzrə limitsiz; müştəri dəyişir, 0 = limitsiz, səhv dəyər 400", async () => {
  const { c, key } = await tenantWithWidget();
  assert.deepEqual((await c.call("GET", "/tenant/widget")).body.widget.limits, { perVisitorDay: 30, siteHour: 0 });
  for (const bad of [{ perVisitorDay: -1 }, { perVisitorDay: 1.5 }, { perVisitorDay: "5" }, { siteHour: 2_000_000 }, "x"])
    assert.equal((await c.call("PUT", "/tenant/widget", { limits: bad })).status, 400, JSON.stringify(bad));
  const put = await c.call("PUT", "/tenant/widget", { limits: { perVisitorDay: 3 } });
  assert.deepEqual(put.body.widget.limits, { perVisitorDay: 3, siteHour: 0 }, "göndərilməyən sahə saxlanır");

  const s = site("https://motoelan.com");
  for (let i = 0; i < 3; i++) assert.equal((await s.chat(key, { message: `m${i}`, vid: vid(10) })).status, 200);
  const over = await s.chat(key, { message: "dördüncü", vid: vid(10) });
  assert.equal(over.status, 429);
  assert.equal(over.body.code, "VISITOR_LIMIT");
  assert.equal((await s.chat(key, { message: "başqası", vid: vid(11) })).status, 200, "eyni IP, başqa ziyarətçi ID-si");

  // 0 = limitsiz (ziyarətçi başına gündəlik limit yoxdur)
  assert.equal((await c.call("PUT", "/tenant/widget", { limits: { perVisitorDay: 0 } })).body.widget.limits.perVisitorDay, 0);
  for (let i = 0; i < 6; i++) assert.equal((await s.chat(key, { message: `x${i}`, vid: vid(10) })).status, 200, `limitsiz ${i}`);
});

test("limitlər: sayt üzrə saatlıq limit dolanda BUSY; 0 olanda limitsizdir", async () => {
  const { c, key } = await tenantWithWidget();
  await c.call("PUT", "/tenant/widget", { limits: { perVisitorDay: 0, siteHour: 2 } });
  const s = site("https://motoelan.com");
  assert.equal((await s.chat(key, { message: "a", vid: vid(20) })).status, 200);
  assert.equal((await s.chat(key, { message: "b", vid: vid(21) })).status, 200);
  const r = await s.chat(key, { message: "c", vid: vid(22) });
  assert.equal(r.status, 429);
  assert.equal(r.body.code, "BUSY");
  await c.call("PUT", "/tenant/widget", { limits: { siteHour: 0 } });
  assert.equal((await s.chat(key, { message: "d", vid: vid(23) })).status, 200);
});

test("ayarlar: yenilənir və yoxlanılır; əlavə ünvan icazə alır; söndürülən vidjet 404 verir", async () => {
  const { c, key } = await tenantWithWidget();
  const s = site("http://localhost:5500");
  assert.equal((await s.get(key, "/config")).status, 403);

  const put = await c.call("PUT", "/tenant/widget", { origins: ["http://localhost:5500/səhifə?x=1", "http://localhost:5500"], title: " Motoelan köməkçi ", color: "#0F766E", greeting: "Salam!" });
  assert.equal(put.status, 200);
  assert.deepEqual(put.body.widget.origins, ["http://localhost:5500"], "origin-ə normallaşır, təkrar silinir");
  assert.equal(put.body.widget.title, "Motoelan köməkçi");
  assert.equal(put.body.widget.color, "#0f766e");
  assert.equal(put.body.widget.key, key, "açar dəyişmir");

  const cfg = await s.get(key, "/config");
  assert.equal(cfg.status, 200);
  assert.equal(cfg.body.color, "#0f766e");

  for (const bad of [{ origins: ["motoelan.com"] }, { origins: ["javascript:alert(1)"] }, { origins: "x" }, { origins: Array(11).fill("https://a.com") },
    { color: "red" }, { color: "#fff" }, { title: "" }, { title: "x".repeat(61) }, { greeting: "" }, { enabled: "yes" }, { label: "x".repeat(41) }, { label: 5 }])
    assert.equal((await c.call("PUT", "/tenant/widget", bad)).status, 400, JSON.stringify(bad).slice(0, 60));

  assert.equal(put.body.widget.label, "AI-dan soruş", "defolt loqo yazısı");
  assert.equal(cfg.body.label, "AI-dan soruş");
  assert.equal((await c.call("PUT", "/tenant/widget", { label: "  Soruş  " })).body.widget.label, "Soruş");
  assert.equal((await s.get(key, "/config")).body.label, "Soruş");
  assert.equal((await c.call("PUT", "/tenant/widget", { label: "" })).body.widget.label, "", "boş yazı = göstərilmir (defolta qayıtmır)");
  assert.equal((await s.get(key, "/config")).body.label, "");

  assert.equal((await c.call("PUT", "/tenant/widget", { enabled: false })).body.widget.enabled, false);
  const off = await site("https://motoelan.com").get(key, "/config");
  assert.equal(off.status, 404);
  assert.equal(off.body.code, "WIDGET_OFF");
  assert.equal((await site("https://motoelan.com").chat(key, { message: "salam" })).status, 404);
});

test("açarı yeniləmək köhnə scripti dərhal söndürür", async () => {
  const { c, key } = await tenantWithWidget();
  const s = site("https://motoelan.com");
  assert.equal((await s.get(key, "/config")).status, 200);
  const rot = await c.call("POST", "/tenant/widget/rotate");
  assert.equal(rot.status, 200);
  assert.notEqual(rot.body.widget.key, key);
  assert.equal((await s.get(key, "/config")).status, 404);
  assert.equal((await s.get(rot.body.widget.key, "/config")).status, 200);
});

test("bir müştərinin açarı başqasının məlumatına çıxış vermir", async () => {
  const a = await tenantWithWidget();
  const b = await tenantWithWidget();
  assert.notEqual(a.key, b.key);
  const tidB = (await b.c.call("GET", "/tenant")).body.tenant.tenantId;
  await site("https://motoelan.com").chat(a.key, { message: "salam" });
  const call = p.ai.calls.filter((x) => x.fn === "chat").at(-1)!;
  assert.notEqual(call.args[0], tidB);
});

test("vidjetdən əvvəl yaranmış tenant üçün ilk açılışda vidjet yaradılır", async () => {
  const c = await p.signedIn(`w${++n}@example.com`);
  await c.call("POST", "/tenant", { config });
  const user = (await p.store.findUserByEmail(`w${n}@example.com`))!;
  const t = (await p.store.findTenantByUser(user.id))!;
  await p.store.updateTenant(t.tenantId, { widget: undefined });
  assert.equal((await p.store.findTenantByUser(user.id))!.widget, undefined);
  const r = await c.call("GET", "/tenant/widget");
  assert.equal(r.status, 200);
  assert.match(r.body.widget.key, /^wk_/);
  assert.equal((await p.store.findTenantByWidgetKey(r.body.widget.key))!.tenantId, t.tenantId);
});

test("brend yazısı: defolt görünür, yalnız admin söndürə bilir, müştəri özü yox", async () => {
  const { c, key } = await tenantWithWidget();
  const cfg = async () => (await site("https://motoelan.com").get(key, "/config")).body;
  assert.deepEqual((await cfg()).brand, { name: "Car Advisor", url: "https://advisor.example" });
  const tid = (await c.call("GET", "/tenant")).body.tenant.tenantId as string;
  assert.equal((await c.call("PATCH", `/admin/tenants/${tid}/branding`, { removed: true })).status, 403, "müştəri özü silə bilməz");
  // müştəri vidjet ayarlarını saxlayanda bayraq itmir, body-də brandRemoved qəbul edilmir
  await c.call("PUT", "/tenant/widget", { title: "X", brandRemoved: true });
  assert.ok((await cfg()).brand, "müştərinin göndərdiyi brandRemoved nəzərə alınmır");
  const admin = await p.signedIn("boss@example.com");
  assert.equal((await admin.call("PATCH", `/admin/tenants/${tid}/branding`, { removed: "yes" })).status, 400);
  assert.equal((await admin.call("PATCH", `/admin/tenants/${tid}/branding`, { removed: true })).status, 200);
  assert.equal((await cfg()).brand, null);
  assert.equal((await c.call("GET", "/tenant/widget")).body.brandRemoved, true);
  await c.call("PUT", "/tenant/widget", { title: "Y" });
  assert.equal((await cfg()).brand, null, "ayar saxlamaq bayrağı silmir");
  assert.equal((await admin.call("PATCH", `/admin/tenants/${tid}/branding`, { removed: false })).status, 200);
  assert.ok((await cfg()).brand);
});
