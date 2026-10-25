import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { AiError } from "../src/ai.js";
import { parseAmount } from "../src/billing.js";
import { HttpError } from "../src/http.js";
import { startPortal } from "./helpers.js";

let p: Awaited<ReturnType<typeof startPortal>>;
before(async () => { p = await startPortal(); });
after(() => p.close());

const cfg = { businessName: "Mağaza", domain: "magaza.az", profile: { language: "az", mode: "support" } };
let n = 0;
async function tenant() {
  const email = `bl${++n}@example.com`;
  const c = await p.signedIn(email);
  const r = await c.call("POST", "/tenant", { config: cfg });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  const key = (await c.call("GET", "/tenant/widget")).body.widget.key as string;
  return { c, email, key, tenantId: r.body.tenant.tenantId as string };
}
const site = (key: string, path: string, body?: unknown) => p.client().call("POST", `/widget/${key}${path}`, body, { origin: "https://magaza.az" });
const mailsTo = (to: string) => p.mails.filter((m) => m.to === to);
let adminClient: Awaited<ReturnType<typeof p.signedIn>> | undefined;
const admin = async () => (adminClient ??= await p.signedIn("boss@example.com"));
const last = (fn: string) => [...p.ai.calls].reverse().find((x) => x.fn === fn)?.args;

test("parseAmount: yalnız müsbət düzgün rəqəm (admin düzəlişi üçün mənfi ola bilər)", () => {
  assert.equal(parseAmount(10), 10);
  assert.equal(parseAmount("12,5"), 12.5);
  assert.equal(parseAmount(10.456), 10.46);
  for (const bad of [0, -5, "abc", "", null, undefined, NaN, 1e9]) assert.throws(() => parseAmount(bad), HttpError, String(bad));
  assert.equal(parseAmount(-5, { allowNegative: true }), -5);
});

test("GET /tenant/billing müştərinin öz balansını gətirir; girişsiz 401", async () => {
  const t = await tenant();
  const r = await t.c.call("GET", "/tenant/billing");
  assert.equal(r.status, 200);
  assert.equal(r.body.balance.totalAzn, 6.2);
  assert.equal(r.body.admin, undefined);
  assert.deepEqual(last("billing"), [t.tenantId]);
  assert.equal((await p.client().call("GET", "/tenant/billing")).status, 401);
});

test("yükləmə sorğusu: məbləğ yoxlanır, AI-yə gedir, adminə email gedir", async () => {
  const t = await tenant();
  assert.equal((await t.c.call("POST", "/tenant/billing/topup-request", { amountAzn: "abc" })).status, 400);
  assert.equal((await t.c.call("POST", "/tenant/billing/topup-request", { amountAzn: -10 })).status, 400);
  const before = mailsTo("boss@example.com").length;
  const r = await t.c.call("POST", "/tenant/billing/topup-request", { amountAzn: 10 });
  assert.equal(r.status, 201);
  assert.equal(r.body.instructions, "Kartdan karta");
  assert.deepEqual(last("billingTopupRequest"), [t.tenantId, 10]);
  await new Promise((r) => setTimeout(r, 30));
  const mail = mailsTo("boss@example.com").slice(before).at(-1);
  assert.ok(mail && /Balans yükləmə sorğusu/.test(mail.subject) && /10\.00 AZN/.test(mail.text));
});

test("balans xəbərdarlığı və 402: widget chat sayt sahibinə email göndərir, ziyarətçiyə OFFLINE kodu", async () => {
  const t = await tenant();
  p.ai.nextChat = { answer: "Cavab", listings: [], billing: { state: "low", balanceAzn: 0.85, notify: "low" } };
  const ok = await site(t.key, "/chat", { message: "salam" });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.billing, undefined, "ziyarətçiyə balans məlumatı verilmir");
  await new Promise((r) => setTimeout(r, 30));
  const low = mailsTo(t.email).find((m) => /Balans azalır/.test(m.subject));
  assert.ok(low && /0\.85 AZN/.test(low.text));

  p.ai.nextChat = { answer: "Son cavab", listings: [], billing: { state: "empty", balanceAzn: -0.1, notify: "empty" } };
  await site(t.key, "/chat", { message: "salam2" });
  await new Promise((r) => setTimeout(r, 30));
  assert.ok(mailsTo(t.email).some((m) => /Balans bitdi/.test(m.subject)));

  p.ai.failNext = new AiError(402, "Balans bitib", "BALANCE_EMPTY");
  const blocked = await site(t.key, "/chat", { message: "salam3" });
  assert.equal(blocked.status, 503);
  assert.equal(blocked.body.code, "OFFLINE");
  assert.ok(!/Balans|limit/i.test(blocked.body.error), "ziyarətçi balans məlumatı görmür");

  // çat dayananda ziyarətçi müraciət qoya bilir
  assert.equal((await site(t.key, "/contact", { contact: "ali@example.com", question: "salam3" })).status, 201);
});

test("panel sınaq söhbəti: balans bitəndə 402 və BALANCE_EMPTY kodu müştəriyə çatır", async () => {
  const t = await tenant();
  p.ai.failNext = new AiError(402, "Balans bitib", "BALANCE_EMPTY");
  const r = await t.c.call("POST", "/tenant/chat", { message: "salam" });
  assert.equal(r.status, 402);
  assert.equal(r.body.code, "BALANCE_EMPTY");
});

test("panelin ilk səhifəsi (overview) balans vəziyyətini göstərir", async () => {
  const t = await tenant();
  const r = await t.c.call("GET", "/tenant/overview");
  assert.equal(r.body.billing.state, "ok");
  assert.equal(r.body.billing.balanceAzn, 6.2);
});

test("admin: sorğular siyahısı (müştəri adı ilə), təsdiq müştəriyə email göndərir, rədd; adi istifadəçiyə 403", async () => {
  const t = await tenant();
  const a = await admin();
  const list = await a.call("GET", "/admin/billing/requests?status=pending");
  assert.equal(list.status, 200);
  const r2 = list.body.requests.find((x: any) => x.id === "r2");
  assert.equal(r2.businessName, "(silinib)");
  assert.equal((await t.c.call("GET", "/admin/billing/requests")).status, 403);
  assert.equal((await t.c.call("POST", "/admin/billing/requests/r1/approve")).status, 403);

  const bad = await a.call("POST", "/admin/billing/requests/r1/yoxla");
  assert.equal(bad.status, 400);
  const rej = await a.call("POST", "/admin/billing/requests/r1/reject");
  assert.equal(rej.body.request.status, "rejected");
  assert.deepEqual(last("billingResolve"), ["r1", "reject", "boss@example.com"]);
  const ok = await a.call("POST", "/admin/billing/requests/r1/approve");
  assert.equal(ok.status, 200);
  assert.equal(ok.body.request.status, "approved");
});

test("admin: əl ilə yükləmə/düzəliş, vuruq və kredit limiti; tenant balansı admin görünüşü ilə", async () => {
  const t = await tenant();
  const a = await admin();
  assert.equal((await a.call("POST", `/admin/tenants/${t.tenantId}/billing/topup`, { amountAzn: 0 })).status, 400);
  assert.equal((await a.call("POST", `/admin/tenants/yoxdur/billing/topup`, { amountAzn: 5 })).status, 404);
  const up = await a.call("POST", `/admin/tenants/${t.tenantId}/billing/topup`, { amountAzn: 25, note: "köçürmə" });
  assert.equal(up.status, 200);
  assert.deepEqual(last("billingTopup"), [t.tenantId, { amountAzn: 25, note: "köçürmə", by: "boss@example.com" }]);
  await new Promise((r) => setTimeout(r, 30));
  assert.ok(mailsTo(t.email).some((m) => /Balans yükləndi/.test(m.subject)));
  const neg = await a.call("POST", `/admin/tenants/${t.tenantId}/billing/topup`, { amountAzn: -5, note: "qaytarma" });
  assert.equal(neg.status, 200);

  const s = await a.call("PATCH", `/admin/tenants/${t.tenantId}/billing/settings`, { markup: 2, creditLimitAzn: 5 });
  assert.equal(s.body.admin.markup, 2);
  assert.deepEqual(last("billingSettings"), [t.tenantId, { markup: 2, creditLimitAzn: 5 }]);
  assert.equal((await a.call("PATCH", `/admin/tenants/${t.tenantId}/billing/settings`, { markup: "abc" })).status, 400);
  const view = await a.call("GET", `/admin/tenants/${t.tenantId}/billing`);
  assert.equal(view.body.admin.defaultMarkup, 1.5);
  assert.equal((await t.c.call("PATCH", `/admin/tenants/${t.tenantId}/billing/settings`, { markup: 1 })).status, 403);
});

test("admin istifadəçi siyahısında hər müştərinin balansı var", async () => {
  const a = await admin();
  const r = await a.call("GET", "/admin/users");
  const withTenant = r.body.users.filter((u: any) => u.tenant);
  assert.ok(withTenant.length > 0);
  const t1 = withTenant.find((u: any) => u.tenant.tenantId === "tenant-1");
  if (t1) assert.equal(t1.tenant.balance.totalAzn, 6.2);
});
