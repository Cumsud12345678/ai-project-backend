// Kanal üzrə AI rejimi (qaralama / söndürülüb) və operator cavablarından öyrənmə:
// qaralama rejimində AI müştəriyə yazmır, söhbət canlı qutuya düşür, hər mesaja qaralama hazırlanır, operator göndərəndə silinir;
// söhbət bağlananda operator cavabları öyrənməyə gedir, "bot qayıtdı" mesajı getmir; təkliflərin təsdiqi/rəddi.
import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { startPortal } from "./helpers.js";

let p: Awaited<ReturnType<typeof startPortal>>;
before(async () => { p = await startPortal(); });
after(() => p.close());

const waitFor = async (cond: () => boolean | Promise<boolean>, ms = 2000) => { const t0 = Date.now(); while (!(await cond()) && Date.now() - t0 < ms) await new Promise((r) => setTimeout(r, 10)); return cond(); };
const calls = (fn: string) => p.ai.calls.filter((c) => c.fn === fn);
let n = 0, upd = 8000;
async function setup() {
  const c = await p.signedIn(`am${++n}@example.com`);
  assert.equal((await c.call("POST", "/tenant", { config: { businessName: "Mağaza", domain: "mg.az", profile: { mode: "support" }, source: { type: "rest" } } })).status, 201);
  const token = `95000${n}000:AAH${"m".repeat(32)}`;
  assert.equal((await c.call("PUT", "/tenant/channels/telegram", { token })).status, 200);
  const hook = p.telegram.hooks.get(token)!;
  const say = async (text: string) => { await fetch(p.base + new URL(hook.url).pathname, { method: "POST", headers: { "content-type": "application/json", "x-telegram-bot-api-secret-token": hook.secret }, body: JSON.stringify({ update_id: ++upd, message: { text, chat: { id: 888, type: "private" }, from: { first_name: "Orxan", is_bot: false } } }) }); };
  const toCustomer = () => p.telegram.sent.filter((s) => s.token === token && s.chatId === "888").map((s) => s.text);
  const openChat = async () => { let items: { id: string }[] = []; await waitFor(async () => { items = (await c.call("GET", "/tenant/live?status=open")).body.items; return items.length > 0; }); return items[0]?.id; };
  return { c, say, toCustomer, openChat };
}

test("ayar: defolt auto; yanlış dəyər 400", async () => {
  const { c } = await setup();
  assert.deepEqual((await c.call("GET", "/tenant/ai-mode")).body.aiMode, { telegram: "auto", whatsapp: "auto" });
  assert.equal((await c.call("PUT", "/tenant/ai-mode", { telegram: "manual" })).status, 400);
  assert.deepEqual((await c.call("PUT", "/tenant/ai-mode", { telegram: "draft" })).body.aiMode, { telegram: "draft", whatsapp: "auto" });
});

test("qaralama rejimi: AI müştəriyə yazmır, söhbət canlı qutuda qaralama ilə; operator göndərəndə qaralama silinir; bağlananda öyrənmə", async () => {
  const { c, say, toCustomer, openChat } = await setup();
  await c.call("PUT", "/tenant/ai-mode", { telegram: "draft" });
  const chats0 = calls("chat").length;
  p.ai.nextDraft = { draft: "Salam! Bəli, Gəncəyə 2 günə çatdırırıq." };
  await say("Gəncəyə çatdırılma var?");
  const id = (await openChat())!;
  assert.ok(id, "söhbət canlı qutuya düşür");
  assert.ok(await waitFor(async () => Boolean((await c.call("GET", `/tenant/live/${id}`)).body.chat.aiDraft)));
  const chat = (await c.call("GET", `/tenant/live/${id}`)).body.chat;
  assert.equal(chat.aiDraft.text, "Salam! Bəli, Gəncəyə 2 günə çatdırırıq.");
  assert.equal(chat.messages[0].text, "Gəncəyə çatdırılma var?");
  assert.equal(calls("chat").length, chats0, "AI cavab vermir");
  assert.equal(toCustomer().length, 0, "müştəriyə heç nə getmir (nə AI cavabı, nə 'operator qoşulur')");

  assert.equal((await c.call("POST", `/tenant/live/${id}/messages`, { text: "Salam! Bəli, Gəncəyə 2 günə çatdırırıq, 5 AZN." })).status, 201);
  assert.equal(toCustomer().at(-1), "Salam! Bəli, Gəncəyə 2 günə çatdırırıq, 5 AZN.");
  assert.equal((await c.call("GET", `/tenant/live/${id}`)).body.chat.aiDraft, undefined, "göndərəndən sonra qaralama silinir");

  // Müştərinin növbəti mesajı: yeni qaralama
  p.ai.nextDraft = { draft: "Kartla da ödəmək olar." };
  await say("Kartla ödəmək olar?");
  assert.ok(await waitFor(async () => (await c.call("GET", `/tenant/live/${id}`)).body.chat.aiDraft?.text === "Kartla da ödəmək olar."));

  const sent = toCustomer().length;
  assert.equal((await c.call("POST", `/tenant/live/${id}/close`)).status, 200);
  assert.ok(await waitFor(() => calls("kbLearn").length > 0), "operator cavabları öyrənməyə gedir");
  const learn = calls("kbLearn").at(-1)!.args[1] as { messages: { from: string; text: string }[]; chatId: string };
  assert.equal(learn.chatId, id);
  assert.ok(learn.messages.some((m) => m.from === "operator" && /5 AZN/.test(m.text)));
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(toCustomer().length, sent, "qaralama rejimində 'bot geri qayıtdı' mesajı getmir");
});

test("söndürülüb rejimi: qaralama hazırlanmır; avtomatik rejimdə AI adi qaydada cavab verir", async () => {
  const { c, say, toCustomer, openChat } = await setup();
  await c.call("PUT", "/tenant/ai-mode", { telegram: "off" });
  const drafts0 = calls("draft").length;
  await say("salam");
  const id = await openChat();
  assert.ok(id);
  await new Promise((r) => setTimeout(r, 80));
  assert.equal(calls("draft").length, drafts0);
  assert.equal(toCustomer().length, 0);

  const b = await setup();
  p.ai.nextChat = { answer: "Salam, necə kömək edim?", listings: [] };
  await b.say("salam");
  assert.ok(await waitFor(() => b.toCustomer().includes("Salam, necə kömək edim?")));
  void c;
});

test("təkliflər: siyahı, düzəldilmiş təsdiq, rədd", async () => {
  const { c } = await setup();
  assert.equal((await c.call("GET", "/tenant/kb/suggestions")).body.items[0].question, "Gəncəyə çatdırılma var?");
  const r = await c.call("POST", "/tenant/kb/suggestions/sug-00000001/accept", { questions: ["Gəncəyə çatdırılma var?", 5], answer: "Bəli, 2 günə, 5 AZN" });
  assert.equal(r.status, 201);
  assert.deepEqual(calls("kbAcceptSuggestion").at(-1)!.args.slice(1), ["sug-00000001", { questions: ["Gəncəyə çatdırılma var?"], answer: "Bəli, 2 günə, 5 AZN" }]);
  assert.equal((await c.call("DELETE", "/tenant/kb/suggestions/sug-00000001")).status, 200);
  assert.equal((await c.call("DELETE", "/tenant/kb/suggestions/x")).status, 400);
});
