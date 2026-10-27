import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { fetchImage, isPrivateIp, sniffImage } from "../src/safe-image.js";
import { formatReply } from "../src/channel-chat.js";
import { startPortal } from "./helpers.js";

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(40)]);
const pub = async () => [{ address: "93.184.216.34" }];
const resp = (body: Buffer | string, init: ResponseInit = {}) => new Response(body as BodyInit, init);

test("isPrivateIp: daxili ünvanlar tutulur, ictimai buraxılır", () => {
  for (const ip of ["127.0.0.1", "10.1.2.3", "192.168.0.5", "172.16.0.1", "169.254.169.254", "0.0.0.0", "::1", "fd00::1", "::ffff:10.0.0.1", "100.64.0.1"]) assert.ok(isPrivateIp(ip), ip);
  for (const ip of ["93.184.216.34", "8.8.8.8", "2606:4700::1"]) assert.ok(!isPrivateIp(ip), ip);
});

test("fetchImage: düzgün şəkil gəlir; daxili ünvan, redirect-lə daxiliyə keçid, böyük fayl, saxta şəkil rədd olunur", async () => {
  const ok = await fetchImage("https://cdn.example.com/a.png", { lookup: pub, fetchFn: (async () => resp(PNG)) as typeof fetch });
  assert.equal(ok?.mime, "image/png");
  let calls = 0;
  const never = (async () => { calls++; return resp(PNG); }) as typeof fetch;
  assert.equal(await fetchImage("http://127.0.0.1/a.png", { fetchFn: never }), null);
  assert.equal(await fetchImage("http://169.254.169.254/latest", { fetchFn: never }), null);
  assert.equal(await fetchImage("https://evil.example/a.png", { lookup: async () => [{ address: "10.0.0.7" }], fetchFn: never }), null);
  assert.equal(await fetchImage("file:///etc/passwd", { fetchFn: never }), null);
  assert.equal(calls, 0, "daxili ünvana sorğu getməməlidir");
  // redirect daxili ünvana
  const hosts = new Map([["cdn.example.com", "93.184.216.34"], ["internal.example", "10.0.0.9"]]);
  const lk = async (h: string) => [{ address: hosts.get(h) ?? "93.184.216.34" }];
  const redir = (async (u: URL) => u.hostname === "cdn.example.com" ? resp("", { status: 302, headers: { location: "http://internal.example/x.png" } }) : resp(PNG)) as unknown as typeof fetch;
  assert.equal(await fetchImage("https://cdn.example.com/a.png", { lookup: lk, fetchFn: redir }), null);
  assert.equal(await fetchImage("https://cdn.example.com/big.png", { lookup: pub, fetchFn: (async () => resp(Buffer.alloc(4 * 1024 * 1024))) as typeof fetch }), null);
  assert.equal(await fetchImage("https://cdn.example.com/x.png", { lookup: pub, fetchFn: (async () => resp("<html>not image</html>")) as typeof fetch }), null);
  assert.equal(sniffImage(Buffer.from("GIF89a....")), null);
});

test("formatReply: şəkli ayrıca göndərilən elan mətndən çıxarılır", () => {
  const out = { answer: "Bunlar var", listings: [{ title: "A", url: "https://x.az/a" }, { title: "B", url: "https://x.az/b" }] };
  assert.match(formatReply(out), /A[\s\S]*B/);
  const t = formatReply(out, new Set([0]));
  assert.ok(!t.includes("• A") && t.includes("• B"));
});

let p: Awaited<ReturnType<typeof startPortal>>;
before(async () => { p = await startPortal(); p.deps.imageFetcher = async (url) => (url.includes("broken") ? null : { data: PNG, mime: "image/png" }); });
after(() => p.close());

const LISTINGS = [
  { title: "BMW 520", price: 20000, currency: "AZN", url: "https://x.az/1", image: "https://cdn.x.az/1.jpg" },
  { title: "Audi A6", price: 18000, currency: "AZN", url: "https://x.az/2", image: "https://cdn.x.az/broken.jpg" },
  { title: "Kia", price: 9000, currency: "AZN", url: "https://x.az/3" },
];
const waitFor = async (cond: () => boolean, ms = 2000) => { const t0 = Date.now(); while (!cond() && Date.now() - t0 < ms) await new Promise((r) => setTimeout(r, 10)); return cond(); };

test("Telegram: şəkilli elanlar sendPhoto ilə; alınmayan və şəkilsiz elan mətn kimi", async () => {
  const c = await p.signedIn("ph1@example.com");
  assert.equal((await c.call("POST", "/tenant", { config: { businessName: "Kontakt", domain: "kontakt.az", profile: { mode: "support" }, source: { type: "rest" } } })).status, 201);
  const token = `900000555:AAH${"x".repeat(32)}`;
  assert.equal((await c.call("PUT", "/tenant/channels/telegram", { token })).status, 200);
  const hook = p.telegram.hooks.get(token)!;
  p.ai.nextChat = { answer: "Bunlar var", listings: LISTINGS, usage: { tokens: 5 } };
  const before = p.telegram.sent.length;
  await fetch(p.base + new URL(hook.url).pathname, { method: "POST", headers: { "content-type": "application/json", "x-telegram-bot-api-secret-token": hook.secret }, body: JSON.stringify({ update_id: 5001, message: { text: "maşın", chat: { id: 55, type: "private" }, from: { first_name: "Ali", is_bot: false } } }) });
  assert.ok(await waitFor(() => p.telegram.photos.length === 2));
  assert.ok(p.telegram.photos[0]!.caption.includes("BMW 520") && p.telegram.photos[0]!.caption.includes("https://x.az/1"));
  const texts = p.telegram.sent.slice(before).map((m) => m.text);
  assert.ok(texts[0]!.includes("Kia") && !texts[0]!.includes("BMW"), "şəkli olmayan elan mətndədir, şəkilli yox");
  p.telegram.failPhoto = true;
  p.ai.nextChat = { answer: "Yenə", listings: [LISTINGS[0]], usage: { tokens: 5 } };
  await fetch(p.base + new URL(hook.url).pathname, { method: "POST", headers: { "content-type": "application/json", "x-telegram-bot-api-secret-token": hook.secret }, body: JSON.stringify({ update_id: 5002, message: { text: "yenə", chat: { id: 55, type: "private" }, from: { first_name: "Ali", is_bot: false } } }) });
  assert.ok(await waitFor(() => p.telegram.sent.some((m) => m.text.includes("• BMW 520"))), "şəkil alınmasa elan mətn kimi göndərilir");
  p.telegram.failPhoto = false;
});

test("WhatsApp: şəkil yüklənirsə image kimi, yüklənmirsə mətn kimi göndərilir", async () => {
  const c = await p.signedIn("ph2@example.com");
  assert.equal((await c.call("POST", "/tenant", { config: { businessName: "Kontakt", domain: "kontakt.az", profile: { mode: "support" }, source: { type: "rest" } } })).status, 201);
  assert.equal((await c.call("POST", "/tenant/channels/whatsapp/connect", { ack: true })).status, 200);
  const s = p.wa.last();
  s.user = { id: "994507770011:7@s.whatsapp.net" };
  s.emit("connection.update", { qr: "2@x" });
  s.emit("connection.update", { connection: "open" });
  for (let i = 0; i < 100 && !(await c.call("GET", "/tenant/channels/whatsapp")).body.connected; i++) await new Promise((r) => setTimeout(r, 10));
  p.ai.nextChat = { answer: "Bunlar var", listings: LISTINGS, usage: { tokens: 5 } };
  s.emit("messages.upsert", { type: "notify", messages: [{ key: { remoteJid: "994559990000@s.whatsapp.net", fromMe: false, id: "PH1" }, pushName: "Ali", messageTimestamp: Math.floor(Date.now() / 1000), message: { conversation: "maşın" } }] });
  assert.ok(await waitFor(() => s.images.length === 1 && s.sent.some((m) => m.text.includes("• Audi A6"))));
  assert.ok(s.images[0]!.caption.includes("BMW 520") && s.images[0]!.bytes === PNG.length);
  assert.ok(s.sent.some((m) => m.text.includes("Kia")), "şəkilsiz elan mətndə");
});

test("WhatsApp: dalbadal mesajlar bir sual kimi birləşir, bir cavab gəlir", async () => {
  const q = await startPortal({}, 150);
  try {
    const c = await q.signedIn("batch1@example.com");
    assert.equal((await c.call("POST", "/tenant", { config: { businessName: "Kontakt", domain: "kontakt.az", profile: { mode: "support" }, source: { type: "rest" } } })).status, 201);
    assert.equal((await c.call("POST", "/tenant/channels/whatsapp/connect", { ack: true })).status, 200);
    const s = q.wa.last();
    s.user = { id: "994507770022:7@s.whatsapp.net" };
    s.emit("connection.update", { qr: "2@x" });
    s.emit("connection.update", { connection: "open" });
    for (let i = 0; i < 100 && !(await c.call("GET", "/tenant/channels/whatsapp")).body.connected; i++) await new Promise((r) => setTimeout(r, 10));
    const send = (id: string, text: string) => s.emit("messages.upsert", { type: "notify", messages: [{ key: { remoteJid: "994559991111@s.whatsapp.net", fromMe: false, id }, pushName: "Ali", messageTimestamp: Math.floor(Date.now() / 1000), message: { conversation: text } }] });
    send("B1", "salam"); await new Promise((r) => setTimeout(r, 50));
    send("B2", "qiymət nədir"); await new Promise((r) => setTimeout(r, 50));
    send("B3", ".");
    assert.ok(await waitFor(() => q.ai.calls.filter((x) => x.fn === "chat").length >= 1));
    await new Promise((r) => setTimeout(r, 400));
    const calls = q.ai.calls.filter((x) => x.fn === "chat");
    assert.equal(calls.length, 1, "3 mesaj → 1 AI sorğusu");
    assert.equal(calls[0]!.args[1], "salam\nqiymət nədir\n.");
    assert.equal(s.sent.length, 1, "bir cavab");
  } finally { await q.close(); }
});

test("Telegram: dalbadal mesajlar bir sual kimi birləşir", async () => {
  const c = await p.signedIn("batch2@example.com");
  assert.equal((await c.call("POST", "/tenant", { config: { businessName: "Kontakt", domain: "kontakt.az", profile: { mode: "support" }, source: { type: "rest" } } })).status, 201);
  const token = `900000777:AAH${"y".repeat(32)}`;
  assert.equal((await c.call("PUT", "/tenant/channels/telegram", { token })).status, 200);
  const hook = p.telegram.hooks.get(token)!;
  p.deps.telegramBatchMs = 150;
  const before = p.ai.calls.filter((x) => x.fn === "chat").length;
  let id = 9000;
  const send = async (text: string) => { await fetch(p.base + new URL(hook.url).pathname, { method: "POST", headers: { "content-type": "application/json", "x-telegram-bot-api-secret-token": hook.secret }, body: JSON.stringify({ update_id: ++id, message: { text, chat: { id: 66, type: "private" }, from: { first_name: "Ali", is_bot: false } } }) }); await new Promise((r) => setTimeout(r, 40)); };
  await send("salam"); await send("qiymət?"); await send(".");
  assert.ok(await waitFor(() => p.ai.calls.filter((x) => x.fn === "chat").length > before));
  await new Promise((r) => setTimeout(r, 400));
  const calls = p.ai.calls.filter((x) => x.fn === "chat").slice(before);
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.args[1], "salam\nqiymət?\n.");
  p.deps.telegramBatchMs = 0;
});
