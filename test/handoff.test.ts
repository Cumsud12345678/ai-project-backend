// Ağıllı operator çağırışı: AI səbəblə ötürür (narazı / almağa hazır / kömək edə bilmir), ardıcıl 2 cavabsız sual,
// iş saatından kənar müraciət (yüksək prioritet), vidjetdə canlı söhbət + etiket, sahibin ayarları.
import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { startPortal } from "./helpers.js";
import { liveExtras, parseHandoff } from "../src/handoff.js";

let p: Awaited<ReturnType<typeof startPortal>>;
before(async () => { p = await startPortal(); });
after(() => p.close());

const ORIGIN = "https://hand.az";
const waitFor = async (cond: () => boolean, ms = 2000) => { const t0 = Date.now(); while (!cond() && Date.now() - t0 < ms) await new Promise((r) => setTimeout(r, 10)); return cond(); };
const calls = (fn: string) => p.ai.calls.filter((c) => c.fn === fn);
let n = 0, upd = 5000;
const closedHours = () => { const today = new Date().getDay(); return { tz: "Asia/Baku", days: Array(7).fill(null).map((_, i) => (i === (today + 3) % 7 ? { from: "09:00", to: "18:00" } : null)) }; };

async function setup({ live = true, hours }: { live?: boolean; hours?: unknown } = {}) {
  const c = await p.signedIn(`ho${++n}@example.com`);
  assert.equal((await c.call("POST", "/tenant", { config: { businessName: "Hand", domain: "hand.az", profile: { mode: "support" }, source: { type: "rest" } } })).status, 201);
  if (live) assert.equal((await c.call("PUT", "/tenant/widget", { live: { enabled: true, ...(hours ? { hours } : {}) } })).status, 200);
  const key = (await c.call("GET", "/tenant/widget")).body.widget.key as string;
  const token = `92000${n}000:AAH${"z".repeat(32)}`;
  assert.equal((await c.call("PUT", "/tenant/channels/telegram", { token })).status, 200);
  const hook = p.telegram.hooks.get(token)!;
  const say = async (text: string, chat = 555) => {
    const r = await fetch(p.base + new URL(hook.url).pathname, { method: "POST", headers: { "content-type": "application/json", "x-telegram-bot-api-secret-token": hook.secret }, body: JSON.stringify({ update_id: ++upd, message: { text, chat: { id: chat, type: "private" }, from: { first_name: "Ali", is_bot: false } } }) });
    assert.equal(r.status, 200);
  };
  const lastSent = () => p.telegram.sent.filter((s) => s.token === token).at(-1)?.text ?? "";
  const v = p.client();
  const w = (method: string, path: string, body?: unknown) => v.call(method, `/widget/${key}${path}`, body, { origin: ORIGIN });
  return { c, key, token, say, lastSent, w };
}

test("parseHandoff və liveExtras", () => {
  assert.deepEqual(parseHandoff({}), { cantHelp: true, upset: true, ready: true, misses: true });
  assert.deepEqual(parseHandoff({ upset: false, misses: false }), { cantHelp: true, upset: false, ready: true, misses: false });
  assert.throws(() => parseHandoff({ ready: "bəli" }), /true\/false/);
  const x = liveExtras("upset", "Pulunu istəyir");
  assert.deepEqual(x.tags, ["Narazı"]);
  assert.match(x.notes[0]!.text, /😠 Narazı müştəri: Pulunu istəyir/);
  assert.deepEqual(liveExtras("asked"), { tags: [], notes: [] });
});

test("ayarlar: GET defolt hamısı açıq, PUT yadda saxlanır və AI-a qaydalar gedir", async () => {
  const { c, say } = await setup();
  assert.deepEqual((await c.call("GET", "/tenant/handoff")).body.handoff, { cantHelp: true, upset: true, ready: true, misses: true });
  assert.equal((await c.call("PUT", "/tenant/handoff", { ready: 1 })).status, 400);
  const r = await c.call("PUT", "/tenant/handoff", { upset: false, ready: true, cantHelp: true, misses: false });
  assert.equal(r.status, 200);
  assert.deepEqual((await c.call("GET", "/tenant/handoff")).body.handoff, { cantHelp: true, upset: false, ready: true, misses: false });
  const before = calls("chat").length;
  await say("salam");
  assert.ok(await waitFor(() => calls("chat").length === before + 1));
  assert.deepEqual((calls("chat").at(-1)!.args[3] as { handoff: unknown }).handoff, { cantHelp: true, upset: false, ready: true });
  assert.equal((await p.client().call("GET", "/tenant/handoff")).status, 401);
});

test("Telegram: narazı müştəri → canlı söhbət 'Narazı' etiketi və AI qeydi ilə açılır", async () => {
  const { c, say } = await setup();
  p.ai.nextChat = { answer: "Üzr istəyirik, operator qoşulur.", listings: [], handoff: true, handoffReason: "upset", handoffNote: "Sifariş 3 gündür gecikir" };
  await say("Heç kim cavab vermir, pulumu qaytarın!");
  let items: { id: string; tags?: string[] }[] = [];
  assert.ok(await waitFor(() => false, 150) || true);
  for (let i = 0; i < 50 && !items.length; i++) { items = (await c.call("GET", "/tenant/live?status=open")).body.items; if (!items.length) await new Promise((r) => setTimeout(r, 20)); }
  assert.equal(items.length, 1);
  const chat = (await c.call("GET", `/tenant/live/${items[0]!.id}`)).body.chat;
  assert.deepEqual(chat.tags, ["Narazı"]);
  assert.match(chat.notes[0].text, /Narazı müştəri: Sifariş 3 gündür gecikir/);
});

test("Telegram: ardıcıl 2 cavabsız sual → operatora ötürülür; 'misses' söndürülübsə yox", async () => {
  const a = await setup();
  p.ai.nextChat = { answer: "Bilmirəm.", listings: [], unanswered: true };
  await a.say("sual 1");
  assert.ok(await waitFor(() => /Bilmirəm/.test(a.lastSent())));
  assert.equal((await a.c.call("GET", "/tenant/live?status=open")).body.items.length, 0, "birinci cavabsızda ötürülmür");
  p.ai.nextChat = { answer: "Yenə bilmirəm.", listings: [], unanswered: true };
  await a.say("sual 2"); // əlaqə yox, yeni sual: gözləyən əlaqə sorğusu bağlanır, sayğac davam edir
  assert.ok(await waitFor(() => /Yenə bilmirəm/.test(a.lastSent())));
  assert.match(a.lastSent(), /operator/i, "müştəriyə operatora qoşulduğu deyilir");
  let items: { id: string }[] = [];
  for (let i = 0; i < 50 && !items.length; i++) { items = (await a.c.call("GET", "/tenant/live?status=open")).body.items; if (!items.length) await new Promise((r) => setTimeout(r, 20)); }
  assert.equal(items.length, 1, "ardıcıl 2 cavabsızdan sonra canlı söhbət");
  assert.deepEqual((await a.c.call("GET", `/tenant/live/${items[0]!.id}`)).body.chat.tags, ["AI cavab tapmadı"]);

  const b = await setup();
  assert.equal((await b.c.call("PUT", "/tenant/handoff", { misses: false })).status, 200);
  for (const q of ["x1", "x2"]) {
    p.ai.nextChat = { answer: `Cavab yoxdur ${q}`, listings: [], unanswered: true };
    await b.say(q);
    assert.ok(await waitFor(() => b.lastSent().includes(`Cavab yoxdur ${q}`)));
  }
  assert.equal((await b.c.call("GET", "/tenant/live?status=open")).body.items.length, 0);
});

test("Telegram iş saatından kənar: almağa hazır müştəri → 'operator yazacaq', əlaqə alınır, müraciət YÜKSƏK prioritetlə", async () => {
  const { say, lastSent, c } = await setup({ hours: closedHours() });
  p.ai.nextChat = { answer: "Əla seçimdir!", listings: [], handoff: true, handoffReason: "ready_to_buy", handoffNote: "2 ədəd götürür" };
  await say("Götürürəm, necə ödəyim?");
  assert.ok(await waitFor(() => /telefon nömrənizi və ya e-poçtunuzu/.test(lastSent())), lastSent());
  assert.equal((await c.call("GET", "/tenant/live?status=open")).body.items.length, 0);
  const leads0 = calls("kbAddLead").length, upd0 = calls("kbUpdateLead").length;
  await say("+994501234567");
  assert.ok(await waitFor(() => calls("kbAddLead").length === leads0 + 1));
  const lead = calls("kbAddLead").at(-1)!.args[1] as { contact: string; question: string };
  assert.equal(lead.contact, "+994501234567");
  assert.match(lead.question, /🔥 Almağa hazırdır · 2 ədəd götürür — Götürürəm/);
  assert.ok(await waitFor(() => calls("kbUpdateLead").length === upd0 + 1));
  assert.deepEqual(calls("kbUpdateLead").at(-1)!.args.slice(1), ["lead-1", { priority: "high", by: "AI" }]);
});

test("vidjet: AI ötürmə qərarı + operator işləyir → handoff:'live' səbəbli; /live etiket və qeydlə açılır", async () => {
  const { c, w } = await setup();
  p.ai.nextChat = { answer: "Operator tezliklə yazacaq.", listings: [], handoff: true, handoffReason: "ready_to_buy", handoffNote: "Kartla ödəmək istəyir" };
  const r = await w("POST", "/chat", { message: "Kartla ödəyirəm" });
  assert.equal(r.status, 200);
  assert.equal(r.body.handoff, "live");
  assert.equal(r.body.handoffReason, "ready_to_buy");
  assert.equal(r.body.handoffNote, "Kartla ödəmək istəyir");
  const opts = calls("chat").at(-1)!.args[3] as { live: boolean; handoff: unknown };
  assert.equal(opts.live, true);
  assert.deepEqual(opts.handoff, { cantHelp: true, upset: true, ready: true });
  const s = await w("POST", "/live", { chat: [{ role: "user", text: "Kartla ödəyirəm" }], handoff: { reason: r.body.handoffReason, note: r.body.handoffNote } });
  assert.equal(s.status, 201);
  const chat = (await c.call("GET", `/tenant/live/${s.body.id}`)).body.chat;
  assert.deepEqual(chat.tags, ["Almağa hazır"]);
  assert.match(chat.notes[0].text, /🔥 Almağa hazırdır: Kartla ödəmək istəyir/);
});

test("vidjet iş saatından kənar: əlaqə forması səbəb ilə → müraciət etiketli və yüksək prioritetli", async () => {
  const { w } = await setup({ hours: closedHours() });
  p.ai.nextChat = { answer: "Operatora birbaşa qoşa bilmirəm, əlaqə qoyun.", listings: [], handoff: true, handoffReason: "upset" };
  const r = await w("POST", "/chat", { message: "Bu nə xidmətdir!" });
  assert.equal(r.body.handoff, undefined, "operator işləmir: canlı söhbət açılmır");
  assert.equal(r.body.unanswered, true, "əlaqə forması göstərilir");
  assert.equal(r.body.handoffReason, "upset");
  assert.equal((calls("chat").at(-1)!.args[3] as { live: boolean }).live, false);
  const upd0 = calls("kbUpdateLead").length;
  const lr = await w("POST", "/contact", { name: "Aynur", contact: "+994551234567", question: "Bu nə xidmətdir!", reason: "upset" });
  assert.equal(lr.status, 201);
  assert.match((calls("kbAddLead").at(-1)!.args[1] as { question: string }).question, /^😠 Narazı müştəri — Bu nə xidmətdir!/);
  assert.equal(calls("kbUpdateLead").length, upd0 + 1);
  // səbəbsiz adi müraciət: prioritet dəyişmir
  await w("POST", "/contact", { contact: "+994551234568", question: "sual" });
  assert.equal(calls("kbUpdateLead").length, upd0 + 1);
  assert.equal((calls("kbAddLead").at(-1)!.args[1] as { question: string }).question, "sual");
});
