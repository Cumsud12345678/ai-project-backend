// Əməliyyatlar (portal): konfiqurasiya marşrutları owner-only, vidjet təsdiqi təhlükəsiz, WhatsApp-da yalnız tam BƏLİ/XEYR.
import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { startPortal } from "./helpers.js";
import { cardText, parseDecision, publicConfirm } from "../src/action-card.js";

let p: Awaited<ReturnType<typeof startPortal>>;
before(async () => { p = await startPortal(); });
after(() => p.close());
const waitFor = async (cond: () => boolean, ms = 2000) => { const t0 = Date.now(); while (!cond() && Date.now() - t0 < ms) await new Promise((r) => setTimeout(r, 10)); return cond(); };
const ID = "a1".repeat(16);
const CARD = { id: ID, title: "Sifarişi ləğv et", summary: "Sifariş A-1 ləğv olunacaq", details: [{ k: "orderNo", v: "A-1" }], expiresInS: 600 };
const support = { businessName: "Magaza", domain: "magaza.az", email: "oz@example.com", profile: { language: "az", mode: "support" } };
let n = 0;
async function tenant() {
  const c = await p.signedIn(`act${++n}@example.com`);
  assert.equal((await c.call("POST", "/tenant", { config: support })).status, 201);
  const w = await c.call("GET", "/tenant/widget");
  return { c, key: w.body.widget.key as string };
}
const last = (fn: string) => p.ai.calls.filter((x) => x.fn === fn).at(-1)!;

test("parseDecision: yalnız TAM BƏLİ/XEYR sayılır", () => {
  for (const t of ["BƏLİ", "bəli", "Beli!", " yes ", "да", "təsdiq"]) assert.equal(parseDecision(t), "confirm", t);
  for (const t of ["XEYR", "yox", "Xeyr.", "no", "нет", "ləğv et"]) assert.equal(parseDecision(t), "cancel", t);
  for (const t of ["bəli amma əvvəl sual", "bəli, ləğv et", "yox bəli", "hə", "ok bəli", "", "bəlkə", "sifarişim bəli"]) assert.equal(parseDecision(t), null, t);
});

test("publicConfirm təmizləyir: id formatı, uzunluq, say; səhv format null", () => {
  assert.equal(publicConfirm(null), null); assert.equal(publicConfirm({ id: "x" }), null); assert.equal(publicConfirm({ id: "A".repeat(32) }), null);
  const c = publicConfirm({ ...CARD, title: "x".repeat(500), details: Array.from({ length: 20 }, (_, i) => ({ k: `k${i}`, v: "y".repeat(500) })), extra: "gizli" })!;
  assert.equal(c.title.length, 60); assert.equal(c.details.length, 8); assert.equal(c.details[0]?.v.length, 120); assert.ok(!("extra" in c));
  assert.match(cardText(c), /BƏLİ.*XEYR/s);
});

test("konfiqurasiya marşrutları giriş tələb edir və öz tenantId ilə AI-a gedir; imza açarı keşlənmir", async () => {
  for (const [m, path] of [["GET", "/tenant/actions"], ["PUT", "/tenant/actions"], ["DELETE", "/tenant/actions"], ["POST", "/tenant/actions/signing-secret"], ["POST", "/tenant/actions/test"], ["GET", "/tenant/actions/log"], ["DELETE", "/tenant/actions/log"]] as const)
    assert.equal((await p.client().call(m, path)).status, 401, `${m} ${path}`);
  const { c } = await tenant();
  assert.equal((await c.call("GET", "/tenant/actions")).status, 200);
  const put = await fetch(`${p.base}/tenant/actions`, { method: "PUT", headers: { cookie: c.cookie, origin: "http://localhost:3001", "content-type": "application/json" }, body: JSON.stringify({ baseUrl: "https://api.magaza.az", items: [] }) });
  assert.equal(put.status, 200); assert.equal(put.headers.get("cache-control"), "no-store");
  assert.equal((last("setActions").args[1] as any).baseUrl, "https://api.magaza.az");
  const sec = await fetch(`${p.base}/tenant/actions/signing-secret`, { method: "POST", headers: { cookie: c.cookie, origin: "http://localhost:3001" } });
  assert.equal(sec.status, 201); assert.equal(sec.headers.get("cache-control"), "no-store"); assert.equal((await sec.json() as any).signingSecret, "casig_new");
  assert.equal((await c.call("POST", "/tenant/actions/test", { key: 5 })).status, 400);
  assert.equal((await c.call("POST", "/tenant/actions/test", { key: "cancel_order", params: { orderNo: "1" }, send: true })).status, 200);
  assert.equal((last("testAction").args[1] as any).send, true);
});

test("real sınaq daha sərt limitlidir (10 / 10 dəq)", async () => {
  const { c } = await tenant();
  let blocked = 0;
  for (let i = 0; i < 12; i++) if ((await c.call("POST", "/tenant/actions/test", { key: "cancel_order", send: true })).status === 429) blocked++;
  assert.ok(blocked >= 2);
});

test("operator (komanda üzvü) əməliyyat ayarlarına çıxış edə bilmir", async () => {
  const { c } = await tenant();
  const email = `op-act${n}@example.com`;
  assert.equal((await c.call("POST", "/tenant/team", { email })).status, 201);
  const op = await p.signedIn(email);
  assert.notEqual((await op.call("GET", "/tenant/actions")).status, 200);
  assert.notEqual((await op.call("PUT", "/tenant/actions", { baseUrl: "https://x.az", items: [] })).status, 200);
});

test("vidjet: AI-ın təklifi təmizlənib qayıdır; kanal 'widget' ötürülür", async () => {
  const { key } = await tenant();
  p.ai.nextChat = { answer: "Kartı yoxlayın", listings: [], confirm: { ...CARD, secretField: "x" }, usage: { tokens: 5 } };
  const sid = "b2".repeat(12);
  const r = await p.client().call("POST", `/widget/${key}/chat`, { message: "ləğv et", sid }, { origin: "https://magaza.az" });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.confirm, { id: ID, title: "Sifarişi ləğv et", summary: "Sifariş A-1 ləğv olunacaq", details: [{ k: "orderNo", v: "A-1" }], expiresInS: 600 });
  assert.equal((last("chat").args[3] as any).channel, "widget");
  assert.equal((last("chat").args[3] as any).sid, sid);
});

test("vidjet təsdiqi: yalnız id/decision/sid/identity ötürülür, parametr ötürmək mümkün deyil; yanlış format rədd olunur", async () => {
  const { key } = await tenant();
  const send = (b: object, origin = "https://magaza.az") => p.client().call("POST", `/widget/${key}/action-confirm`, b, { origin });
  const sid = "c3".repeat(12);
  const ok = await send({ id: ID, decision: "confirm", sid, identity: "v1.eyJzdWIiOiJhbGkifQ.abc-_123", orderNo: "HACK", userId: "vuqar", params: { x: 1 } });
  assert.equal(ok.status, 200); assert.equal(ok.body.status, "done");
  assert.deepEqual(last("actionConfirm").args[1], { id: ID, decision: "confirm", sid, identity: "v1.eyJzdWIiOiJhbGkifQ.abc-_123" });
  for (const bad of [{ id: "x", decision: "confirm", sid }, { id: ID, decision: "yes", sid }, { id: ID, decision: "confirm", sid: "çox-qısa" }, { id: ID, decision: "confirm" }, { decision: "confirm", sid }])
    assert.equal((await send(bad)).status, 400, JSON.stringify(bad));
  assert.equal((await send({ id: ID, decision: "cancel", sid, identity: "pis-token" })).status, 200);
  assert.equal((last("actionConfirm").args[1] as any).identity, undefined, "səhv formatlı token ötürülmür");
  assert.equal((await send({ id: ID, decision: "confirm", sid }, "https://evil.com")).status, 403, "icazəsiz origin");
});

test("vidjet təsdiqi: AI servisi əlçatmazdırsa 'bəlli deyil'; digər xətada icra olunmayıb mesajı; limit", async () => {
  const { key } = await tenant();
  const { AiError } = await import("../src/ai.js");
  const visitor = p.client();
  const send = () => visitor.call("POST", `/widget/${key}/action-confirm`, { id: ID, decision: "confirm", sid: "d4".repeat(12) }, { origin: "https://magaza.az" });
  const orig = p.ai.actionConfirm;
  try {
    p.ai.actionConfirm = async () => { throw new AiError(502, "yox", "AI_UNREACHABLE"); };
    const a = await send(); assert.equal(a.status, 200); assert.equal(a.body.status, "unknown"); assert.match(a.body.message, /bəlli deyil/);
    p.ai.actionConfirm = async () => { throw new AiError(500, "daxili", "X"); };
    const b = await send(); assert.equal(b.status, 503); assert.match(b.body.error, /icra olunmayıb/);
    p.ai.actionConfirm = async () => ({ status: "hack", message: "x".repeat(2000) });
    const c = await send(); assert.equal(c.body.status, "failed"); assert.equal(c.body.message.length, 400, "naməlum status failed olur");
  } finally { p.ai.actionConfirm = orig; }
  let blocked = 0;
  const sts: number[] = [];
  for (let i = 0; i < 12; i++) { const r = await send(); sts.push(r.status); if (r.status === 429) blocked++; }
  assert.ok(blocked >= 1, sts.join());
});

// ---- WhatsApp: BƏLİ/XEYR ----
let phoneN = 0;
async function waTenant(email: string) {
  const c = await p.signedIn(email);
  assert.equal((await c.call("POST", "/tenant", { config: { businessName: "Kontakt", domain: "kontakt.az", profile: { mode: "support" }, source: { type: "rest" } } })).status, 201);
  assert.equal((await c.call("POST", "/tenant/channels/whatsapp/connect", { ack: true })).status, 200);
  const s = p.wa.last();
  s.user = { id: `99450888${String(1000 + ++phoneN)}:7@s.whatsapp.net` };
  s.emit("connection.update", { qr: "2@x" });
  s.emit("connection.update", { connection: "open" });
  for (let i = 0; i < 100 && !(await c.call("GET", "/tenant/channels/whatsapp")).body.connected; i++) await new Promise((r) => setTimeout(r, 10));
  return { c, s };
}
let mid = 0;
const say = (s: any, jid: string, text: string) => s.emit("messages.upsert", { type: "notify", messages: [{ key: { remoteJid: jid, fromMe: false, id: `A${++mid}` }, pushName: "Ali", messageTimestamp: Math.floor(Date.now() / 1000), message: { conversation: text } }] });

test("WhatsApp: təklif kart mətni kimi gəlir; 'bəli' yalnız təsdiq çağırır; AI-a yeni sual getmir", async () => {
  const { s } = await waTenant("wa-act1@example.com");
  const jid = "994558880101@s.whatsapp.net";
  p.ai.nextChat = { answer: "Kartı yoxlayın", listings: [], confirm: CARD, usage: { tokens: 5 } };
  say(s, jid, "sifarişi ləğv et");
  assert.ok(await waitFor(() => s.sent.some((m) => m.text.includes("BƏLİ"))));
  const msg = s.sent.find((m) => m.text.includes("BƏLİ"))!.text;
  assert.match(msg, /Sifariş A-1 ləğv olunacaq/); assert.match(msg, /orderNo: A-1/);
  assert.equal((last("chat").args[3] as any).channel, "whatsapp");
  const chats = p.ai.calls.filter((x) => x.fn === "chat").length;
  say(s, jid, "BƏLİ");
  assert.ok(await waitFor(() => s.sent.some((m) => m.text.includes("Əməliyyat icra olundu"))));
  const call = last("actionConfirm").args[1] as any;
  assert.equal(call.id, ID); assert.equal(call.decision, "confirm"); assert.equal(call.identity, undefined);
  assert.equal(p.ai.calls.filter((x) => x.fn === "chat").length, chats, "təsdiq AI-a sual kimi getmədi");
  // təkrar BƏLİ: artıq gözləyən kart yoxdur, adi mesaj kimi AI-a gedir
  const confirms = p.ai.calls.filter((x) => x.fn === "actionConfirm").length;
  say(s, jid, "BƏLİ");
  assert.ok(await waitFor(() => p.ai.calls.filter((x) => x.fn === "chat").length === chats + 1));
  assert.equal(p.ai.calls.filter((x) => x.fn === "actionConfirm").length, confirms, "ikinci təsdiq icra çağırmadı");
});

test("WhatsApp: XEYR ləğv edir; başqa mesaj kartı atır və sonradan 'bəli' icra etmir", async () => {
  const { s } = await waTenant("wa-act2@example.com");
  const jid = "994558880202@s.whatsapp.net";
  p.ai.nextChat = { answer: "Kart", listings: [], confirm: CARD, usage: { tokens: 5 } };
  say(s, jid, "ləğv et");
  assert.ok(await waitFor(() => s.sent.some((m) => m.text.includes("BƏLİ"))));
  p.ai.actionConfirm = async (...a: any[]) => { p.ai.calls.push({ fn: "actionConfirm", args: a }); return { status: "cancelled", message: "Əməliyyat ləğv olundu." }; };
  say(s, jid, "XEYR");
  assert.ok(await waitFor(() => s.sent.some((m) => m.text.includes("ləğv olundu"))));
  assert.equal((last("actionConfirm").args[1] as any).decision, "cancel");

  p.ai.nextChat = { answer: "Kart", listings: [], confirm: { ...CARD, id: "b2".repeat(16) }, usage: { tokens: 5 } };
  say(s, jid, "bir də ləğv et");
  assert.ok(await waitFor(() => s.sent.filter((m) => m.text.includes("BƏLİ")).length === 2));
  const confirms = p.ai.calls.filter((x) => x.fn === "actionConfirm").length;
  say(s, jid, "bəli amma əvvəl bir sual var");
  assert.ok(await waitFor(() => p.ai.calls.filter((x) => x.fn === "chat").length >= 3));
  say(s, jid, "bəli");
  await new Promise((r) => setTimeout(r, 150));
  assert.equal(p.ai.calls.filter((x) => x.fn === "actionConfirm").length, confirms, "kart atıldıqdan sonra 'bəli' icra çağırmır");
});

test("WhatsApp: AI əlçatmaz olanda 'bəlli deyil' deyilir və kart bağlanır (təkrar icra riski yoxdur)", async () => {
  const { s } = await waTenant("wa-act3@example.com");
  const jid = "994558880303@s.whatsapp.net";
  const { AiError } = await import("../src/ai.js");
  p.ai.nextChat = { answer: "Kart", listings: [], confirm: CARD, usage: { tokens: 5 } };
  say(s, jid, "ləğv et");
  assert.ok(await waitFor(() => s.sent.some((m) => m.text.includes("BƏLİ"))));
  const orig = p.ai.actionConfirm;
  p.ai.actionConfirm = async () => { throw new AiError(502, "yox", "AI_UNREACHABLE"); };
  try { say(s, jid, "bəli"); assert.ok(await waitFor(() => s.sent.some((m) => m.text.includes("bəlli deyil")))); }
  finally { p.ai.actionConfirm = orig; }
});
