import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import WebSocket from "ws";
import { startPortal } from "./helpers.js";
import { __setNotifyBot } from "../src/operator-notify.js";

const BOT = "999:notify-token";
let p: Awaited<ReturnType<typeof startPortal>>;
before(async () => { p = await startPortal({ notifyBotToken: BOT }); __setNotifyBot("op_alerts_bot"); });
after(() => p.close());

const config = { businessName: "Motoelan", domain: "motoelan.com", source: { type: "rest" } };
const ORIGIN = "https://motoelan.com";
const derive = (label: string) => createHash("sha256").update(`${label}:${BOT}:${p.deps.config.aiServiceToken}`).digest("hex");
const hook = () => derive("notify-hook").slice(0, 32), secret = () => derive("notify-secret").slice(0, 48);
const tg = (body: unknown, s = secret()) => fetch(`${p.base}/telegram-notify/${hook()}`, { method: "POST", headers: { "content-type": "application/json", "x-telegram-bot-api-secret-token": s }, body: JSON.stringify(body) });
const start = (chatId: number, text: string) => tg({ message: { text, chat: { id: chatId, type: "private" }, from: { first_name: "Aynur", username: "aynur" } } });
const toChat = (chatId: number) => p.telegram.sent.filter((m) => m.token === BOT && m.chatId === String(chatId));
const until = async (cond: () => boolean, ms = 1500) => { const t = Date.now(); while (!cond()) { if (Date.now() - t > ms) throw new Error("gözləmə bitdi"); await new Promise((r) => setTimeout(r, 15)); } };

let n = 0;
async function owner() {
  const c = await p.signedIn(`nt${++n}@example.com`);
  assert.equal((await c.call("POST", "/tenant", { config })).status, 201);
  const key = (await c.call("GET", "/tenant/widget")).body.widget.key as string;
  await c.call("PUT", "/tenant/widget", { live: { enabled: true } });
  return { c, key };
}
async function link(c: Awaited<ReturnType<typeof owner>>["c"], chatId: number) {
  const r = await c.call("POST", "/tenant/notify/telegram");
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const code = String(r.body.url).match(/^https:\/\/t\.me\/op_alerts_bot\?start=([A-Za-z0-9_-]+)$/)![1]!;
  await start(chatId, `/start ${code}`);
  await until(() => toChat(chatId).some((m) => m.text.startsWith("✅")));
  return code;
}

test("bağlama: link -> /start kod -> bağlandı; kod təkrar işləmir; ayırmaq", async () => {
  const { c } = await owner();
  assert.deepEqual((await c.call("GET", "/tenant/notify")).body, { available: true, botUsername: "op_alerts_bot", telegram: null });
  const code = await link(c, 5001);
  const v = (await c.call("GET", "/tenant/notify")).body;
  assert.equal(v.telegram.name, "Aynur @aynur");
  await start(5002, `/start ${code}`);
  await until(() => toChat(5002).some((m) => m.text.includes("köhnəlib")));
  assert.equal((await c.call("DELETE", "/tenant/notify/telegram")).body.telegram, null);
  assert.ok(toChat(5001).some((m) => m.text.includes("ayrıldı")));
});

test("webhook: səhv gizli başlıq 404; adi mesaja izah", async () => {
  assert.equal((await tg({ message: { text: "/start x" } }, "yanlis")).status, 404);
  await start(5003, "salam");
  await until(() => toChat(5003).some((m) => m.text.includes("yalnız canlı söhbət bildirişləri")));
});

test("yeni canlı söhbət: bağlı operatora Telegram mesajı; panel bağlı ikən ziyarətçi mesajı da, panel açıq ikən yox", async () => {
  const { c, key } = await owner();
  await link(c, 6001);
  const v = p.client();
  const visitor = (method: string, path: string, body?: unknown) => v.call(method, path, body, { origin: ORIGIN });
  const s = await visitor("POST", `/widget/${key}/live`, { message: "Salam, zəmanət var?" });
  await until(() => toChat(6001).some((m) => m.text.includes("Yeni canlı söhbət")));
  assert.match(toChat(6001).find((m) => m.text.includes("Yeni canlı söhbət"))!.text, /Ziyarətçi: Salam, zəmanət var\?/);

  await visitor("POST", `/widget/${key}/live/${s.body.id}/sync`, { token: s.body.token, after: 1, text: "Kimsə var?" });
  await until(() => toChat(6001).some((m) => m.text.includes("Kimsə var?")));
  await visitor("POST", `/widget/${key}/live/${s.body.id}/sync`, { token: s.body.token, after: 2, text: "Təkrar" });
  await new Promise((r) => setTimeout(r, 100));
  assert.ok(!toChat(6001).some((m) => m.text.includes("Təkrar")), "eyni söhbətə 3 dəqiqədə bir");

  // panel açıqdır (operator soketi): ziyarətçi mesajı Telegram-a getmir
  const s2 = await visitor("POST", `/widget/${key}/live`, { message: "İkinci" });
  const ticket = (await c.call("POST", "/tenant/live/ws-ticket")).body.ticket;
  const ws = new WebSocket(p.base.replace("http", "ws") + "/ws", { headers: { origin: "http://localhost:3001" } });
  const ready = new Promise<void>((r) => ws.on("message", (d) => { if (JSON.parse(d.toString()).t === "ready") r(); }));
  ws.on("open", () => ws.send(JSON.stringify({ t: "auth", role: "operator", ticket })));
  await ready;
  await visitor("POST", `/widget/${key}/live/${s2.body.id}/sync`, { token: s2.body.token, after: 1, text: "Panel açıqdır" });
  await new Promise((r) => setTimeout(r, 100));
  assert.ok(!toChat(6001).some((m) => m.text.includes("Panel açıqdır")));
  ws.close();
});

test("operator botu bloklayıbsa bağlantı avtomatik silinir", async () => {
  const { c, key } = await owner();
  await link(c, 7001);
  const orig = p.telegram.sendMessage;
  p.telegram.sendMessage = async () => { const { TelegramError } = await import("../src/telegram.js"); throw new TelegramError(403, "Forbidden: bot was blocked by the user"); };
  try {
    await p.client().call("POST", `/widget/${key}/live`, { message: "Salam" }, { origin: ORIGIN });
    await new Promise((r) => setTimeout(r, 100));
    assert.equal((await c.call("GET", "/tenant/notify")).body.telegram, null);
  } finally { p.telegram.sendMessage = orig; }
});
