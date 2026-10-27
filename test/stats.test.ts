import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { startPortal, config as baseConfig } from "./helpers.js";
import { csvCell, toCsv, funnel, buildReport, sendMonthlyReports } from "../src/stats.js";
import type { Deps } from "../src/deps.js";

let p: Awaited<ReturnType<typeof startPortal>>;
before(async () => { p = await startPortal(); });
after(() => p.close());

const support = { businessName: "Magaza", domain: "magaza.az", email: "oz@example.com", profile: { language: "az", mode: "support" } };
let n = 0;
async function tenant() {
  const email = `st${++n}@example.com`;
  const c = await p.signedIn(email);
  assert.equal((await c.call("POST", "/tenant", { config: support })).status, 201);
  const t = (await p.store.findUserByEmail(email).then((u) => p.store.findTenantByUser(u!.id)))!;
  return { c, t };
}
const deps = () => ({ config: baseConfig, store: p.store, ai: p.ai, limiter: undefined as never, telegram: undefined as never, whatsapp: undefined as never, mailer: { async send(to: string, subject: string, text: string) { p.mails.push({ to, subject, text }); } } }) as Deps;

test("csvCell: düstur inyeksiyası, dırnaq və ; qorunur", () => {
  assert.equal(csvCell("=HYPERLINK(1)"), "'=HYPERLINK(1)");
  assert.equal(csvCell("+994"), "'+994");
  assert.equal(csvCell('a;b"c'), '"a;b""c"');
  assert.equal(csvCell(null), "");
  const csv = toCsv([{ key: "a", title: "Ad" }], [{ a: "ə" }]);
  assert.ok(csv.startsWith("﻿"));
});

test("söhbət tarixçəsi və CSV ixracı panel marşrutları ilə işləyir", async () => {
  const { c } = await tenant();
  const conv = await c.call("GET", "/tenant/conversations?days=7&limit=5&hack=1");
  assert.equal(conv.status, 200); assert.equal(conv.body.conversations[0].sid, "aaaaaaaa11");
  const call = p.ai.calls.filter((x) => x.fn === "conversations").at(-1)!;
  assert.match(String(call.args[1]), /days=7/); assert.doesNotMatch(String(call.args[1]), /hack/);
  assert.equal((await c.call("GET", "/tenant/conversations/aaaaaaaa11")).body.messages[0].answer, "Salam!");
  assert.equal((await c.call("GET", "/tenant/conversations/../x")).status, 404);
  assert.equal((await c.call("GET", "/tenant/conversations/a")).status, 400);
  const r = await fetch(`${p.base}/tenant/export/queries?days=7`, { headers: { cookie: c.cookie, origin: "http://localhost:3001" } });
  assert.equal(r.status, 200); assert.match(r.headers.get("content-type")!, /text\/csv/);
  assert.match(r.headers.get("content-disposition")!, /suallar-\d{4}-\d{2}-\d{2}\.csv/);
  const txt = await r.text(); assert.match(txt, /Sual/); assert.match(txt, /toyota/);
  assert.equal((await c.call("GET", "/tenant/export/hack")).status, 400);
  const anon = await fetch(`${p.base}/tenant/export/queries`); assert.equal(anon.status, 401);
});

test("funnel: söhbətdən müraciətə konversiya", async () => {
  const { t } = await tenant();
  const orig = { ...p.ai };
  const now = new Date().toISOString(), old = new Date(Date.now() - 60 * 86_400_000).toISOString();
  p.ai.queryStats = async () => ({ enabled: true, total: 20, noResults: 4, errors: 1, conversations: 10, top: [] });
  p.ai.kbLeads = async () => ({ items: [{ at: now, handled: true }, { at: now }, { at: old, handled: true }] });
  const now_ = new Date();
  await p.store.createLive({ id: "l1", tenantId: t.tenantId, tokenHash: "x", name: "", contact: "", status: "open", context: [], messages: [], createdAt: now_, updatedAt: now_ });
  try {
    const f = await funnel(deps(), t, 30);
    assert.equal(f.conversations, 10); assert.equal(f.answered, 15); assert.equal(f.leads, 2); assert.equal(f.live, 1);
    assert.equal(f.handoffs, 3); assert.equal(f.handoffRate, 30); assert.equal(f.handledRate, 50);
    p.ai.queryStats = async () => ({ enabled: false, total: 0, noResults: 0, errors: 0 });
    assert.equal((await funnel(deps(), t, 30)).conversations, null, "qeyd söndürülübsə söhbət sayı bilinmir");
  } finally { Object.assign(p.ai, orig); }
});

test("aylıq hesabat: yalnız ayın 1-i, bir dəfə, söndürülən və boş aylara getmir", async () => {
  const a = await tenant(), b = await tenant(), e = await tenant();
  const orig = { ...p.ai };
  p.ai.queryStats = async (id: string) => (id === e.t.tenantId ? { enabled: true, total: 0, noResults: 0, errors: 0, conversations: 0, top: [] } : { enabled: true, total: 8, noResults: 2, errors: 0, conversations: 4, top: [{ message: "qiymət", count: 3 }] });
  p.mails.length = 0;
  try {
    assert.equal(await sendMonthlyReports(deps(), new Date("2026-11-15T10:00:00Z")), 0, "ayın 1-i deyil");
    await p.store.updateTenant(b.t.tenantId, { report: { monthly: false } });
    const first = await sendMonthlyReports(deps(), new Date("2026-11-01T10:00:00Z"));
    const mine = p.mails.filter((m) => /aylıq çat hesabatı/.test(m.subject));
    assert.ok(first >= 1);
    assert.ok(mine.some((m) => m.to === `st${n - 2}@example.com`), "a-ya getdi");
    assert.ok(!mine.some((m) => m.to === `st${n - 1}@example.com`), "söndürülən b-yə getmir");
    assert.ok(!mine.some((m) => m.to === `st${n}@example.com`), "boş ay e-yə getmir");
    const body = mine.find((m) => m.to === `st${n - 2}@example.com`)!.text;
    assert.match(body, /Söhbət: 4/); assert.match(body, /qiymət \(3\)/);
    const before = p.mails.length;
    assert.equal(await sendMonthlyReports(deps(), new Date("2026-11-01T18:00:00Z")), 0, "eyni ay təkrar getmir");
    assert.equal(p.mails.length, before);
    assert.equal((await p.store.findTenantByUser((await p.store.findUserByEmail(`st${n - 2}@example.com`))!.id))!.report?.lastSent, "2026-11");
    assert.equal(await buildReport(deps(), e.t), null);
  } finally { Object.assign(p.ai, orig); }
  void a;
});

test("report aç/söndür marşrutu", async () => {
  const { c, t } = await tenant();
  assert.equal((await c.call("GET", "/tenant/report")).body.monthly, true);
  assert.equal((await c.call("PUT", "/tenant/report", { monthly: false })).body.monthly, false);
  assert.equal((await p.store.findTenantById(t.tenantId))!.report?.monthly, false);
  assert.equal((await c.call("PUT", "/tenant/report", { monthly: "x" })).status, 400);
});
