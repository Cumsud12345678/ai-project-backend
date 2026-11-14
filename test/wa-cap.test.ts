// WhatsApp saatlıq tavanı: plana görə; dolanda bot susur və sahibə saatda bir dəfə xəbər gedir.
import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { startPortal } from "./helpers.js";
import { waCapOk, waHourlyCap } from "../src/whatsapp/cap.js";

let p: Awaited<ReturnType<typeof startPortal>>;
before(async () => { p = await startPortal(); });
after(() => { delete process.env.WA_HOURLY_CAP; p.close(); });

test("tavan plana görədir; WA_HOURLY_CAP hamısını üstələyir", async () => {
  assert.equal(await waHourlyCap(p.deps, "t-none"), 300);
  process.env.WA_HOURLY_CAP = "1000";
  assert.equal(await waHourlyCap(p.deps, "t-none"), 1000);
  delete process.env.WA_HOURLY_CAP;
});

test("dolanda false qaytarır və sahibə yalnız bir dəfə məktub gedir", async () => {
  const c = await p.signedIn("wacap@example.com");
  assert.equal((await c.call("POST", "/tenant", { config: { businessName: "Ətir Evi", domain: "etir.az", profile: { mode: "support" }, source: { type: "rest" } } })).status, 201);
  const u = (await p.store.findUserByEmail("wacap@example.com"))!;
  const t = (await p.store.findTenantByUser(u.id))!;
  process.env.WA_HOURLY_CAP = "2";
  const mails0 = p.mails.length;
  assert.equal(await waCapOk(p.deps, t), true);
  assert.equal(await waCapOk(p.deps, t), true);
  assert.equal(await waCapOk(p.deps, t), false);
  assert.equal(await waCapOk(p.deps, t), false);
  await new Promise((r) => setTimeout(r, 30));
  const sent = p.mails.slice(mails0).filter((m) => /WhatsApp saatlıq limiti doldu: Ətir Evi/.test(m.subject));
  assert.equal(sent.length, 1, "saatda bir dəfə");
  assert.equal(sent[0]!.to, "wacap@example.com");
});

test("WhatsApp tavanı dolanda: operator işləyirsə söhbət canlı qutuya düşür; açıq canlı yazışma tavana sayılmır", async () => {
  const { handleChat } = await import("../src/channel-chat.js");
  const c = await p.signedIn("wacap2@example.com");
  assert.equal((await c.call("POST", "/tenant", { config: { businessName: "Gül Evi", domain: "gul.az", profile: { mode: "support" }, source: { type: "rest" } } })).status, 201);
  assert.equal((await c.call("PUT", "/tenant/widget", { live: { enabled: true } })).status, 200);
  const t = (await p.store.findTenantByUser((await p.store.findUserByEmail("wacap2@example.com"))!.id))!;
  const sent: string[] = [];
  let capCalls = 0;
  const io = (text: string) => ({ channel: "whatsapp" as const, label: "WhatsApp", chatId: "994501112233", ref: "994501112233@s.whatsapp.net", phone: "994501112233", text, senderName: "Leyla",
    send: async (m: string) => { sent.push(m); }, typing: () => {}, capOk: async () => { capCalls++; return false; } });
  const chats0 = p.ai.calls.filter((x) => x.fn === "chat").length;
  await handleChat(p.deps, t, io("Salam, gül sifariş etmək istəyirəm"));
  assert.match(sent.at(-1)!, /Operatora qoşulursunuz/);
  assert.equal(p.ai.calls.filter((x) => x.fn === "chat").length, chats0, "AI çağırılmır");
  const live = (await c.call("GET", "/tenant/live?status=open")).body.items;
  assert.equal(live.length, 1);
  assert.equal(capCalls, 1);
  await handleChat(p.deps, t, io("Ünvan: Nizami küç."));
  assert.equal(capCalls, 1, "canlı yazışmada tavan yoxlanmır");
  assert.ok((await c.call("GET", `/tenant/live/${live[0].id}`)).body.chat.messages.some((m: { text: string }) => m.text === "Ünvan: Nizami küç."));
});
