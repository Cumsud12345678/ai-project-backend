import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { useStoreAuthState } from "../src/whatsapp/auth.js";
import { extractText } from "../src/whatsapp/manager.js";
import { createMemoryStore } from "../src/store/memory.js";
import { startPortal } from "./helpers.js";

let p: Awaited<ReturnType<typeof startPortal>>;
before(async () => { p = await startPortal(); });
after(() => p.close());

const config = { businessName: "Kontakt", domain: "kontakt.az", profile: { mode: "support" }, source: { type: "rest" } };
let n = 0, msgId = 0;
async function tenant() {
  const c = await p.signedIn(`wa${++n}@example.com`);
  assert.equal((await c.call("POST", "/tenant", { config })).status, 201);
  return c;
}
const waitFor = async (cond: () => boolean, ms = 1500) => { const t0 = Date.now(); while (!cond() && Date.now() - t0 < ms) await new Promise((r) => setTimeout(r, 10)); return cond(); };
const chatCalls = () => p.ai.calls.filter((c) => c.fn === "chat");
/** QR sorğusu → socket → "open": nömrə qoşulur */
async function connect(c: Awaited<ReturnType<typeof tenant>>, userId = `99450${String(1000000 + n)}:7@s.whatsapp.net`) {
  const r = await c.call("POST", "/tenant/channels/whatsapp/connect", { ack: true });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const s = p.wa.last();
  s.user = { id: userId };
  s.emit("connection.update", { qr: "2@fakeqrpayload" });
  await waitFor(() => false, 30);
  s.emit("connection.update", { connection: "open" });
  assert.ok(await waitFor(() => p.wa.manager.size() > 0));
  for (let i = 0; i < 100; i++) { const v = (await c.call("GET", "/tenant/channels/whatsapp")).body; if (v.connected) return s; await new Promise((r) => setTimeout(r, 10)); }
  throw new Error("qoşulmadı");
}
const incoming = (jid: string, text: string | null, o: { fromMe?: boolean; id?: string; ts?: number; media?: string } = {}) => ({
  messages: [{ key: { remoteJid: jid, fromMe: o.fromMe ?? false, id: o.id ?? `M${++msgId}` }, pushName: "Ali", messageTimestamp: o.ts ?? Math.floor(Date.now() / 1000), message: o.media ? { [o.media]: {} } : text === null ? { protocolMessage: {} } : { conversation: text } }],
  type: "notify",
});
const USER = "994559998877@s.whatsapp.net";

test("extractText: mətn, uzun mətn, media və texniki mesajlar", () => {
  assert.equal(extractText({ conversation: "salam" }), "salam");
  assert.equal(extractText({ extendedTextMessage: { text: "uzun" } }), "uzun");
  assert.equal(extractText({ ephemeralMessage: { message: { conversation: "gizli" } } }), "gizli");
  assert.equal(extractText({ imageMessage: {} }), "");
  assert.equal(extractText({ protocolMessage: {} }), undefined);
  assert.equal(extractText(null), undefined);
});

test("auth state: açarlar şifrəli saxlanır, geri oxunur, silinir", async () => {
  const store = createMemoryStore();
  const a = await useStoreAuthState(store, "t1", "k".repeat(32));
  await a.state.keys.set({ "pre-key": { "5": { private: Buffer.from("priv"), public: Buffer.from("pub") } } });
  await a.saveCreds();
  const raw = await store.getWaAuth("t1", ["pre-key-5", "creds"]);
  assert.ok(raw["pre-key-5"] && !raw["pre-key-5"].includes("priv") && raw["pre-key-5"].startsWith("v1."));
  const b = await useStoreAuthState(store, "t1", "k".repeat(32));
  assert.equal(b.state.creds.registrationId, a.state.creds.registrationId);
  const got = await b.state.keys.get("pre-key", ["5", "6"]);
  assert.equal(Buffer.from(got["5"]!.private).toString(), "priv"); assert.equal(got["6"], undefined);
  await b.state.keys.set({ "pre-key": { "5": null as never } });
  assert.deepEqual(Object.keys(await store.getWaAuth("t1", ["pre-key-5"])), []);
  await assert.rejects(useStoreAuthState(store, "t1", "z".repeat(32)));
});

test("panel: tenant yoxdur 404, təsdiq olmadan 400, status off", async () => {
  const c = await p.signedIn(`wa${++n}@example.com`);
  assert.equal((await c.call("GET", "/tenant/channels/whatsapp")).status, 404);
  const t = await tenant();
  const g = await t.call("GET", "/tenant/channels/whatsapp");
  assert.equal(g.body.state, "off"); assert.equal(g.body.connected, false); assert.equal(g.body.keyReady, true);
  const r = await t.call("POST", "/tenant/channels/whatsapp/connect", {});
  assert.equal(r.status, 400); assert.equal(r.body.code, "NEED_ACK");
  assert.equal((await t.call("PATCH", "/tenant/channels/whatsapp", { enabled: false })).status, 404);
});

test("qoşulma: QR görünür, açılandan sonra nömrə yazılır, sessiya şifrəli", async () => {
  const t = await tenant();
  const r = await t.call("POST", "/tenant/channels/whatsapp/connect", { ack: true });
  assert.equal(r.status, 200); assert.equal(r.body.state, "connecting"); assert.equal(r.body.qr, null);
  p.wa.last().emit("connection.update", { qr: "2@abc" });
  assert.ok(await waitFor(() => false, 50) === false);
  let v = (await t.call("GET", "/tenant/channels/whatsapp")).body;
  assert.equal(v.state, "qr"); assert.match(v.qr, /^data:image\/png;base64,/);
  p.wa.last().user = { id: `99450${7000000 + n}:3@s.whatsapp.net` };
  p.wa.last().emit("connection.update", { connection: "open" });
  for (let i = 0; i < 100 && !v.connected; i++) { await new Promise((r) => setTimeout(r, 10)); v = (await t.call("GET", "/tenant/channels/whatsapp")).body; }
  assert.equal(v.connected, true); assert.equal(v.state, "open"); assert.equal(v.phone, `99450${7000000 + n}`); assert.equal(v.qr, null); assert.equal(v.pauseOnOwnReply, true);
});

test("mesaj: AI cavabı göndərilir, qrup/status/köhnə/təkrar mesaj nəzərə alınmır", async () => {
  const c = await tenant(); const s = await connect(c);
  const before = chatCalls().length;
  s.emit("messages.upsert", incoming(USER, "Çatdırılma neçə günə olur?", { id: "DUP1" }));
  assert.ok(await waitFor(() => s.sent.length === 1));
  assert.ok(s.sent[0]!.id?.startsWith("3EB0")); assert.equal(s.sent[0]!.jid, USER); assert.ok(s.read >= 1); assert.ok(s.presence.includes("composing"));
  assert.equal(chatCalls().length, before + 1);
  s.emit("messages.upsert", incoming(USER, "Çatdırılma neçə günə olur?", { id: "DUP1" })); // təkrar
  s.emit("messages.upsert", incoming("120363@g.us", "qrup mesajı"));
  s.emit("messages.upsert", incoming("status@broadcast", "status"));
  s.emit("messages.upsert", incoming(USER, "köhnə", { ts: Math.floor(Date.now() / 1000) - 3600 }));
  s.emit("messages.upsert", incoming(USER, null)); // texniki mesaj
  await waitFor(() => false, 150);
  assert.equal(s.sent.length, 1); assert.equal(chatCalls().length, before + 1);
});

test("media mesajına 'yalnız yazı' deyilir; LID ünvanı da işləyir", async () => {
  const c = await tenant(); const s = await connect(c);
  s.emit("messages.upsert", incoming(USER, null, { media: "audioMessage" }));
  assert.ok(await waitFor(() => s.sent.length === 1)); assert.match(s.sent[0]!.text, /yalnız yazılı/);
  s.emit("messages.upsert", incoming("1234567890@lid", "salam"));
  assert.ok(await waitFor(() => s.sent.length === 2)); assert.equal(s.sent[1]!.jid, "1234567890@lid");
});

test("sahib telefondan yazanda bot həmin söhbətdə susur; botun öz mesajı susdurmur; söndürülmüş bot cavab vermir", async () => {
  const c = await tenant(); const s = await connect(c);
  s.emit("messages.upsert", incoming(USER, "salam"));
  assert.ok(await waitFor(() => s.sent.length === 1));
  s.emit("messages.upsert", incoming(USER, "bot öz mesajı", { fromMe: true, id: s.sent[0]!.id! })); // botun göndərdiyi: sayılmır
  s.emit("messages.upsert", incoming(USER, "növbəti sual"));
  assert.ok(await waitFor(() => s.sent.length === 2));
  s.emit("messages.upsert", incoming(USER, "Mən özüm cavab verirəm", { fromMe: true, id: "OWNER1" })); // sahibdir
  await waitFor(() => false, 50);
  s.emit("messages.upsert", incoming(USER, "yenə sual"));
  const other = "994551112233@s.whatsapp.net";
  s.emit("messages.upsert", incoming(other, "başqa müştəri"));
  assert.ok(await waitFor(() => s.sent.length === 3));
  await waitFor(() => false, 100);
  assert.equal(s.sent.length, 3); assert.equal(s.sent[2]!.jid, other);
  // pauseOnOwnReply söndürülsə sahibin yazması susdurmur
  const off = await c.call("PATCH", "/tenant/channels/whatsapp", { pauseOnOwnReply: false });
  assert.equal(off.body.pauseOnOwnReply, false);
  // enabled=false: heç kimə cavab yoxdur
  assert.equal((await c.call("PATCH", "/tenant/channels/whatsapp", { enabled: false })).body.enabled, false);
  s.emit("messages.upsert", incoming("994552223344@s.whatsapp.net", "salam"));
  await waitFor(() => false, 100);
  assert.equal(s.sent.length, 3);
});

test("cavab tapılmayanda kontakt istənir, nömrə yazılanda müraciət olur (WhatsApp)", async () => {
  const c = await tenant(); const s = await connect(c);
  p.ai.nextChat = { answer: "Bilmirəm", unanswered: true, listings: [] };
  s.emit("messages.upsert", incoming(USER, "qəribə sual"));
  assert.ok(await waitFor(() => s.sent.length === 1)); assert.match(s.sent[0]!.text, /operator sizinlə əlaqə saxlasın/);
  s.emit("messages.upsert", incoming(USER, "+994 50 123 45 67"));
  assert.ok(await waitFor(() => s.sent.length === 2)); assert.match(s.sent[1]!.text, /Təşəkkürlər/);
  assert.ok(p.ai.calls.some((x) => x.fn === "kbAddLead"));
  assert.ok(p.mails.some((m) => /WhatsApp/.test(m.subject)));
});

test("telefondan ayırma (401): sessiya və qeyd silinir; paneldən ayırma logout edir", async () => {
  const a = await tenant(); const sa = await connect(a);
  sa.emit("connection.update", { connection: "close", lastDisconnect: { error: { output: { statusCode: 401 } } } });
  for (let i = 0; i < 100; i++) { if (!(await a.call("GET", "/tenant/channels/whatsapp")).body.connected) break; await new Promise((r) => setTimeout(r, 10)); }
  const va = (await a.call("GET", "/tenant/channels/whatsapp")).body;
  assert.equal(va.connected, false); assert.equal(va.state, "off");
  const b = await tenant(); const sb = await connect(b);
  assert.equal((await b.call("DELETE", "/tenant/channels/whatsapp")).status, 200);
  assert.ok(sb.loggedOut && sb.ended);
  const vb = (await b.call("GET", "/tenant/channels/whatsapp")).body;
  assert.equal(vb.connected, false); assert.equal(vb.state, "off");
});

test("bağlantı qırılanda yenidən qoşulur; 515 yenidən başladır; 440 'replaced'", async () => {
  const c = await tenant(); const s = await connect(c);
  const count = () => p.wa.sockets.length;
  const n0 = count();
  s.emit("connection.update", { connection: "close", lastDisconnect: { error: { output: { statusCode: 428 } } } });
  assert.ok(await waitFor(() => count() === n0 + 1));
  assert.equal((await c.call("GET", "/tenant/channels/whatsapp")).body.state, "connecting");
  const s2 = p.wa.last();
  s2.emit("connection.update", { connection: "close", lastDisconnect: { error: { output: { statusCode: 515 } } } });
  assert.ok(await waitFor(() => count() === n0 + 2));
  p.wa.last().emit("connection.update", { connection: "close", lastDisconnect: { error: { output: { statusCode: 440 } } } });
  await waitFor(() => false, 50);
  const v = (await c.call("GET", "/tenant/channels/whatsapp")).body;
  assert.equal(v.state, "replaced"); assert.equal(v.connected, true);
});

test("eyni nömrə ikinci hesaba qoşula bilməz", async () => {
  const a = await tenant(); await connect(a, "994507770000:1@s.whatsapp.net");
  const b = await tenant();
  assert.equal((await b.call("POST", "/tenant/channels/whatsapp/connect", { ack: true })).status, 200);
  const s = p.wa.last(); s.user = { id: "994507770000:9@s.whatsapp.net" };
  s.emit("connection.update", { connection: "open" });
  await waitFor(() => s.loggedOut);
  const v = (await b.call("GET", "/tenant/channels/whatsapp")).body;
  assert.equal(v.connected, false); assert.equal(v.state, "error"); assert.match(v.error, /başqa hesaba/);
});

test("server yenidən açılanda qoşulmuş nömrələr bərpa olunur; açar yoxdursa qoşulma 503", async () => {
  const c = await tenant(); await connect(c);
  const n0 = p.wa.sockets.length;
  await p.wa.manager.shutdown();
  assert.equal(p.wa.manager.size(), 0);
  assert.equal((await c.call("GET", "/tenant/channels/whatsapp")).body.state, "off");
  const restored = await p.wa.manager.restoreAll(p.deps as never, 0); // testdəki bütün qoşulmuş tenantlar
  assert.ok(restored >= 1); assert.equal(p.wa.sockets.length, n0 + restored);
  assert.equal((await c.call("GET", "/tenant/channels/whatsapp")).body.state, "connecting");
  const q = await startPortal({ secretKey: "" });
  try {
    const t = await q.signedIn(`wa${++n}@example.com`);
    await t.call("POST", "/tenant", { config });
    const r = await t.call("POST", "/tenant/channels/whatsapp/connect", { ack: true });
    assert.equal(r.status, 503); assert.equal(r.body.code, "NO_SECRET_KEY");
  } finally { await q.close(); }
});
