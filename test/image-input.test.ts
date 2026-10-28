import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { checkBase64Image, checkBufferImage } from "../src/image-input.js";
import { startPortal } from "./helpers.js";

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(60)]);
const B64 = PNG.toString("base64");
const config = { businessName: "Kontakt", domain: "kontakt.az", profile: { mode: "support" }, source: { type: "rest" } };
const ORIGIN = "https://kontakt.az";

test("checkBase64Image / checkBufferImage: yalnız real şəkil və ölçü həddi", () => {
  assert.equal(checkBase64Image(B64), B64);
  assert.equal(checkBase64Image(`data:image/png;base64,${B64}`), B64);
  assert.equal(checkBase64Image(Buffer.from("<svg onload=alert(1)>aaaaaaaaaaaaaaaaaaaa").toString("base64")), null);
  assert.equal(checkBase64Image("!!!notbase64!!!!!!!!!!!!!!"), null);
  assert.equal(checkBase64Image(Buffer.alloc(2_100_000, 1).toString("base64")), null);
  assert.equal(checkBase64Image(123), null);
  assert.equal(checkBufferImage(PNG), B64);
  assert.equal(checkBufferImage(Buffer.from("zzzz")), null);
  assert.equal(checkBufferImage(null), null);
});

let p: Awaited<ReturnType<typeof startPortal>>;
before(async () => { p = await startPortal(); });
after(() => p.close());

const waitFor = async (cond: () => boolean, ms = 2000) => { const t0 = Date.now(); while (!cond() && Date.now() - t0 < ms) await new Promise((r) => setTimeout(r, 10)); return cond(); };
const chatCalls = () => p.ai.calls.filter((c) => c.fn === "chat");
let n = 0;
async function tenant() {
  const c = await p.signedIn(`img${++n}@example.com`);
  assert.equal((await c.call("POST", "/tenant", { config })).status, 201);
  const key = (await c.call("GET", "/tenant/widget")).body.widget.key as string;
  return { c, key };
}
const visitor = (key: string) => {
  const c = p.client();
  return {
    config: () => c.call("GET", `/widget/${key}/config`, undefined, { origin: ORIGIN }),
    chat: (body: unknown) => c.call("POST", `/widget/${key}/chat`, body, { origin: ORIGIN }),
  };
};

test("widget: şəkil default söndürülüdür; sahib açanda config-də görünür və şəkil AI-a ötürülür", async () => {
  const { c, key } = await tenant();
  const v = visitor(key);
  assert.equal((await v.config()).body.imageSearch, false);
  const off = await v.chat({ message: "bu nədir", image: B64 });
  assert.equal(off.status, 400); assert.equal(off.body.code, "IMAGE_OFF");
  assert.equal((await c.call("PATCH", "/tenant/profile", { imageSearch: true })).status, 200);
  assert.equal((await v.config()).body.imageSearch, true);
  const before = chatCalls().length;
  p.ai.nextChat = { answer: "Bunlar oxşardır", listings: [], imageNote: "qara çanta", usage: { tokens: 5 } };
  const ok = await v.chat({ message: "bunun kimi var?", image: B64 });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.equal(ok.body.imageNote, "qara çanta");
  const call = chatCalls().at(-1)!;
  assert.equal(chatCalls().length, before + 1);
  assert.equal((call.args[3] as { image?: string }).image, B64);
  // mətnsiz şəkil
  const bare = await v.chat({ image: B64 });
  assert.equal(bare.status, 200);
  assert.equal(chatCalls().at(-1)!.args[1], "");
  // saxta fayl
  const bad = await v.chat({ message: "x", image: Buffer.from("MZ-not-an-image-at-all-xxxxxxxx").toString("base64") });
  assert.equal(bad.status, 400); assert.equal(bad.body.code, "BAD_IMAGE");
  // mətnsiz və şəkilsiz hələ də xətadır
  assert.equal((await v.chat({})).status, 400);
});

test("widget: şəkil limiti (10 dəqiqədə 6) aşılanda 429", async () => {
  const { c, key } = await tenant();
  await c.call("PATCH", "/tenant/profile", { imageSearch: true });
  const v = visitor(key);
  const vid = "a".repeat(20);
  const codes: number[] = [];
  for (let i = 0; i < 8; i++) codes.push((await v.chat({ message: `s${i}`, image: B64, vid })).status);
  assert.equal(codes.filter((x) => x === 200).length, 6, codes.join());
  assert.ok(codes.slice(6).every((x) => x === 429));
});

test("Telegram: şəkilli mesaj (başlıq ilə) AI-a gedir; söndürülüdürsə və ya fayl alınmırsa mətn cavabı", async () => {
  const { c } = await tenant();
  const token = `900000${800 + n}:AAH${"z".repeat(32)}`;
  assert.equal((await c.call("PUT", "/tenant/channels/telegram", { token })).status, 200);
  const hook = p.telegram.hooks.get(token)!;
  const post = (id: number, message: object, chat = 91) => fetch(p.base + new URL(hook.url).pathname, { method: "POST", headers: { "content-type": "application/json", "x-telegram-bot-api-secret-token": hook.secret }, body: JSON.stringify({ update_id: id, message: { chat: { id: chat, type: "private" }, from: { first_name: "Ali", is_bot: false }, ...message } }) });
  const sent = () => p.telegram.sent.filter((m) => m.token === token);
  // söndürülü: başlıqsız şəkil → "qəbul edə bilmirəm"
  await post(7001, { photo: [{ file_id: "f1", file_size: 500, width: 90, height: 90 }] });
  assert.ok(await waitFor(() => sent().some((m) => m.text.includes("Şəkil qəbul edə bilmirəm"))));
  await c.call("PATCH", "/tenant/profile", { imageSearch: true });
  p.telegram.files.set("big", PNG);
  const before = chatCalls().length;
  p.ai.nextChat = { answer: "Oxşar olanlar bunlardır", listings: [], imageNote: "qırmızı çanta", usage: { tokens: 5 } };
  await post(7002, { caption: "bunun kimi?", photo: [{ file_id: "small", file_size: 300, width: 90, height: 90 }, { file_id: "big", file_size: 4000, width: 1280, height: 960 }, { file_id: "huge", file_size: 9_000_000, width: 4000, height: 3000 }] });
  assert.ok(await waitFor(() => chatCalls().length > before));
  const call = chatCalls().at(-1)!;
  assert.equal(call.args[1], "bunun kimi?");
  assert.equal((call.args[3] as { image?: string }).image, B64, "2MB-a sığan ən böyük ölçü seçilir");
  assert.ok(await waitFor(() => sent().some((m) => m.text.includes("Oxşar olanlar"))));
  // fayl endirilmədi
  await post(7003, { photo: [{ file_id: "missing", file_size: 100, width: 90, height: 90 }] }, 92); // başqa söhbət: xəbərdarlıq limiti söhbət üzrədir
  assert.ok(await waitFor(() => sent().some((m) => m.text.includes("Şəkli oxuya bilmədim"))));
});

test("WhatsApp: şəkilli mesaj AI-a gedir; söndürülüdürsə qısa cavab", async () => {
  const { c } = await tenant();
  assert.equal((await c.call("POST", "/tenant/channels/whatsapp/connect", { ack: true })).status, 200);
  const s = p.wa.last();
  s.user = { id: `99450888${String(1000 + n)}:7@s.whatsapp.net` };
  s.emit("connection.update", { qr: "2@x" });
  s.emit("connection.update", { connection: "open" });
  for (let i = 0; i < 100 && !(await c.call("GET", "/tenant/channels/whatsapp")).body.connected; i++) await new Promise((r) => setTimeout(r, 10));
  const inc = (id: string, message: object, who = "994559992222") => s.emit("messages.upsert", { type: "notify", messages: [{ key: { remoteJid: `${who}@s.whatsapp.net`, fromMe: false, id }, pushName: "Ali", messageTimestamp: Math.floor(Date.now() / 1000), message }] });
  inc("IM1", { imageMessage: { caption: "" } });
  assert.ok(await waitFor(() => s.sent.some((m) => m.text.includes("Şəkil qəbul edə bilmirəm"))));
  await c.call("PATCH", "/tenant/profile", { imageSearch: true });
  s.media = PNG;
  const before = chatCalls().length;
  p.ai.nextChat = { answer: "Tapdım", listings: [], imageNote: "mavi köynək", usage: { tokens: 5 } };
  inc("IM2", { imageMessage: { caption: "bundan var?" } });
  assert.ok(await waitFor(() => chatCalls().length > before));
  const call = chatCalls().at(-1)!;
  assert.equal(call.args[1], "bundan var?");
  assert.equal((call.args[3] as { image?: string }).image, B64);
  s.media = null;
  inc("IM3", { imageMessage: {} }, "994559993333");
  assert.ok(await waitFor(() => s.sent.some((m) => m.text.includes("Şəkli oxuya bilmədim"))));
});
