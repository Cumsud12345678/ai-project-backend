// Admin: xəbərdarlıqlar, ödənişlər, kanallar, səhifələmə/axtarış, audit süzgəci, ümumi AI açarı və gündəlik limit.
import test, { after, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { AiError } from "../src/ai.js";
import { alertTick, resetAlerts, sendAlert } from "../src/alerts.js";
import { __setNotifyBot } from "../src/operator-notify.js";
import { startPortal } from "./helpers.js";

let p: Awaited<ReturnType<typeof startPortal>>;
before(async () => { p = await startPortal({ notifyBotToken: "999:notify" }); __setNotifyBot("notify_bot"); });
after(() => p.close());
beforeEach(() => resetAlerts());

const cfg = { businessName: "Mağaza", domain: "magaza.az", profile: { language: "az", mode: "support" } };
let n = 0;
async function tenant(name = "Mağaza") {
  const email = `ops${++n}@example.com`;
  const c = await p.signedIn(email);
  const r = await c.call("POST", "/tenant", { config: { ...cfg, businessName: name, domain: `${name.toLowerCase().replace(/\W/g, "")}${n}.az` } });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  const key = (await c.call("GET", "/tenant/widget")).body.widget.key as string;
  return { c, email, key, tenantId: r.body.tenant.tenantId as string, domain: r.body.tenant.domain as string };
}
let adminClient: Awaited<ReturnType<typeof p.signedIn>> | undefined;
const admin = async () => (adminClient ??= await p.signedIn("boss@example.com"));
const mailsTo = (to: string) => p.mails.filter((m) => m.to === to);
const last = (fn: string) => [...p.ai.calls].reverse().find((x) => x.fn === fn)?.args;
const wait = (ms = 30) => new Promise((r) => setTimeout(r, ms));

test("xəbərdarlıq: ayarlar saxlanır, Telegram bağlanır, sınaq yalnız özünə gedir, söndürülən növ göndərilmir", async () => {
  const a = await admin();
  const v = await a.call("GET", "/admin/alerts");
  assert.equal(v.status, 200);
  assert.equal(v.body.settings.errorThreshold, 20);
  assert.equal(v.body.telegram.available, true);
  const link = await a.call("POST", "/admin/alerts/telegram", {});
  assert.match(link.body.url, /^https:\/\/t\.me\/notify_bot\?start=/);
  // botda "Start" basılıb kimi: Telegram söhbəti istifadəçiyə bağlanır
  const bossId = (await p.store.findUserByEmail("boss@example.com"))!.id;
  await p.store.updateUser(bossId, { tgNotify: { chatId: "777", name: "Boss", at: new Date() } });

  const t = await a.call("POST", "/admin/alerts/test", {});
  assert.equal(t.body.telegram, 1);
  assert.ok(p.telegram.sent.some((m) => m.chatId === "777" && /Sınaq bildirişi/.test(m.text)));

  const s = await a.call("PUT", "/admin/alerts", { email: false, kinds: { topup: false }, errorThreshold: 1 });
  assert.equal(s.body.settings.email, false);
  assert.equal(s.body.settings.errorThreshold, 3, "minimum 3");
  assert.equal(s.body.settings.kinds.topup, false);
  assert.equal(s.body.settings.kinds.errors, true, "digərləri dəyişmir");
  const off = await sendAlert(p.deps, "topup", "x1", "Yükləmə", "test");
  assert.equal(off.skipped, "off");
  await a.call("PUT", "/admin/alerts", { email: true, kinds: { topup: true }, errorThreshold: 20 });
  assert.equal((await p.client().call("GET", "/admin/alerts")).status, 401);
});

test("xəbərdarlıq: AI 2 yoxlamada cavab verməyəndə bir dəfə, bərpa olanda bir dəfə; xəta artımı saatda bir", async () => {
  const before = mailsTo("boss@example.com").length;
  p.ai.pingFail = true;
  await alertTick(p.deps);
  assert.equal(mailsTo("boss@example.com").length, before, "bir uğursuz yoxlama hələ xəbər deyil");
  await alertTick(p.deps);
  await alertTick(p.deps);
  const down = mailsTo("boss@example.com").slice(before);
  assert.equal(down.length, 1);
  assert.match(down[0]!.subject, /AI servisi cavab vermir/);
  p.ai.pingFail = false;
  await alertTick(p.deps);
  assert.match(mailsTo("boss@example.com").at(-1)!.subject, /bərpa olundu/);
  assert.equal((await (await admin()).call("GET", "/admin/alerts")).body.health.ai.down, false);

  for (let i = 0; i < 21; i++) await p.store.addError({ source: "api", message: `Timeout ${i}`, fingerprint: "fp1" });
  const b2 = mailsTo("boss@example.com").length;
  await alertTick(p.deps);
  await alertTick(p.deps);
  const spike = mailsTo("boss@example.com").slice(b2);
  assert.equal(spike.length, 1, "saatda bir dəfə");
  assert.match(spike[0]!.subject, /21 xəta/);
  assert.match(spike[0]!.text, /21× \[api\] Timeout/);
});

test("yükləmə sorğusu adminə Telegram ilə də gedir; gündəlik limit sahibə və adminə gündə bir dəfə xəbər verir", async () => {
  const t = await tenant("Limitli");
  const sentBefore = p.telegram.sent.length;
  await t.c.call("POST", "/tenant/billing/topup-request", { amountAzn: 25 });
  await wait();
  assert.ok(p.telegram.sent.slice(sentBefore).some((m) => /Yeni yükləmə sorğusu: 25\.00 AZN/.test(m.text)));

  const site = () => p.client().call("POST", `/widget/${t.key}/chat`, { message: "salam" }, { origin: `https://${t.domain}` });
  p.ai.failNext = new AiError(402, "Gündəlik xərc limitinə çatılıb", "DAILY_LIMIT");
  const r = await site();
  assert.equal(r.status, 503); assert.equal(r.body.code, "OFFLINE");
  p.ai.failNext = new AiError(402, "Gündəlik xərc limitinə çatılıb", "DAILY_LIMIT");
  await site();
  await wait();
  assert.equal(mailsTo(t.email).filter((m) => /Gündəlik limit/.test(m.subject)).length, 1, "sahibə gündə bir");
  assert.equal(mailsTo("boss@example.com").filter((m) => /Gündəlik limitə çatıldı: Limitli/.test(m.subject)).length, 1);
});

test("ödənişlər: sorğular və hərəkətlər müştəri adı ilə; müştəri axtarışı; CSV formul inyeksiyasına qarşı", async () => {
  const t = await tenant("Kitab");
  const a = await admin();
  const reqs = await a.call("GET", "/admin/payments/requests?status=approved&from=2026-11-01&to=2026-11-30");
  assert.equal(reqs.status, 200);
  const q = last("billingRequestsQuery")![0] as Record<string, string>;
  assert.equal(q.status, "approved");
  assert.equal(q.since, "2026-11-01T00:00:00.000Z");
  assert.equal(q.until, "2026-12-01T00:00:00.000Z", "to günü daxildir");
  assert.equal(reqs.body.requests[0].resolvedBy, "boss@example.com");

  const byName = await a.call("GET", `/admin/payments/ledger?tenant=${encodeURIComponent("kitab")}&kind=manual`);
  assert.equal(byName.body.tenant.tenantId, t.tenantId);
  const lq = last("billingLedger")![0] as Record<string, string>;
  assert.equal(lq.tenantId, t.tenantId); assert.equal(lq.kind, "manual");
  assert.equal((await a.call("GET", "/admin/payments/ledger?tenant=yoxdur-bele-sayt")).body.entries.length, 0);

  const csv = await fetch(`${p.base}/admin/payments/ledger.csv`, { headers: { cookie: a.cookie, origin: "http://localhost:3001" } });
  const text = await csv.text();
  assert.match(csv.headers.get("content-type") ?? "", /text\/csv/);
  assert.match(text, /ödəniş/);
  assert.match(text, /'=hədiyyə/, "= ilə başlayan qeyd zərərsizləşdirilir");
});

test("böyük məbləğli əl ilə düzəliş ayrıca təsdiq istəyir; gündəlik limit ayarı AI-yə ötürülür", async () => {
  const t = await tenant("Boyuk");
  const a = await admin();
  const r = await a.call("POST", `/admin/tenants/${t.tenantId}/billing/topup`, { amountAzn: -150, note: "qaytarma" });
  assert.equal(r.body.code, "CONFIRM_REQUIRED");
  assert.equal((await a.call("POST", `/admin/tenants/${t.tenantId}/billing/topup`, { amountAzn: -150, note: "qaytarma", confirmLarge: true })).status, 200);
  assert.equal((await a.call("POST", `/admin/tenants/${t.tenantId}/billing/topup`, { amountAzn: 20 })).status, 200, "kiçik məbləğ birbaşa");
  await a.call("PATCH", `/admin/tenants/${t.tenantId}/billing/settings`, { dailyLimitAzn: 3 });
  assert.deepEqual(last("billingSettings"), [t.tenantId, { dailyLimitAzn: 3 }]);
  await a.call("PATCH", `/admin/tenants/${t.tenantId}/billing/settings`, { dailyLimitAzn: "" });
  assert.deepEqual(last("billingSettings"), [t.tenantId, { dailyLimitAzn: null }]);
  assert.equal((await a.call("PATCH", `/admin/tenants/${t.tenantId}/billing/settings`, { dailyLimitAzn: "abc" })).status, 400);
});

test("kanallar: qoşulmuş müştərilər, WhatsApp vəziyyəti, 24 saatlıq xətalar, son söhbət", async () => {
  const t = await tenant("Kanal");
  await p.store.updateTenant(t.tenantId, { whatsapp: { enabled: true, phone: "994501234567", connectedAt: new Date(), ackAt: new Date(), pauseOnOwnReply: true } });
  for (let i = 0; i < 6; i++) await p.store.addError({ source: "channel", message: "WhatsApp: x", fingerprint: "c1", tenantId: t.tenantId });
  await p.store.saveChannelSession({ tenantId: t.tenantId, channel: "whatsapp", chatId: "1", sid: "a".repeat(16), history: [], updatedAt: new Date() } as never);
  const r = await (await admin()).call("GET", "/admin/channels");
  assert.equal(r.status, 200);
  const row = r.body.rows.find((x: any) => x.tenantId === t.tenantId);
  assert.equal(row.whatsapp.phone, "99450•••67", "nömrə qismən gizlədilir");
  assert.equal(row.whatsapp.state, "off");
  assert.ok(row.problems.includes("wa_down") && row.problems.includes("errors"));
  assert.equal(row.errors24h, 6);
  assert.equal(row.whatsapp.idle, false);
  assert.ok(r.body.summary.problems >= 1);
});

test("istifadəçilər: səhifələmə, axtarış (e-poçt, sayt adı), süzgəc və sayğaclar serverdə", async () => {
  const a = await admin();
  const t = await tenant("Unikal Ad");
  const all = await a.call("GET", "/admin/users?limit=5&page=1");
  assert.equal(all.body.users.length, 5);
  assert.ok(all.body.total > 5 && all.body.pages >= 2);
  const page2 = await a.call("GET", "/admin/users?limit=5&page=2");
  assert.ok(!page2.body.users.some((u: any) => all.body.users.some((x: any) => x.id === u.id)), "səhifələr kəsişmir");
  assert.equal((await a.call("GET", `/admin/users?q=${encodeURIComponent("unikal")}`)).body.users[0].email, t.email, "sayt adı ilə");
  assert.equal((await a.call("GET", `/admin/users?q=${encodeURIComponent(t.email.toUpperCase())}`)).body.total, 1, "e-poçt, hərf fərqi yoxdur");
  assert.equal((await a.call("GET", "/admin/users?q=" + encodeURIComponent(".*"))).body.total, 0, "regex simvolları hərfi axtarılır");
  const admins = await a.call("GET", "/admin/users?filter=admins");
  assert.ok(admins.body.users.every((u: any) => u.isAdmin));
  const withTenant = await a.call("GET", "/admin/users?filter=tenants&limit=100");
  assert.ok(withTenant.body.users.every((u: any) => u.tenant));
  assert.ok(all.body.counts.users >= all.body.total);
  await a.call("POST", `/admin/tenants/${t.tenantId}/suspend`, { reason: "test səbəbi" });
  assert.equal((await a.call("GET", "/admin/users?filter=suspended")).body.users[0].email, t.email);
});

test("audit: əməliyyat növü, kim və mətnə görə süzgəc; səhifələmə", async () => {
  const a = await admin();
  for (let i = 0; i < 4; i++) await p.store.addAudit({ actor: "boss@example.com", action: "billing.topup", target: `t-${i}`, detail: `${i} AZN` });
  await p.store.addAudit({ actor: "other@example.com", action: "user.role", target: "x@y.az", detail: "admin" });
  const role = await a.call("GET", "/admin/audit?action=user.role");
  assert.ok(role.body.items.length >= 1 && role.body.items.every((x: any) => x.action.startsWith("user.role")));
  assert.ok((await a.call("GET", "/admin/audit?actor=other")).body.items.every((x: any) => x.actor === "other@example.com"));
  assert.equal((await a.call("GET", "/admin/audit?q=t-2")).body.items.length, 1);
  const p1 = await a.call("GET", "/admin/audit?action=billing.topup&limit=10");
  assert.ok(p1.body.items.length >= 4);
});

test("ümumi AI açarı: səbəb məcburidir, AI-yə ötürülür, adminlərə xəbər gedir, ümumi baxışda görünür", async () => {
  const a = await admin();
  assert.equal((await a.call("PUT", "/admin/ai-control", { paused: true })).body.code, "REASON_REQUIRED");
  const before = mailsTo("boss@example.com").length;
  const r = await a.call("PUT", "/admin/ai-control", { paused: true, reason: "Provayder çöküb" });
  assert.equal(r.status, 200);
  assert.deepEqual(last("setAiControl"), [{ paused: true, reason: "Provayder çöküb", by: "boss@example.com" }]);
  await wait();
  assert.ok(mailsTo("boss@example.com").slice(before).some((m) => /AI sorğuları dayandırıldı/.test(m.subject)));
  assert.equal((await a.call("GET", "/admin/overview")).body.aiControl.paused, true);
  assert.ok((await a.call("GET", "/admin/audit?action=ai.")).body.items.some((x: any) => x.action === "ai.pause"));
  await a.call("PUT", "/admin/ai-control", { paused: false });
  assert.equal((await a.call("GET", "/admin/ai-control")).body.paused, false);
  const user = await p.signedIn("aictl-plain@example.com");
  assert.equal((await user.call("PUT", "/admin/ai-control", { paused: false })).status, 403);
});

test("xəbərdarlıq: Claude/Gemini balansı bitəndə bir dəfə xəbər (e-poçt + Telegram), təkrar yoxlamada susur, düzələndə bərpa", async () => {
  await admin();
  const bossId = (await p.store.findUserByEmail("boss@example.com"))!.id;
  await p.store.updateUser(bossId, { tgNotify: { chatId: "777", name: "Boss", at: new Date() } });
  const before = mailsTo("boss@example.com").length;
  const tgBefore = p.telegram.sent.length;
  p.ai.providerState = { claude: { kind: "balance", message: "Claude 400: Your credit balance is too low", since: "2026-11-10T08:00:00.000Z", count: 3 } };
  await alertTick(p.deps);
  await alertTick(p.deps);
  // digər testlərdən qalan xəta artımı xəbərdarlığı da gələ bilər: yalnız provayder məktublarını sayırıq
  const prov = () => mailsTo("boss@example.com").filter((m) => /Claude|Gemini/.test(m.subject));
  const got = mailsTo("boss@example.com").slice(before).filter((m) => /Claude|Gemini/.test(m.subject));
  assert.equal(got.length, 1, "eyni problem bir dəfə");
  assert.match(got[0]!.subject, /Claude \(Anthropic\): hesabda balans bitib/);
  assert.match(got[0]!.text, /ehtiyat model \(Gemini/);
  assert.match(got[0]!.text, /console\.anthropic\.com/);
  assert.ok(p.telegram.sent.slice(tgBefore).some((m) => m.chatId === "777" && /balans bitib/.test(m.text)));
  // ikisi də işləmir: xüsusi xəbərdarlıq
  p.ai.providerState = { ...p.ai.providerState, gemini: { kind: "auth", message: "API key not valid", since: "2026-11-10T08:05:00.000Z" } };
  await alertTick(p.deps);
  assert.match(prov().at(-1)!.text, /cavab verə bilməyəcək/);
  p.ai.providerState = {};
  await alertTick(p.deps);
  const tail = prov().slice(-2).map((m) => m.subject).join(" | ");
  assert.match(tail, /yenidən işləyir/);
  // söndürülübsə göndərilmir
  const a = await admin();
  await a.call("PUT", "/admin/alerts", { kinds: { provider: false } });
  const b3 = prov().length;
  p.ai.providerState = { gemini: { kind: "balance", message: "prepay", since: "2026-11-10T09:00:00.000Z" } };
  await alertTick(p.deps);
  assert.equal(prov().length, b3);
  await a.call("PUT", "/admin/alerts", { kinds: { provider: true } });
  p.ai.providerState = {};
});
