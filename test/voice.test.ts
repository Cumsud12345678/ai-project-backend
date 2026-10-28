import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { startPortal } from "./helpers.js";

const OGG = Buffer.concat([Buffer.from("OggS"), Buffer.alloc(200)]);
let p: Awaited<ReturnType<typeof startPortal>>;
before(async () => { p = await startPortal(); });
after(() => p.close());
const waitFor = async (cond: () => boolean, ms = 2000) => { const t0 = Date.now(); while (!cond() && Date.now() - t0 < ms) await new Promise((r) => setTimeout(r, 10)); return cond(); };

let phoneN = 0;
async function waTenant(email: string) {
  const c = await p.signedIn(email);
  assert.equal((await c.call("POST", "/tenant", { config: { businessName: "Kontakt", domain: "kontakt.az", profile: { mode: "support" }, source: { type: "rest" } } })).status, 201);
  assert.equal((await c.call("POST", "/tenant/channels/whatsapp/connect", { ack: true })).status, 200);
  const s = p.wa.last();
  s.user = { id: `99450777${String(1000 + ++phoneN)}:7@s.whatsapp.net` };
  s.emit("connection.update", { qr: "2@x" });
  s.emit("connection.update", { connection: "open" });
  for (let i = 0; i < 100 && !(await c.call("GET", "/tenant/channels/whatsapp")).body.connected; i++) await new Promise((r) => setTimeout(r, 10));
  return { c, s };
}
const voice = (s: any, id: string, jid: string, seconds?: number) => s.emit("messages.upsert", { type: "notify", messages: [{ key: { remoteJid: jid, fromMe: false, id }, pushName: "Ali", messageTimestamp: Math.floor(Date.now() / 1000), message: { audioMessage: { ptt: true, ...(seconds && { seconds }) } } }] });

test("WhatsApp: səsli mesaj mətnə çevrilir və adi sual kimi AI-a gedir", async () => {
  const { s } = await waTenant("voice1@example.com");
  s.media = OGG;
  p.ai.heard = "qara motosiklet axtarıram";
  p.ai.nextChat = { answer: "Bunlar var", listings: [], usage: { tokens: 5 } };
  voice(s, "V1", "994559990101@s.whatsapp.net", 7);
  assert.ok(await waitFor(() => p.ai.calls.some((x) => x.fn === "chat")));
  const tr = p.ai.calls.find((x) => x.fn === "transcribe")!;
  assert.equal(typeof tr.args[1], "string", "audio base64 göndərilir");
  assert.equal(p.ai.calls.find((x) => x.fn === "chat")!.args[1], "qara motosiklet axtarıram");
  assert.ok(await waitFor(() => s.sent.some((m) => m.text.includes("Bunlar var"))));
});

test("WhatsApp: çox uzun səs (>60 san) çevrilmir, istifadəçiyə qısa göndər deyilir; yüklənməyən səs də", async () => {
  const { s } = await waTenant("voice2@example.com");
  const before = p.ai.calls.filter((x) => x.fn === "transcribe").length;
  s.media = OGG;
  voice(s, "V2", "994559990202@s.whatsapp.net", 300);
  assert.ok(await waitFor(() => s.sent.some((m) => m.text.includes("çox uzundur"))));
  s.media = null;
  voice(s, "V3", "994559990303@s.whatsapp.net", 5);
  assert.ok(await waitFor(() => s.sent.some((m) => m.text.includes("eşidə bilmədim"))));
  assert.equal(p.ai.calls.filter((x) => x.fn === "transcribe").length, before, "AI-a getmədi");
});

test("WhatsApp: boş/anlaşılmaz səs → 'eşidə bilmədim', AI sualı getmir", async () => {
  const { s } = await waTenant("voice3@example.com");
  s.media = OGG; p.ai.heard = "";
  const chats = p.ai.calls.filter((x) => x.fn === "chat").length;
  voice(s, "V4", "994559990404@s.whatsapp.net", 4);
  assert.ok(await waitFor(() => s.sent.some((m) => m.text.includes("eşidə bilmədim"))));
  assert.equal(p.ai.calls.filter((x) => x.fn === "chat").length, chats);
  p.ai.heard = undefined;
});

test("Telegram: voice mesaj mətnə çevrilib cavablanır", async () => {
  const c = await p.signedIn("voice4@example.com");
  assert.equal((await c.call("POST", "/tenant", { config: { businessName: "Kontakt", domain: "kontakt.az", profile: { mode: "support" }, source: { type: "rest" } } })).status, 201);
  const token = `900000777:AAH${"y".repeat(32)}`;
  assert.equal((await c.call("PUT", "/tenant/channels/telegram", { token })).status, 200);
  const hook = p.telegram.hooks.get(token)!;
  p.telegram.files.set("voice-1", OGG);
  p.ai.heard = "salam necəsiniz";
  p.ai.nextChat = { answer: "Yaxşıyam", listings: [], usage: { tokens: 5 } };
  await fetch(p.base + new URL(hook.url).pathname, { method: "POST", headers: { "content-type": "application/json", "x-telegram-bot-api-secret-token": hook.secret }, body: JSON.stringify({ update_id: 7001, message: { chat: { id: 77, type: "private" }, from: { first_name: "Ali", is_bot: false }, voice: { file_id: "voice-1", file_size: OGG.length, duration: 3 } } }) });
  assert.ok(await waitFor(() => p.telegram.sent.some((m) => m.text.includes("Yaxşıyam"))));
  assert.equal(p.ai.calls.filter((x) => x.fn === "chat").at(-1)!.args[1], "salam necəsiniz");
  p.ai.heard = undefined;
});
