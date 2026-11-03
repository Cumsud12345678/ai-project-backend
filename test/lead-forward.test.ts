import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { startPortal } from "./helpers.js";
import { __setNotifyBot } from "../src/operator-notify.js";
import { isBitrixUrl, type PostResult } from "../src/lead-forward.js";

const BOT = "999:notify-token";
let p: Awaited<ReturnType<typeof startPortal>>;
const posts: { url: string; body: any }[] = [];
let reply: (url: string) => PostResult = () => ({ ok: true, status: 200, json: { result: 1 } });
before(async () => {
  p = await startPortal({ notifyBotToken: BOT }); __setNotifyBot("op_alerts_bot");
  p.deps.httpPost = async (url, body) => { posts.push({ url, body }); return reply(url); };
});
after(() => p.close());

const config = { businessName: "Motoelan", domain: "motoelan.com", source: { type: "rest" } };
const ORIGIN = "https://motoelan.com";
const BITRIX = "https://motoelan.bitrix24.az/rest/1/abc123secret/";
const until = async (cond: () => boolean, ms = 1500) => { const t = Date.now(); while (!cond()) { if (Date.now() - t > ms) throw new Error("gözləmə bitdi"); await new Promise((r) => setTimeout(r, 15)); } };
let n = 0;
async function setup() {
  const c = await p.signedIn(`lf${++n}@example.com`);
  assert.equal((await c.call("POST", "/tenant", { config })).status, 201);
  const key = (await c.call("GET", "/tenant/widget")).body.widget.key as string;
  const lead = (body: Record<string, unknown>) => p.client().call("POST", `/widget/${key}/contact`, body, { origin: ORIGIN });
  return { c, key, lead };
}

test("Bitrix24 link formatı", () => {
  assert.ok(isBitrixUrl(BITRIX)); assert.ok(isBitrixUrl("https://crm.sirket.az/rest/12/x1Y2z3"));
  for (const bad of ["http://a.bitrix24.az/rest/1/abc/", "https://a.bitrix24.az/rest/abc/", "https://a.bitrix24.az/x/1/abc/", "https://a/rest/1/abc/"]) assert.ok(!isBitrixUrl(bad), bad);
});

test("Bitrix24: link yoxlanır (heç nə yaratmadan), şifrəli saxlanır, panelə yalnız domen qayıdır; yeni müraciət CRM-də lid olur", async () => {
  const { c, lead } = await setup();
  assert.equal((await c.call("PUT", "/tenant/lead-forward/bitrix", { url: "https://x.az/abc" })).body.code, "BAD_URL");
  reply = () => ({ ok: true, status: 200, json: { error: "insufficient_scope", error_description: "The request requires higher privileges" } });
  const bad = await c.call("PUT", "/tenant/lead-forward/bitrix", { url: BITRIX });
  assert.equal(bad.body.code, "BITRIX_FAILED"); assert.match(bad.body.error, /higher privileges/);
  reply = () => ({ ok: true, status: 200, json: { result: { TITLE: {} } } });
  posts.length = 0;
  const ok = await c.call("PUT", "/tenant/lead-forward/bitrix", { url: BITRIX });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.equal(posts[0]!.url, `${BITRIX}crm.lead.fields.json`, "yoxlama zamanı lid yaranmır");
  assert.deepEqual(ok.body.bitrix, { host: "motoelan.bitrix24.az" });
  assert.ok(!JSON.stringify((await c.call("GET", "/tenant/lead-forward")).body).includes("abc123secret"), "açar panelə qayıtmır");
  const stored = (await p.store.findTenantByUser((await p.store.findUserByEmail(`lf${n}@example.com`))!.id))!.leadForward!.bitrix!;
  assert.ok(!stored.urlEnc.includes("abc123secret"), "bazada şifrəlidir");

  posts.length = 0;
  assert.equal((await lead({ name: "Elvin", contact: "+994 50 123 45 67", question: "Kreditlə almaq olar?", page: { path: "/elan/5" } })).status, 201);
  await until(() => posts.length === 1);
  assert.equal(posts[0]!.url, `${BITRIX}crm.lead.add.json`);
  const f = posts[0]!.body.fields;
  assert.equal(f.NAME, "Elvin"); assert.equal(f.PHONE[0].VALUE, "+994 50 123 45 67"); assert.equal(f.SOURCE_ID, "WEB");
  assert.match(f.TITLE, /Kreditlə almaq olar/); assert.match(f.COMMENTS, /Səhifə: \/elan\/5/);
  assert.equal((await c.call("DELETE", "/tenant/lead-forward/bitrix")).body.bitrix, null);
});

test("webhook (Google Sheets / Make): 302 də uğurdur (Apps Script), müraciət JSON kimi gedir; xəta qaytaran link saxlanmır", async () => {
  const { c, lead } = await setup();
  assert.equal((await c.call("PUT", "/tenant/lead-forward/webhook", { url: "http://script.google.com/x" })).body.code, "BAD_URL");
  reply = () => ({ ok: false, status: 500, json: null });
  assert.equal((await c.call("PUT", "/tenant/lead-forward/webhook", { url: "https://hook.example.com/a" })).body.code, "WEBHOOK_FAILED");
  reply = () => ({ ok: true, status: 302, json: null });
  posts.length = 0;
  const ok = await c.call("PUT", "/tenant/lead-forward/webhook", { url: "https://script.google.com/macros/s/AKfy/exec" });
  assert.equal(ok.status, 200); assert.deepEqual(ok.body.webhook, { host: "script.google.com" });
  assert.equal(posts[0]!.body.event, "test");
  posts.length = 0;
  await lead({ contact: "ali@example.com", question: "Çatdırılma var?" });
  await until(() => posts.length === 1);
  const b = posts[0]!.body;
  assert.equal(b.event, "lead"); assert.equal(b.contact, "ali@example.com"); assert.equal(b.source, "sayt"); assert.equal(b.site, "motoelan.com");
});

test("Telegram qrupu: startgroup linki -> qrupa '/start@bot kod' -> bağlanır; müraciət qrupa gedir; bot çıxarılıbsa bağlantı silinir", async () => {
  const { c, lead } = await setup();
  const r = await c.call("POST", "/tenant/lead-forward/telegram");
  const code = String(r.body.url).match(/^https:\/\/t\.me\/op_alerts_bot\?startgroup=([A-Za-z0-9_-]+)$/)![1]!;
  const derive = (label: string) => createHash("sha256").update(`${label}:${BOT}:${p.deps.config.aiServiceToken}`).digest("hex");
  const hook = (body: unknown) => fetch(`${p.base}/telegram-notify/${derive("notify-hook").slice(0, 32)}`, { method: "POST", headers: { "content-type": "application/json", "x-telegram-bot-api-secret-token": derive("notify-secret").slice(0, 48) }, body: JSON.stringify(body) });
  await hook({ message: { text: "salam hamıya", chat: { id: -100777, type: "supergroup", title: "Satış" }, from: { first_name: "A" } } });
  await hook({ message: { text: `/start@op_alerts_bot ${code}`, chat: { id: -100777, type: "supergroup", title: "Satış komandası" }, from: { first_name: "A" } } });
  await until(() => p.telegram.sent.some((m) => m.chatId === "-100777" && m.text.startsWith("✅")));
  assert.ok(!p.telegram.sent.some((m) => m.chatId === "-100777" && m.text.includes("salam")), "qrupdakı adi yazışmaya qarışmır");
  assert.deepEqual((await c.call("GET", "/tenant/lead-forward")).body.telegram, { title: "Satış komandası" });

  await lead({ name: "Nigar", contact: "+994551112233", question: "Zəmanət neçə ildir?", chat: [{ role: "user", text: "Zəmanət?" }] });
  await until(() => p.telegram.sent.some((m) => m.chatId === "-100777" && m.text.includes("Yeni müraciət")));
  const msg = p.telegram.sent.find((m) => m.chatId === "-100777" && m.text.includes("Yeni müraciət"))!.text;
  assert.match(msg, /Ad: Nigar/); assert.match(msg, /Əlaqə: \+994551112233/); assert.match(msg, /Ziyarətçi: Zəmanət\?/);

  const orig = p.telegram.sendMessage;
  p.telegram.sendMessage = async () => { const { TelegramError } = await import("../src/telegram.js"); throw new TelegramError(403, "Forbidden: bot was kicked from the supergroup chat"); };
  try {
    await lead({ contact: "+994551112244", question: "x" });
    await until(() => false, 150).catch(() => {});
    assert.equal((await c.call("GET", "/tenant/lead-forward")).body.telegram, null);
  } finally { p.telegram.sendMessage = orig; }
});

test("komanda üzvü (operator) müraciət ötürmə ayarlarını görə bilmir", async () => {
  const { c } = await setup();
  await c.call("POST", "/tenant/team", { email: "op-lf@example.com" });
  const op = await p.signedIn("op-lf@example.com");
  assert.equal((await op.call("GET", "/tenant/lead-forward")).status, 404);
});
