// Operatorun ziyarətçiyə görünən profili (ad + şəkil) və köməkçinin AI nişanı:
// hər üzv öz profilini yazır, canlı söhbətdə ziyarətçi adı/şəkli görür, e-poçt və userId çıxmır, profil yoxdursa "Operator".
import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { startPortal } from "./helpers.js";

let p: Awaited<ReturnType<typeof startPortal>>;
before(async () => { p = await startPortal(); });
after(() => p.close());

const ORIGIN = "https://opprof.az";
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(32, 7)]).toString("base64");
let n = 0;
async function setup(agentName?: string) {
  const owner = `opp${++n}@example.com`;
  const c = await p.signedIn(owner);
  assert.equal((await c.call("POST", "/tenant", { config: { businessName: "Opp", domain: "opprof.az", profile: { mode: "support", ...(agentName && { agentName }) }, source: { type: "rest" } } })).status, 201);
  assert.equal((await c.call("PUT", "/tenant/widget", { live: { enabled: true } })).status, 200);
  const key = (await c.call("GET", "/tenant/widget")).body.widget.key as string;
  const v = p.client();
  const w = (method: string, path: string, body?: unknown) => v.call(method, `/widget/${key}${path}`, body, { origin: ORIGIN });
  return { c, owner, key, w };
}

test("profil: ad yoxlanır (boş, e-poçt, link olmaz), şəkil saxlanır və silinir", async () => {
  const { c } = await setup();
  assert.deepEqual((await c.call("GET", "/tenant/operator-profile")).body, { profile: null });
  for (const name of ["", "   ", "x".repeat(41), "leyla@firma.az", "https://x.az"]) assert.equal((await c.call("PUT", "/tenant/operator-profile", { name })).status, 400, name);
  assert.equal((await c.call("PUT", "/tenant/operator-profile", { name: "Leyla", photo: "bm90LWFuLWltYWdl" })).status, 400, "şəkil olmayan fayl");
  const r = await c.call("PUT", "/tenant/operator-profile", { name: "  Leyla  ", photo: PNG });
  assert.equal(r.status, 200);
  assert.equal(r.body.profile.name, "Leyla");
  assert.match(r.body.profile.photoUrl, /\/widget\/wk_[a-f0-9]{32}\/op\/[a-f0-9]{16}\?v=\d+$/);
  // Yalnız adı dəyişmək şəkli silmir; photo:null silir
  assert.ok((await c.call("PUT", "/tenant/operator-profile", { name: "Leyla M." })).body.profile.photoUrl);
  assert.equal((await c.call("PUT", "/tenant/operator-profile", { name: "Leyla M.", photo: null })).body.profile.photoUrl, null);
  assert.deepEqual((await c.call("DELETE", "/tenant/operator-profile")).body, { profile: null });
  assert.equal((await p.client().call("GET", "/tenant/operator-profile")).status, 401);
});

test("canlı söhbət: ziyarətçi operatorun adını və şəklini görür; e-poçt/userId çıxmır; profilsiz operator adsızdır", async () => {
  const { c, owner, w } = await setup();
  const opEmail = `leyla${n}@example.com`;
  assert.equal((await c.call("POST", "/tenant/team", { email: opEmail })).status, 201);
  const op = await p.signedIn(opEmail);
  assert.equal((await op.call("PUT", "/tenant/operator-profile", { name: "Leyla", photo: PNG })).status, 200, "işçi də öz profilini yazır");

  const s = await w("POST", "/live", { message: "salam" });
  assert.equal(s.status, 201);
  const { id, token } = s.body;
  assert.equal((await c.call("POST", `/tenant/live/${id}/messages`, { text: "Sahib yazır" })).status, 201); // sahibin profili yoxdur
  assert.equal((await op.call("POST", `/tenant/live/${id}/messages`, { text: "Salam, mən Leylayam" })).status, 201);
  const sync = await w("POST", `/live/${id}/sync`, { token, after: 0 });
  const [, fromOwner, fromOp] = sync.body.messages;
  assert.equal(fromOwner.op, undefined, "profil yoxdursa ad göstərilmir (e-poçtdan ad düzəldilmir)");
  assert.equal(fromOp.op.name, "Leyla");
  assert.match(fromOp.op.photo, /\/op\/[a-f0-9]{16}\?v=/);
  const raw = JSON.stringify(sync.body);
  assert.ok(!raw.includes(opEmail.split("@")[0]!) && !raw.includes(owner.split("@")[0]!), "e-poçt hissəsi çıxmır");
  const opUser = await p.store.findUserByEmail(opEmail);
  assert.ok(!raw.includes(opUser!.id), "userId çıxmır");

  // Şəkil ictimai ünvandan verilir
  const img = await fetch(fromOp.op.photo.replace(/^https?:\/\/[^/]+/, p.base));
  assert.equal(img.status, 200);
  assert.equal(img.headers.get("content-type"), "image/png");
  assert.equal(Buffer.from(await img.arrayBuffer()).toString("base64"), PNG);
  assert.equal((await fetch(fromOp.op.photo.replace(/^https?:\/\/[^/]+/, p.base).replace(/\/op\/[a-f0-9]{16}/, "/op/0000000000000000"))).status, 404);
});

test("vidjet konfiqurasiyası: köməkçinin adı varsa botName qayıdır", async () => {
  const a = await setup("Aysel");
  assert.equal((await a.w("GET", "/config")).body.botName, "Aysel");
  const b = await setup();
  assert.equal((await b.w("GET", "/config")).body.botName, undefined);
});

test("Telegram: profili olan operatorun mesajı adı ilə imzalanır, profilsizin mesajı olduğu kimi gedir", async () => {
  const { c } = await setup();
  const token = `93000${n}000:AAH${"q".repeat(32)}`;
  assert.equal((await c.call("PUT", "/tenant/channels/telegram", { token })).status, 200);
  const hook = p.telegram.hooks.get(token)!;
  await fetch(p.base + new URL(hook.url).pathname, { method: "POST", headers: { "content-type": "application/json", "x-telegram-bot-api-secret-token": hook.secret }, body: JSON.stringify({ update_id: 90000 + n, message: { text: "/operator", chat: { id: 321, type: "private" }, from: { first_name: "Ali", is_bot: false } } }) });
  let items: { id: string }[] = [];
  for (let i = 0; i < 50 && !items.length; i++) { items = (await c.call("GET", "/tenant/live?status=open")).body.items; if (!items.length) await new Promise((r) => setTimeout(r, 20)); }
  const id = items[0]!.id;
  assert.equal((await c.call("POST", `/tenant/live/${id}/messages`, { text: "Profilsiz" })).status, 201);
  assert.equal(p.telegram.sent.at(-1)!.text, "Profilsiz");
  await c.call("PUT", "/tenant/operator-profile", { name: "Leyla" });
  assert.equal((await c.call("POST", `/tenant/live/${id}/messages`, { text: "Salam, baxıram" })).status, 201);
  assert.equal(p.telegram.sent.at(-1)!.text, "Leyla:\nSalam, baxıram");
  const chat = (await c.call("GET", `/tenant/live/${id}`)).body.chat;
  assert.equal(chat.messages.at(-1).text, "Salam, baxıram", "paneldə mesaj imzasız saxlanır");
});
