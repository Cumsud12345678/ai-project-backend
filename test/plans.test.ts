// Abunə planları: sifariş, admin təsdiqi, e-poçtlar (80/100%, xatırlatma), plan imkanlarına görə funksiyalar, operator yerləri.
import test, { after, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { alertTick, resetAlerts } from "../src/alerts.js";
import { invalidateEntitlements } from "../src/plans.js";
import { startPortal } from "./helpers.js";

let p: Awaited<ReturnType<typeof startPortal>>;
before(async () => { p = await startPortal(); });
after(() => p.close());
const OPEN = { channels: true, live: true, automations: true, campaigns: true, actions: true, customerData: true, noBranding: false };
beforeEach(() => { resetAlerts(); invalidateEntitlements(); p.ai.ent = { source: "trial", plan: null, features: { ...OPEN }, seats: 6 }; });

let n = 0;
async function tenant() {
  const email = `plan${++n}@example.com`;
  const c = await p.signedIn(email);
  const r = await c.call("POST", "/tenant", { config: { businessName: "Dükan", domain: `dukan${n}.az`, profile: { language: "az", mode: "support" } } });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  const key = (await c.call("GET", "/tenant/widget")).body.widget.key as string;
  return { c, email, key, tenantId: r.body.tenant.tenantId as string, domain: r.body.tenant.domain as string };
}
const last = (fn: string) => [...p.ai.calls].reverse().find((x) => x.fn === fn)?.args;
const wait = (ms = 30) => new Promise((r) => setTimeout(r, ms));

test("sifariş: məbləği müştəri göndərmir, adminə xəbər gedir; yanlış növ 400", async () => {
  const { c, tenantId } = await tenant();
  const q = await c.call("POST", "/tenant/billing/order?dryRun=1", { kind: "plan", plan: "start", cycle: "month" });
  assert.equal(q.status, 200);
  assert.equal(q.body.quote.amountAzn, 15);
  const o = await c.call("POST", "/tenant/billing/order", { kind: "plan", plan: "start", cycle: "year", amountAzn: 0.01 });
  assert.equal(o.status, 201);
  assert.deepEqual(last("billingOrder"), [tenantId, { kind: "plan", plan: "start", cycle: "year", pack: undefined }, false]);
  await wait();
  assert.ok(p.mails.some((m) => m.to === "boss@example.com" && /Yeni plan sifarişi/.test(m.subject)));
  assert.equal((await c.call("POST", "/tenant/billing/order", { kind: "topup" })).status, 400);
  const next = await c.call("POST", "/tenant/billing/plan/next", { plan: "start" });
  assert.equal(next.status, 200);
  assert.deepEqual(last("billingPlanNext"), [tenantId, "start"]);
});

test("admin: plan sifarişini təsdiqləyəndə 'Plan aktivdir' e-poçtu; kataloq və plan vermək", async () => {
  const { email, tenantId } = await tenant();
  const a = await p.signedIn("boss@example.com");
  const orig = p.ai.billingResolve;
  p.ai.billingResolve = async (id) => ({ request: { id, tenantId, kind: "plan", plan: "business", amountAzn: 35, status: "approved" }, duplicate: false, subscription: { planName: "Biznes", start: "2026-11-10T00:00:00Z", end: "2026-12-10T00:00:00Z", included: 3000, cycle: "month" } });
  try {
    assert.equal((await a.call("POST", "/admin/billing/requests/o1/approve", {})).status, 200);
    await wait();
    const m = p.mails.find((x) => x.to === email && /Plan aktivdir: Biznes/.test(x.subject));
    assert.ok(m);
    assert.match(m!.text, /10\.12\.2026/);
  } finally { p.ai.billingResolve = orig; }
  assert.equal((await a.call("GET", "/admin/billing/plans")).body.plans[0].id, "start");
  assert.equal((await a.call("PUT", "/admin/billing/plans", { plans: [] })).status, 200);
  const as = await a.call("POST", `/admin/tenants/${tenantId}/billing/plan`, { plan: "pro", days: 14, note: "hədiyyə" });
  assert.equal(as.status, 200);
  assert.deepEqual(last("billingPlanAssign"), [tenantId, { plan: "pro", days: 14, note: "hədiyyə", by: "boss@example.com" }]);
  assert.equal((await a.call("POST", `/admin/tenants/${tenantId}/billing/plan`, { plan: "pro", days: 0 })).status, 400);
  const { c } = await tenant();
  assert.equal((await c.call("GET", "/admin/billing/plans")).status, 403);
  // saytın qiymət bölməsi: girişsiz
  const pub = await p.client().call("GET", "/plans");
  assert.equal(pub.status, 200);
  assert.ok(Array.isArray(pub.body.plans));
});

test("80% / 100% e-poçtları vidjet çatından", async () => {
  const { key, email, domain } = await tenant();
  const origin = `https://${domain}`;
  p.ai.nextChat = { answer: "ok", listings: [], billing: { state: "ok", notify: "usage80", plan: { used: 800, included: 1000 } } };
  assert.equal((await p.client().call("POST", `/widget/${key}/chat`, { message: "salam" }, { origin })).status, 200);
  p.ai.nextChat = { answer: "ok", listings: [], billing: { state: "ok", notify: "usage100", plan: { used: 1000, included: 1000 } } };
  await p.client().call("POST", `/widget/${key}/chat`, { message: "salam" }, { origin });
  await wait();
  assert.ok(p.mails.some((m) => m.to === email && /80%/.test(m.subject) && /1000 cavabdan 800/.test(m.text)));
  assert.ok(p.mails.some((m) => m.to === email && /Cavab limiti doldu/.test(m.subject)));
  p.ai.nextChat = { answer: "ok", listings: [], billing: { state: "ok", notify: "trialEnd", trial: { left: 0, total: 100 } } };
  await p.client().call("POST", `/widget/${key}/chat`, { message: "salam" }, { origin });
  await wait();
  assert.ok(p.mails.some((m) => m.to === email && /Pulsuz sınaq bitdi/.test(m.subject)));
});

test("plan imkanları: kampaniya, brend yazısı, canlı söhbət, operator yerləri", async () => {
  const { c, key, domain, tenantId } = await tenant();
  const origin = `https://${domain}`;
  assert.equal((await c.call("PUT", "/tenant/widget", { live: { enabled: true }, proactive: { enabled: true, rules: [{ text: "Kömək lazımdır?", delaySec: 15, match: "*" }] } })).status, 200);
  const cfg = async () => (await p.client().call("GET", `/widget/${key}/config`, undefined, { origin })).body;
  const open = await cfg();
  assert.ok(open.brand);
  assert.equal(open.live, true);
  assert.equal(open.proactive.length, 1);
  p.ai.ent = { source: "plan", plan: "start", features: { ...OPEN, live: false, campaigns: false, noBranding: false }, seats: 1 };
  invalidateEntitlements(tenantId);
  const start = await cfg();
  assert.equal(start.live, false, "Start planında canlı söhbət yoxdur");
  assert.deepEqual(start.proactive, []);
  assert.equal((await p.client().call("POST", `/widget/${key}/live`, { name: "A" }, { origin })).status, 409);
  // operator: Start planında 1 yer (yalnız sahib)
  const team = await c.call("GET", "/tenant/team");
  assert.equal(team.body.max, 0);
  const add = await c.call("POST", "/tenant/team", { email: "op@example.com" });
  assert.equal(add.status, 400);
  assert.equal(add.body.code, "TEAM_FULL");
  p.ai.ent = { source: "plan", plan: "pro", features: { ...OPEN, noBranding: true }, seats: 10 };
  invalidateEntitlements(tenantId);
  assert.equal((await cfg()).brand, null, "Pro: brend yazısı gizlənir");
  assert.equal((await c.call("GET", "/tenant/team")).body.max, 9);
  // panel: bağlı imkan hansı planda açılır
  p.ai.ent = { source: "plan", plan: "start", features: { ...OPEN, live: false }, seats: 1 };
  invalidateEntitlements(tenantId);
  const e = await c.call("GET", "/tenant/entitlements");
  assert.equal(e.body.features.live, false);
  assert.equal(e.body.unlock.channels, "Start");
});

test("abunə xatırlatmaları saatlıq yoxlamada sahibə gedir", async () => {
  const { tenantId, email } = await tenant();
  p.ai.reminders = [{ tenantId, kind: "expiring", planName: "Start", end: "2026-11-13T00:00:00Z" }, { tenantId: "yox", kind: "expired", planName: "Start" }];
  await alertTick(p.deps);
  await wait();
  const m = p.mails.find((x) => x.to === email && /Planın müddəti bitir/.test(x.subject));
  assert.ok(m);
  assert.match(m!.text, /13\.11\.2026/);
  // eyni saatda təkrar yoxlama AI servisinə getmir
  p.ai.reminders = [{ tenantId, kind: "expired", planName: "Start" }];
  await alertTick(p.deps);
  await wait();
  assert.ok(!p.mails.some((x) => x.to === email && /Planın müddəti bitdi/.test(x.subject)));
});
