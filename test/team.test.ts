import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { startPortal } from "./helpers.js";

let p: Awaited<ReturnType<typeof startPortal>>;
before(async () => { p = await startPortal(); });
after(() => p.close());

const waitFor = async (cond: () => boolean, ms = 2000) => { const t0 = Date.now(); while (!cond() && Date.now() - t0 < ms) await new Promise((r) => setTimeout(r, 10)); return cond(); };
let n = 0, upd = 5000;
async function setup() {
  const c = await p.signedIn(`own${++n}@example.com`);
  assert.equal((await c.call("POST", "/tenant", { config: { businessName: "Kontakt", domain: "kontakt.az", profile: { mode: "support" }, source: { type: "rest" } } })).status, 201);
  await c.call("PUT", "/tenant/widget", { live: { enabled: true } });
  const token = `92000${n}000:AAH${"z".repeat(32)}`;
  assert.equal((await c.call("PUT", "/tenant/channels/telegram", { token })).status, 200);
  const hook = p.telegram.hooks.get(token)!;
  const say = async (text: string, chat = 777) => {
    await fetch(p.base + new URL(hook.url).pathname, { method: "POST", headers: { "content-type": "application/json", "x-telegram-bot-api-secret-token": hook.secret }, body: JSON.stringify({ update_id: ++upd, message: { text, chat: { id: chat, type: "private" }, from: { first_name: "Ali", is_bot: false } } }) });
  };
  return { c, token, say, owner: `own${n}@example.com` };
}

test("komanda: dəvət, işçi qeydiyyatdan keçir, yalnız canlı söhbəti görür, öz hesab yarada bilmir", async () => {
  const { c, owner } = await setup();
  const email = `op${++n}@example.com`;
  assert.equal((await c.call("POST", "/tenant/team", { email })).status, 201);
  assert.ok(p.mails.some((m) => m.to === email && /operator/i.test(m.subject)));
  assert.deepEqual((await c.call("GET", "/tenant/team")).body.members.map((m: { email: string; joined: boolean }) => [m.email, m.joined]), [[email, false]]);
  assert.equal((await c.call("POST", "/tenant/team", { email })).status, 409);
  assert.equal((await c.call("POST", "/tenant/team", { email: owner })).status, 400);
  assert.equal((await c.call("POST", "/tenant/team", { email: "bad" })).status, 400);
  const op = await p.signedIn(email);
  const me = (await op.call("GET", "/tenant")).body;
  assert.equal(me.role, "operator"); assert.equal(me.tenant.businessName, "Kontakt"); assert.deepEqual(me.tenant.config, {});
  assert.equal((await c.call("GET", "/tenant/team")).body.members[0].joined, true);
  assert.equal((await op.call("GET", "/tenant/live/count")).status, 200);
  assert.equal((await op.call("GET", "/tenant/kb")).status, 404);
  assert.equal((await op.call("GET", "/tenant/team")).status, 404);
  assert.equal((await op.call("POST", "/tenant/live/ws-ticket")).status, 200);
  assert.equal((await op.call("POST", "/tenant", { config: { businessName: "X", domain: "x.az", profile: { mode: "support" } } })).status, 409);
  // çıxarılan işçinin girişi bağlanır
  assert.equal((await c.call("DELETE", `/tenant/team/${encodeURIComponent(email)}`)).status, 200);
  assert.equal((await op.call("GET", "/tenant/live/count")).status, 404);
});

test("komanda: qeydiyyatlı istifadəçi dərhal qoşulur; öz hesabı olan və ya başqa komandadakı rədd olunur; limit 5", async () => {
  const { c } = await setup();
  const reg = `reg${++n}@example.com`;
  await p.signedIn(reg);
  assert.equal((await c.call("POST", "/tenant/team", { email: reg })).status, 201);
  assert.equal((await c.call("GET", "/tenant/team")).body.members[0].joined, true);
  const other = await setup();
  assert.equal((await c.call("POST", "/tenant/team", { email: other.owner })).status, 409);
  assert.equal((await other.c.call("POST", "/tenant/team", { email: reg })).status, 409);
  for (let i = 0; i < 4; i++) assert.equal((await c.call("POST", "/tenant/team", { email: `m${n}${i}@example.com` })).status, 201);
  const full = await c.call("POST", "/tenant/team", { email: `m${n}x@example.com` });
  assert.equal(full.status, 400); assert.equal(full.body.code, "TEAM_FULL");
});

test("götürmək/buraxmaq: operator yazanda söhbət ona təyin olunur, mesajda kim yazıb görünür, komanda üzvü çıxarılanda söhbət azad olur; komandaya bildiriş gedir", async () => {
  const { c, say } = await setup();
  const email = `op${++n}@example.com`;
  await c.call("POST", "/tenant/team", { email });
  const op = await p.signedIn(email);
  await say("/operator");
  assert.ok(await waitFor(() => p.mails.some((m) => m.to === email && /Canlı söhbət/.test(m.subject))), "komanda üzvünə də bildiriş");
  const item = (await op.call("GET", "/tenant/live?status=open")).body.items[0];
  assert.equal(item.assignee, null);
  assert.equal((await op.call("POST", `/tenant/live/${item.id}/messages`, { text: "Salam, mən baxıram" })).status, 201);
  const after = (await c.call("GET", "/tenant/live?status=open")).body.items[0];
  assert.equal(after.assignee.name, email.split("@")[0]);
  const chat = (await c.call("GET", `/tenant/live/${item.id}`)).body.chat;
  assert.equal(chat.messages.at(-1).by, email.split("@")[0]);
  assert.equal(chat.assignee.name, email.split("@")[0]);
  // sahib götürür, sonra buraxır
  assert.equal((await c.call("POST", `/tenant/live/${item.id}/claim`)).status, 200);
  assert.ok((await c.call("GET", "/tenant/live?status=open")).body.items[0].assignee.name.startsWith("own"));
  assert.equal((await op.call("POST", `/tenant/live/${item.id}/claim`)).status, 200);
  assert.equal((await c.call("DELETE", `/tenant/team/${encodeURIComponent(email)}`)).status, 200);
  assert.equal((await c.call("GET", "/tenant/live?status=open")).body.items[0].assignee, null);
  assert.equal((await c.call("POST", `/tenant/live/${item.id}/release`)).status, 200);
});

test("operator özü başladır: yalnız botla yazışmış müştəriyə; mesaj kanala gedir, təkrar başlatma eyni söhbəti qaytarır; çatdırılmasa söhbət açılmır", async () => {
  const { c, token, say } = await setup();
  await say("salam, qiymət nədir?", 555);
  await waitFor(() => p.telegram.sent.some((s) => s.token === token));
  const contacts = (await c.call("GET", "/tenant/live/contacts")).body.items;
  assert.equal(contacts.length, 1);
  assert.deepEqual([contacts[0].channel, contacts[0].chatId, contacts[0].name], ["telegram", "555", "Ali"]);
  assert.match(contacts[0].last, /qiymət/);
  const unknown = await c.call("POST", "/tenant/live/start", { channel: "telegram", chatId: "999", text: "salam" });
  assert.equal(unknown.status, 404);
  p.telegram.failSend = true;
  const failed = await c.call("POST", "/tenant/live/start", { channel: "telegram", chatId: "555", text: "salam" });
  p.telegram.failSend = false;
  assert.equal(failed.status, 502);
  assert.equal((await c.call("GET", "/tenant/live?status=open")).body.items.length, 0);
  const sent0 = p.telegram.sent.length;
  const ok = await c.call("POST", "/tenant/live/start", { channel: "telegram", chatId: "555", text: "Salam, sizə kömək edə bilərəm?" });
  assert.equal(ok.status, 201, JSON.stringify(ok.body));
  assert.deepEqual([p.telegram.sent.length, p.telegram.sent.at(-1)!.chatId, p.telegram.sent.at(-1)!.text], [sent0 + 1, "555", "Salam, sizə kömək edə bilərəm?"]);
  const chat = (await c.call("GET", `/tenant/live/${ok.body.id}`)).body.chat;
  assert.equal(chat.messages[0].from, "operator"); assert.ok(chat.context.length >= 2); assert.equal(chat.channel, "telegram");
  const again = await c.call("POST", "/tenant/live/start", { channel: "telegram", chatId: "555", text: "yenə" });
  assert.deepEqual([again.status, again.body.id, again.body.existing], [200, ok.body.id, true]);
});
