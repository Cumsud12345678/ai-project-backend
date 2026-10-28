import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { AiError } from "../src/ai.js";
import { cleanContact } from "../src/kb.js";
import { DEFAULT_GREETING, DEFAULT_GREETING_SUPPORT } from "../src/widget.js";
import { startPortal } from "./helpers.js";

let p: Awaited<ReturnType<typeof startPortal>>;
before(async () => { p = await startPortal(); });
after(() => p.close());

const support = { businessName: "Mağaza", domain: "magaza.az", profile: { language: "az", mode: "support" } };
let n = 0;
async function supportTenant() {
  const c = await p.signedIn(`kb${++n}@example.com`);
  const r = await c.call("POST", "/tenant", { config: support });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  const w = await c.call("GET", "/tenant/widget");
  return { c, key: w.body.widget.key as string, email: `kb${n}@example.com`, greeting: w.body.widget.greeting as string };
}
const site = (key: string, path: string, body?: unknown, origin = "https://magaza.az") =>
  p.client().call(body === undefined ? "GET" : "POST", `/widget/${key}${path}`, body, { origin });

test("cleanContact: telefon və e-poçt qəbul, zibil rədd", () => {
  for (const ok of ["ali@example.com", "+994 50 123 45 67", "(012) 555-12-34", "0501234567"]) assert.ok(cleanContact(ok), ok);
  for (const bad of ["", "abc", "123", "a@b", "salam necəsən", 5, null, "1".repeat(30)]) assert.equal(cleanContact(bad as string), null, String(bad));
});

test("dəstək müştərisi mənbəsiz yaradılır, vidjetin salamlaması dəstək mətnidir, config rejimi və contact qaytarır", async () => {
  const t = await supportTenant();
  assert.equal(t.greeting, DEFAULT_GREETING_SUPPORT);
  const cfg = await site(t.key, "/config");
  assert.equal(cfg.status, 200);
  assert.equal(cfg.body.mode, "support");
  assert.equal(cfg.body.contact, true);
});

test("elan rejimli müştəridə də əlaqə forması var (çat dayananda ziyarətçi müraciət qoya bilsin)", async () => {
  const c = await p.signedIn("lst@example.com");
  await c.call("POST", "/tenant", { config: { businessName: "M", domain: "magaza.az", source: { type: "rest" } } });
  const key = (await c.call("GET", "/tenant/widget")).body.widget.key;
  assert.equal((await site(key, "/config")).body.contact, true);
  assert.equal((await site(key, "/contact", { contact: "ali@example.com" })).status, 201);
});

test("müraciət: yoxlama, AI-yə ötürmə, sayt sahibinə e-poçt, bot tələsi, icazəsiz sayt, limit", async () => {
  const t = await supportTenant();
  assert.equal((await site(t.key, "/contact", { contact: "abc" })).status, 400);
  assert.equal((await site(t.key, "/contact", { contact: "ali@example.com" }, "https://evil.com")).status, 403);

  const ok = await site(t.key, "/contact", { name: "Ali", contact: "ali@example.com", question: "Zəmanət?", chat: [{ role: "user", text: "operatora bağla" }, { role: "bad", text: "x" }, { role: "model", text: "Formada əlaqə qoyun" }] });
  assert.equal(ok.status, 201);
  const call = p.ai.calls.filter((x) => x.fn === "kbAddLead").at(-1)!;
  assert.deepEqual(call.args[1], { name: "Ali", contact: "ali@example.com", question: "Zəmanət?", conversation: [{ role: "user", text: "operatora bağla" }, { role: "model", text: "Formada əlaqə qoyun" }] });
  const mail = p.mails.find((m) => m.to === t.email && /Yeni müraciət/.test(m.subject));
  assert.ok(mail && mail.text.includes("ali@example.com") && mail.text.includes("Zəmanət?") && mail.text.includes("Ziyarətçi: operatora bağla"));

  const before = p.ai.calls.length;
  const bot = await site(t.key, "/contact", { contact: "bot@example.com", website: "http://spam" });
  assert.equal(bot.status, 200);
  assert.equal(p.ai.calls.length, before, "bot müraciəti AI-yə getmir");

  p.ai.failNext = new AiError(500, "gizli daxili xəta");
  const f = await site(t.key, "/contact", { contact: "x@example.com" });
  assert.equal(f.status, 502);
  assert.ok(!JSON.stringify(f.body).includes("gizli"));

  const limited = p.client();
  let last = 0;
  for (let i = 0; i < 5; i++) last = (await limited.call("POST", `/widget/${t.key}/contact`, { contact: "l@example.com" }, { origin: "https://magaza.az" })).status;
  assert.equal(last, 429);
});

test("vidjet cavabı: mənbələr təmizlənir (yalnız http(s) link), unanswered ötürülür", async () => {
  const t = await supportTenant();
  const orig = p.ai.chat;
  p.ai.chat = async () => ({ answer: "Cavab", listings: [], sources: [{ title: "FAQ", url: "https://magaza.az/faq" }, { title: "Pis", url: "javascript:alert(1)" }], unanswered: true });
  try {
    const r = await site(t.key, "/chat", { message: "salam" });
    assert.equal(r.status, 200);
    assert.equal(r.body.unanswered, true);
    assert.equal(r.body.sources[0].url, "https://magaza.az/faq");
    assert.equal(r.body.sources[1].url, undefined);
  } finally { p.ai.chat = orig; }
});

test("rejim dəyişəndə defolt salamlama uyğunlaşır, fərdi salamlama toxunulmaz qalır", async () => {
  const c = await p.signedIn("sw@example.com");
  await c.call("POST", "/tenant", { config: { businessName: "M", domain: "magaza.az", source: { type: "rest" } } });
  assert.equal((await c.call("GET", "/tenant/widget")).body.widget.greeting, DEFAULT_GREETING);
  assert.equal((await c.call("PATCH", "/tenant/profile", { mode: "support" })).status, 200);
  assert.equal((await c.call("GET", "/tenant/widget")).body.widget.greeting, DEFAULT_GREETING_SUPPORT);
  await c.call("PUT", "/tenant/widget", { greeting: "Mənim salamım" });
  await c.call("PATCH", "/tenant/profile", { mode: "listings" });
  assert.equal((await c.call("GET", "/tenant/widget")).body.widget.greeting, "Mənim salamım");
});

test("kb endpoint-ləri giriş tələb edir və AI servisinə düzgün ötürür", async () => {
  assert.equal((await p.client().call("GET", "/tenant/kb")).status, 401);
  const { c } = await supportTenant();
  assert.equal((await c.call("GET", "/tenant/kb")).status, 200);
  assert.equal((await c.call("POST", "/tenant/kb/urls", { url: "ftp://x" })).status, 400);
  const u = await c.call("POST", "/tenant/kb/urls", { url: "https://magaza.az", crawl: true });
  assert.equal(u.status, 202);
  assert.deepEqual(p.ai.calls.filter((x) => x.fn === "kbAddUrl").at(-1)!.args.slice(1), ["https://magaza.az", true]);
  assert.equal((await c.call("POST", "/tenant/kb/texts", { text: "qısa" })).status, 400);
  assert.equal((await c.call("POST", "/tenant/kb/texts", { title: "FAQ", text: "Çatdırılma 3 iş günü çəkir, pulsuzdur." })).status, 202);
  assert.equal((await c.call("DELETE", "/tenant/kb/sources/../../x")).status, 404);
  assert.equal((await c.call("DELETE", "/tenant/kb/sources/bad id")).status, 400);
  assert.equal((await c.call("DELETE", "/tenant/kb/sources/abcdef12-3456")).status, 200);
  assert.equal((await c.call("PATCH", "/tenant/kb/leads/abcdef12-3456", { handled: "yes" })).status, 400);
  assert.equal((await c.call("PATCH", "/tenant/kb/leads/abcdef12-3456", { handled: true })).status, 200);
});

test("fayl yükləmə: böyük gövdə yalnız /kb/files-da qəbul olunur, digər yerlərdə 413", async () => {
  const { c } = await supportTenant();
  const big = "A".repeat(3_000_000);
  const ok = await c.call("POST", "/tenant/kb/files", { name: "a.pdf", mime: "application/pdf", data: big });
  assert.equal(ok.status, 202);
  const sent = p.ai.calls.filter((x) => x.fn === "kbAddFile").at(-1)!.args[1] as { name: string; data: string };
  assert.equal(sent.name, "a.pdf");
  assert.equal(sent.data.length, big.length);
  const bad = await c.call("POST", "/tenant/kb/texts", { text: big });
  assert.equal(bad.status, 413);
  assert.equal((await c.call("POST", "/tenant/kb/files", { name: "", data: "x" })).status, 400);
});

test("overview: quraşdırma addımları, diqqət siyahısı və keyfiyyət göstəriciləri", async () => {
  const { c, key } = await supportTenant();
  const orig = { ...p.ai };
  const now = new Date().toISOString(), old = new Date(Date.now() - 40 * 86_400_000).toISOString();
  p.ai.kbInfo = async () => ({ sources: [{ status: "ready" }, { status: "failed" }] });
  p.ai.kbUnanswered = async () => ({ items: [{ at: now }, { at: now }, { at: old }] });
  p.ai.kbLeads = async () => ({ open: 2, items: [{ at: now }, { at: old }] });
  p.ai.queryStats = async () => ({ enabled: true, total: 10, noResults: 3, errors: 1, top: [{ message: "a", count: 4 }] });
  try {
    let o = (await c.call("GET", "/tenant/overview")).body;
    assert.equal(o.mode, "support");
    assert.equal(o.setup.dataReady, true);
    assert.equal(o.setup.widgetInstalled, false, "script hələ yüklənməyib");
    assert.equal(o.setup.firstQuestion, true);
    assert.deepEqual(o.attention.map((x: any) => [x.kind, x.count]), [["leads", 2], ["unanswered", 2], ["sourceErrors", 1]]);
    assert.equal(o.quality.answerRate, 60);
    assert.equal(o.quality.handoffs, 1);
    assert.equal(o.top[0].message, "a");

    // vidjet saytda yüklənəndə quraşdırma addımı tamamlanır
    assert.equal((await site(key, "/config")).status, 200);
    await new Promise((r) => setTimeout(r, 50));
    o = (await c.call("GET", "/tenant/overview")).body;
    assert.equal(o.setup.widgetInstalled, true);

    // söndürülmüş vidjet diqqət siyahısına düşür; AI xətası səhifəni sındırmır
    await c.call("PUT", "/tenant/widget", { enabled: false });
    p.ai.queryStats = async () => { throw new AiError(502, "x"); };
    o = (await c.call("GET", "/tenant/overview")).body;
    assert.equal(o.attention[0].kind, "widgetOff");
    assert.equal(o.quality.answerRate, null);
  } finally { Object.assign(p.ai, orig); }
});

test("overview elan rejimində: nəticəsiz sorğular diqqət siyahısındadır, bilik bazasının mənbələri sorğulanmır", async () => {
  const c = await p.signedIn("ovl@example.com");
  await c.call("POST", "/tenant", { config: { businessName: "M", domain: "magaza.az", source: { type: "rest" } } });
  const orig = p.ai.queryStats;
  p.ai.queryStats = async () => ({ enabled: true, total: 4, noResults: 2, errors: 0, top: [] });
  const before = p.ai.calls.length;
  try {
    const o = (await c.call("GET", "/tenant/overview")).body;
    assert.deepEqual(o.attention, [{ kind: "noResults", count: 2 }]);
    assert.equal(o.setup.dataReady, true);
    assert.equal(o.quality.handoffs, null);
    assert.ok(!p.ai.calls.slice(before).some((x) => x.fn === "kbInfo" || x.fn === "kbUnanswered"));
  } finally { p.ai.queryStats = orig; }
});

test("sual-cavab cütləri: yaradılır, yenilənir, yalnız öz sahibinin hesabına gedir", async () => {
  const c = await p.signedIn(`qa${Date.now()}@example.com`);
  assert.equal((await c.call("POST", "/tenant", { config: { businessName: "Kontakt", domain: "kontakt.az", profile: { mode: "support" }, source: { type: "rest" } } })).status, 201);
  const made = await c.call("POST", "/tenant/kb/qa", { questions: ["Çatdırılma neçə günə olur", 5, "Nə vaxt çatır"], answer: "2 iş günü." });
  assert.equal(made.status, 201);
  const call1 = p.ai.calls.filter((x) => x.fn === "kbAddQa").at(-1)!;
  assert.deepEqual((call1.args[1] as { questions: string[] }).questions, ["Çatdırılma neçə günə olur", "Nə vaxt çatır"], "mətn olmayan sual atılır");
  assert.equal((await c.call("PUT", "/tenant/kb/qa/qa-12345678", { questions: ["Yeni sual burada"], answer: "Yeni cavab" })).status, 200);
  assert.equal(p.ai.calls.filter((x) => x.fn === "kbUpdateQa").at(-1)!.args[1], "qa-12345678");
  const anon = p.client();
  assert.equal((await anon.call("POST", "/tenant/kb/qa", { questions: ["x y z"], answer: "cavab" })).status, 401);
});
