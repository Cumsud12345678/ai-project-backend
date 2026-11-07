import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { startPortal } from "./helpers.js";
import { automationsOf, matches, parseAutomations, runDaily } from "../src/automations.js";

let p: Awaited<ReturnType<typeof startPortal>>;
before(async () => { p = await startPortal(); });
after(() => p.close());

const config = { businessName: "Motoelan", domain: "motoelan.com", source: { type: "rest" } };
const ORIGIN = "https://motoelan.com";
const until = async (cond: () => boolean, ms = 1500) => { const t = Date.now(); while (!cond()) { if (Date.now() - t > ms) throw new Error("gözləmə bitdi"); await new Promise((r) => setTimeout(r, 15)); } };
let n = 0;
async function setup() {
  const email = `au${++n}@example.com`;
  const c = await p.signedIn(email);
  assert.equal((await c.call("POST", "/tenant", { config })).status, 201);
  const key = (await c.call("GET", "/tenant/widget")).body.widget.key as string;
  const v = (method: string, path: string, body?: unknown) => p.client().call(method, path, body, { origin: ORIGIN });
  return { c, key, v, email };
}

test("doğrulama: hadisəyə uyğun olmayan addım, boş siyahı, səhv saat rədd olunur; şərtlər işləyir", () => {
  const ok = parseAutomations([{ name: "Pis qiymət", trigger: "bad_rating", actions: [{ type: "ticket", priority: "high" }, { type: "tag", tag: "şikayət" }], when: { source: "csat", channel: "any" } }]);
  assert.match(ok[0]!.id, /^[a-f0-9]{8}$/); assert.deepEqual(ok[0]!.when, { source: "csat" });
  for (const bad of [
    [{ name: "x", trigger: "daily", actions: [{ type: "tag", tag: "a" }] }],
    [{ name: "x", trigger: "lead", actions: [] }],
    [{ name: "x", trigger: "daily", actions: [{ type: "email" }], when: { hour: 24 } }],
    [{ name: "", trigger: "lead", actions: [{ type: "email" }] }],
    [{ name: "x", trigger: "lead", actions: [{ type: "email" }, { type: "email" }] }],
    [{ name: "x", trigger: "nope", actions: [{ type: "email" }] }],
    Array(16).fill({ name: "x", trigger: "lead", actions: [{ type: "email" }] }),
  ]) assert.throws(() => parseAutomations(bad), /./, JSON.stringify(bad).slice(0, 60));
  const [a] = parseAutomations([{ name: "Bağlanan", trigger: "chat_closed", actions: [{ type: "email" }], when: { channel: "telegram", withContact: true } }]);
  const ev = { trigger: "chat_closed" as const, chatId: "c", channel: "telegram" as const, name: "", contact: "", tags: [], count: 1, transcript: [] };
  assert.equal(matches(a!, ev), false, "əlaqə yoxdur");
  assert.equal(matches(a!, { ...ev, contact: "+994501112233" }), true);
  assert.equal(matches(a!, { ...ev, contact: "+994501112233", channel: "site" }), false, "başqa kanal");
  // köhnə hesab: qoşulmuş yerlərdən gizli "yeni müraciət → göndər"
  const legacy = automationsOf({ leadForward: { webhook: { urlEnc: "x", host: "h" } } } as never);
  assert.equal(legacy.implicit, true); assert.deepEqual(legacy.items[0]!.actions, [{ type: "webhook" }]);
});

test("yeni müraciət → webhook; son işləmə yazılır; söndürülmüş işləmir", async () => {
  const { c, key, v } = await setup();
  const posts: { url: string; body: any }[] = [];
  p.deps.httpPost = async (url, body) => { posts.push({ url, body }); return { ok: true, status: 200, json: {} }; };
  try {
    assert.equal((await c.call("PUT", "/tenant/lead-forward/webhook", { url: "https://script.google.com/macros/s/AKfy/exec" })).status, 200);
    assert.equal((await c.call("PUT", "/tenant/automations", { items: [{ name: "x", trigger: "lead", actions: [{ type: "email" }] }] })).status, 400, "müraciətdə e-poçt addımı yoxdur (sahib onsuz da alır)");
    const put = await c.call("PUT", "/tenant/automations", { items: [{ name: "Müraciət Sheets-ə", trigger: "lead", actions: [{ type: "webhook" }] }] });
    assert.equal(put.status, 200, JSON.stringify(put.body)); assert.equal(put.body.implicit, false);
    posts.length = 0;
    await v("POST", `/widget/${key}/contact`, { contact: "ali@example.com", question: "Çatdırılma var?" });
    await until(() => posts.some((x) => x.body.event === "lead" && x.body.contact === "ali@example.com"));
    await until(() => false, 100).catch(() => {});
    const got = (await c.call("GET", "/tenant/automations")).body.items[0];
    assert.equal(got.runs, 1); assert.equal(got.lastRun.ok, true);

    await c.call("PUT", "/tenant/automations", { items: [{ ...got, enabled: false }] });
    posts.length = 0;
    await v("POST", `/widget/${key}/contact`, { contact: "veli@example.com", question: "x" });
    await until(() => false, 150).catch(() => {});
    assert.equal(posts.length, 0, "söndürülüb");
    assert.equal((await c.call("GET", "/tenant/automations")).body.items[0].runs, 1, "sayğac qorunur");
  } finally { p.deps.httpPost = undefined; }
});

test("pis CSAT → müraciət (yüksək prioritet) + teq; bağlanma → e-poçt", async () => {
  const { c, key, v, email } = await setup();
  await c.call("PUT", "/tenant/widget", { live: { enabled: true } });
  await c.call("PUT", "/tenant/automations", { items: [
    { name: "Pis qiymət", trigger: "bad_rating", actions: [{ type: "ticket", priority: "high" }, { type: "tag", tag: "Şikayət" }] },
    { name: "Bağlanan söhbət", trigger: "chat_closed", actions: [{ type: "email" }], when: { withContact: true } },
  ] });
  const start = await v("POST", `/widget/${key}/live`, { message: "Sifarişim gəlmədi", name: "Elnur", contact: "+994501234567" });
  const { id, token } = start.body as { id: string; token: string };
  await c.call("POST", `/tenant/live/${id}/messages`, { text: "Yoxlayıram" });
  const before = p.mails.length;
  assert.equal((await c.call("POST", `/tenant/live/${id}/close`)).status, 200);
  await until(() => p.mails.slice(before).some((m) => m.to === email && m.subject.startsWith("Söhbət bağlandı") && m.text.includes("Sifarişim gəlmədi")));

  const calls = p.ai.calls.length;
  assert.equal((await v("POST", `/widget/${key}/live/${id}/csat`, { token, rating: 1, comment: "Çox gec" })).status, 201);
  await until(() => p.ai.calls.slice(calls).some((x) => x.fn === "kbAddLead"));
  const lead = p.ai.calls.slice(calls).find((x) => x.fn === "kbAddLead")!.args[1] as { contact: string; question: string };
  assert.equal(lead.contact, "+994501234567"); assert.match(lead.question, /Pis qiymət 1\/5: Çox gec/);
  await until(() => false, 100).catch(() => {});
  assert.deepEqual((await c.call("GET", `/tenant/live/${id}`)).body.chat.tags, ["Şikayət"]);
});

test("gündəlik xülasə: saatı çatanda bir dəfə göndərilir; sınaq düyməsi heç nə yaratmır", async () => {
  const { c, email } = await setup();
  await c.call("PUT", "/tenant/automations", { items: [{ name: "Səhər xülasəsi", trigger: "daily", actions: [{ type: "email" }], when: { hour: 0 } }] });
  const before = p.mails.length;
  assert.ok(await runDaily(p.deps) >= 1);
  assert.ok(p.mails.slice(before).some((m) => m.to === email && m.subject.includes("xülasəsi") && m.text.includes("Söhbətlər")));
  const mid = p.mails.length;
  await runDaily(p.deps);
  assert.ok(!p.mails.slice(mid).some((m) => m.to === email), "eyni gün ikinci dəfə göndərilmir");

  const calls = p.ai.calls.length;
  const t = await c.call("POST", "/tenant/automations/test", { item: { name: "Sınaq", trigger: "bad_rating", actions: [{ type: "email" }, { type: "ticket", priority: "normal" }, { type: "telegram" }] } });
  assert.equal(t.status, 200);
  assert.deepEqual(t.body.steps.map((s: { ok: boolean }) => s.ok), [true, true, false], "Telegram qoşulmayıb");
  assert.ok(!p.ai.calls.slice(calls).some((x) => x.fn === "kbAddLead"), "sınaqda müraciət yaradılmır");
  assert.ok(p.mails.some((m) => m.to === email && m.subject.startsWith("🧪 Sınaq")));
  // operator görə bilmir
  await c.call("POST", "/tenant/team", { email: `op-${email}` });
  assert.equal((await (await p.signedIn(`op-${email}`)).call("GET", "/tenant/automations")).status, 404);
});
