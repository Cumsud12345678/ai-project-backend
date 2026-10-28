import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { isBotCmd, isOperatorCmd, wantsHuman } from "../src/channel-live.js";
import { startPortal } from "./helpers.js";

let p: Awaited<ReturnType<typeof startPortal>>;
before(async () => { p = await startPortal(); });
after(() => p.close());

const waitFor = async (cond: () => boolean, ms = 2000) => { const t0 = Date.now(); while (!cond() && Date.now() - t0 < ms) await new Promise((r) => setTimeout(r, 10)); return cond(); };
const chatCalls = () => p.ai.calls.filter((c) => c.fn === "chat");
let n = 0, upd = 1000;
async function setup(live = true) {
  const c = await p.signedIn(`cl${++n}@example.com`);
  assert.equal((await c.call("POST", "/tenant", { config: { businessName: "Kontakt", domain: "kontakt.az", profile: { mode: "support" }, source: { type: "rest" } } })).status, 201);
  if (live) assert.equal((await c.call("PUT", "/tenant/widget", { live: { enabled: true } })).status, 200);
  const token = `91000${n}000:AAH${"y".repeat(32)}`;
  assert.equal((await c.call("PUT", "/tenant/channels/telegram", { token })).status, 200);
  const hook = p.telegram.hooks.get(token)!;
  const say = async (text: string, chat = 777) => {
    const r = await fetch(p.base + new URL(hook.url).pathname, { method: "POST", headers: { "content-type": "application/json", "x-telegram-bot-api-secret-token": hook.secret }, body: JSON.stringify({ update_id: ++upd, message: { text, chat: { id: chat, type: "private" }, from: { first_name: "Ali", is_bot: false } } }) });
    assert.equal(r.status, 200);
  };
  return { c, token, say };
}

test("komanda tanıma", () => {
  for (const t of ["/operator", "operator", "Operator", "/operator@my_bot", "оператор", "/insan"]) assert.ok(isOperatorCmd(t), t);
  for (const t of ["operatorla danışım", "salam", "/bot"]) assert.ok(!isOperatorCmd(t), t);
  assert.ok(isBotCmd("/bot") && isBotCmd("/ai") && !isBotCmd("bot"));
});

test("Telegram: /operator → canlı söhbət açılır, bot susur, operator cavabı gedir, bitirəndə bot qayıdır", async () => {
  const { c, token, say } = await setup();
  await say("/operator");
  assert.ok(await waitFor(() => p.telegram.sent.some((s) => s.token === token && /operator/i.test(s.text))));
  const list = (await c.call("GET", "/tenant/live?status=open")).body.items;
  assert.equal(list.length, 1);
  assert.equal(list[0].channel, "telegram");
  const id = list[0].id;
  const before = chatCalls().length;
  await say("Sifarişim gecikir");
  await waitFor(() => false, 100);
  assert.equal(chatCalls().length, before, "bot cavab verməməlidir");
  assert.ok((await c.call("GET", `/tenant/live/${id}`)).body.chat.messages.some((m: { text: string }) => m.text === "Sifarişim gecikir"));
  const sent0 = p.telegram.sent.length;
  const r = await c.call("POST", `/tenant/live/${id}/messages`, { text: "Salam, baxıram" });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(p.telegram.sent.length, sent0 + 1);
  assert.deepEqual([p.telegram.sent.at(-1)!.chatId, p.telegram.sent.at(-1)!.text], ["777", "Salam, baxıram"]);
  // başqa istifadəçi təsirlənmir
  await say("salam", 888);
  assert.ok(await waitFor(() => chatCalls().length === before + 1));
  // operator bitirir → bot qayıdır
  assert.equal((await c.call("POST", `/tenant/live/${id}/close`)).status, 200);
  assert.ok(await waitFor(() => /bitirdi/.test(p.telegram.sent.at(-1)!.text)));
  await say("təşəkkür");
  assert.ok(await waitFor(() => chatCalls().length === before + 2));
});

test("Telegram: müştəri /bot yazanda söhbət bağlanır; canlı söhbət söndürülübsə /operator bot cavabı ilə rədd olunur", async () => {
  const a = await setup();
  await a.say("/operator");
  assert.ok(await waitFor(() => p.telegram.sent.some((s) => s.token === a.token)));
  await a.say("/bot");
  assert.ok(await waitFor(() => /bitirdi/.test(p.telegram.sent.at(-1)!.text)));
  assert.equal((await a.c.call("GET", "/tenant/live?status=open")).body.items.length, 0);
  const b = await setup(false);
  await b.say("/operator");
  assert.ok(await waitFor(() => /aktiv deyil/.test(p.telegram.sent.at(-1)!.text)));
  assert.equal((await b.c.call("GET", "/tenant/live?status=open")).body.items.length, 0);
});

test("Telegram: göndərmə alınmasa operator mesajı yazılmır və 502 qayıdır", async () => {
  const { c, say } = await setup();
  await say("/operator");
  await waitFor(() => false, 100);
  const id = (await c.call("GET", "/tenant/live?status=open")).body.items[0].id;
  p.telegram.failSend = true;
  const r = await c.call("POST", `/tenant/live/${id}/messages`, { text: "salam" });
  p.telegram.failSend = false;
  assert.equal(r.status, 502);
  assert.equal((await c.call("GET", `/tenant/live/${id}`)).body.chat.messages.filter((m: { from: string }) => m.from === "operator").length, 0);
});

test("WhatsApp: /operator → canlı söhbət, operator cavabı nömrəyə gedir", async () => {
  const c = await p.signedIn(`clwa${++n}@example.com`);
  assert.equal((await c.call("POST", "/tenant", { config: { businessName: "Kontakt", domain: "kontakt.az", profile: { mode: "support" }, source: { type: "rest" } } })).status, 201);
  await c.call("PUT", "/tenant/widget", { live: { enabled: true } });
  assert.equal((await c.call("POST", "/tenant/channels/whatsapp/connect", { ack: true })).status, 200);
  const s = p.wa.last();
  s.user = { id: `99450${2000000 + n}:7@s.whatsapp.net` };
  s.emit("connection.update", { qr: "2@x" }); s.emit("connection.update", { connection: "open" });
  for (let i = 0; i < 100; i++) { if ((await c.call("GET", "/tenant/channels/whatsapp")).body.connected) break; await new Promise((r) => setTimeout(r, 10)); }
  const jid = "994558887766@s.whatsapp.net";
  const msg = (text: string, id: string) => s.emit("messages.upsert", { type: "notify", messages: [{ key: { remoteJid: jid, fromMe: false, id }, pushName: "Vüsal", messageTimestamp: Math.floor(Date.now() / 1000), message: { conversation: text } }] });
  msg("operator", `CL${n}A`);
  assert.ok(await waitFor(() => s.sent.some((x) => /Operatora qoşulursunuz/.test(x.text))));
  const item = (await c.call("GET", "/tenant/live?status=open")).body.items[0];
  assert.equal(item.channel, "whatsapp");
  const before = chatCalls().length;
  msg("Salam, kömək lazımdır", `CL${n}B`);
  await waitFor(() => false, 100);
  assert.equal(chatCalls().length, before);
  const r = await c.call("POST", `/tenant/live/${item.id}/messages`, { text: "Buyurun" });
  assert.equal(r.status, 201);
  assert.deepEqual([s.sent.at(-1)!.jid, s.sent.at(-1)!.text], [jid, "Buyurun"]);
  const chat = (await c.call("GET", `/tenant/live/${item.id}`)).body.chat;
  assert.ok(chat.messages.some((m: { from: string; text: string }) => m.from === "visitor" && /kömək/.test(m.text)));
  // operatorun öz göndərdiyi mesaj "sahib yazdı" sayılıb botu susdurmamalıdır
  s.emit("messages.upsert", { type: "notify", messages: [{ key: { remoteJid: jid, fromMe: true, id: s.sent.at(-1)!.id }, messageTimestamp: Math.floor(Date.now() / 1000), message: { conversation: "Buyurun" } }] });
  await c.call("POST", `/tenant/live/${item.id}/close`);
  msg("sağ olun", `CL${n}C`);
  assert.ok(await waitFor(() => chatCalls().length === before + 1));
});

test("wantsHuman: açıq insan istəyi tutulur, mobil operator və uzun/əlaqəsiz mətn tutulmur", () => {
  for (const t of ["operatora qoş məni", "insanla danışmaq istəyirəm", "menecerlə danışım", "I want to talk to a human", "хочу поговорить с оператором", "adminlə danışa bilərəm?"]) assert.ok(wantsHuman(t), t);
  for (const t of ["Azercell operator tarifləri", "salam", "çatdırılma neçə günə olur", "operator", "x".repeat(200) + " operatora qoş"]) assert.ok(!wantsHuman(t), t);
});

test("Telegram: AI handoff qərarı verəndə söhbət avtomatik operatora keçir (live:true göndərilir), sual operatora görünür", async () => {
  const { c, token, say } = await setup();
  p.ai.nextChat = { answer: "Operator tezliklə yazacaq.", listings: [], unanswered: true, handoff: true, usage: { tokens: 5 } };
  await say("sifarişimlə bağlı problem var, çox əsəbiyəm");
  assert.ok(await waitFor(() => p.telegram.sent.some((s) => s.token === token && /Operator tezliklə/.test(s.text))));
  const sentChat = chatCalls().at(-1)!;
  assert.equal((sentChat.args[3] as { live?: boolean }).live, true);
  assert.ok(!/telefon nömrənizi/.test(p.telegram.sent.at(-1)!.text), "əlaqə formu təklif olunmamalıdır");
  const items = (await c.call("GET", "/tenant/live?status=open")).body.items;
  assert.equal(items.length, 1);
  const chat = (await c.call("GET", `/tenant/live/${items[0].id}`)).body.chat;
  assert.equal(chat.messages[0].text, "sifarişimlə bağlı problem var, çox əsəbiyəm");
  assert.ok(chat.context.length >= 2);
  const n = chatCalls().length;
  await say("hələ də gözləyirəm");
  await waitFor(() => false, 100);
  assert.equal(chatCalls().length, n, "bot susmalıdır");
});

test("Telegram: 'insanla danışmaq istəyirəm' modelsiz (0 token) operatora keçir; canlı söhbət söndürülübsə adi sual kimi gedir", async () => {
  const a = await setup();
  const n = chatCalls().length;
  await a.say("insanla danışmaq istəyirəm");
  assert.ok(await waitFor(() => p.telegram.sent.some((s) => s.token === a.token && /Operatora qoşulursunuz/.test(s.text))));
  assert.equal(chatCalls().length, n);
  const b = await setup(false);
  await b.say("insanla danışmaq istəyirəm");
  assert.ok(await waitFor(() => chatCalls().length === n + 1));
  assert.equal((chatCalls().at(-1)!.args[3] as { live?: boolean }).live, undefined);
});
