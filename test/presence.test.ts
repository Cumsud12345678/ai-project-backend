import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { startPortal } from "./helpers.js";
import { __resetPresence } from "../src/presence.js";

let p: Awaited<ReturnType<typeof startPortal>>;
before(async () => { p = await startPortal(); __resetPresence(); });
after(() => p.close());

const config = { businessName: "Motoelan", domain: "motoelan.com", source: { type: "rest" } };
const ORIGIN = "https://motoelan.com";
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(300, 7)]);
let n = 0;
async function setup(live = true) {
  const c = await p.signedIn(`pr${++n}@example.com`);
  assert.equal((await c.call("POST", "/tenant", { config })).status, 201);
  const key = (await c.call("GET", "/tenant/widget")).body.widget.key as string;
  if (live) await c.call("PUT", "/tenant/widget", { live: { enabled: true } });
  const v = p.client();
  const visitor = (method: string, path: string, body?: unknown) => v.call(method, path, body, { origin: ORIGIN });
  return { c, key, visitor };
}
const VID = "a1b2c3d4e5f60718293a4b5c";

test("presence: ziyarətçi siyahıda görünür (brauzer ID-si yox, pid), səhifə sayı artır, referrer yalnız domen", async () => {
  const { c, key, visitor } = await setup();
  assert.equal((await p.client().call("GET", `/widget/${key}/config`, undefined, { origin: ORIGIN })).body.presence, true);
  assert.deepEqual((await visitor("POST", `/widget/${key}/presence`, { vid: VID, path: "/elan/5?utm=x", title: "Honda CBR", ref: "https://www.google.com/search?q=moto", lang: "az-AZ", mobile: true, chat: "ai" })).body, {});
  await visitor("POST", `/widget/${key}/presence`, { vid: VID, path: "/elan/6", title: "Yamaha", chat: "ai" });
  const list = (await c.call("GET", "/tenant/visitors")).body;
  assert.equal(list.enabled, true); assert.equal(list.items.length, 1);
  const v = list.items[0];
  assert.match(v.pid, /^[a-f0-9]{16}$/); assert.ok(!JSON.stringify(list).includes(VID), "brauzer ID-si panelə getmir");
  assert.equal(v.path, "/elan/6"); assert.equal(v.pages, 2); assert.equal(v.chat, "ai");
  assert.equal(v.ref, "www.google.com", "referrer: yalnız domen");
  assert.equal((await visitor("POST", `/widget/${key}/presence`, { vid: "yox" })).status, 400);
});

test("presence: canlı söhbət söndürülübsə heç nə saxlanmır; yad sayt 403", async () => {
  const { c, key, visitor } = await setup(false);
  await visitor("POST", `/widget/${key}/presence`, { vid: VID, path: "/" });
  assert.deepEqual((await c.call("GET", "/tenant/visitors")).body, { enabled: false, items: [] });
  assert.equal((await p.client().call("POST", `/widget/${key}/presence`, { vid: VID }, { origin: "https://evil.example" })).status, 403);
});

test("dəvət: operator ilk yazır -> ziyarətçi növbəti xəbərdə id+token alır (bir dəfə) -> sync ilə operatorun mesajını oxuyur", async () => {
  const { c, key, visitor } = await setup();
  await visitor("POST", `/widget/${key}/presence`, { vid: VID, path: "/elan/5", title: "Honda" });
  const pid = (await c.call("GET", "/tenant/visitors")).body.items[0].pid;
  assert.equal((await c.call("POST", `/tenant/visitors/${pid}/invite`, { text: "" })).status, 400);
  const inv = await c.call("POST", `/tenant/visitors/${pid}/invite`, { text: "Salam! Bu motosikletlə bağlı sualınız var?" });
  assert.equal(inv.status, 201, JSON.stringify(inv.body));
  assert.equal((await c.call("POST", `/tenant/visitors/${pid}/invite`, { text: "təkrar" })).body.code, "ALREADY_INVITED");
  assert.equal((await c.call("GET", "/tenant/visitors")).body.items[0].invited, true);

  const got = (await visitor("POST", `/widget/${key}/presence`, { vid: VID, path: "/elan/5" })).body;
  assert.equal(got.invite.id, inv.body.id);
  assert.deepEqual((await visitor("POST", `/widget/${key}/presence`, { vid: VID, path: "/elan/5" })).body, {}, "dəvət bir dəfə verilir");
  const sync = (await visitor("POST", `/widget/${key}/live/${got.invite.id}/sync`, { token: got.invite.token, after: 0 })).body;
  assert.equal(sync.messages[0].from, "operator"); assert.match(sync.messages[0].text, /Bu motosikletlə/);
  const chat = (await c.call("GET", `/tenant/live/${inv.body.id}`)).body.chat;
  assert.equal(chat.page.path, "/elan/5"); assert.ok(chat.assignee, "dəvət edən operator söhbəti götürür");

  // canlı söhbətdə olan ziyarətçiyə ikinci dəvət olmur; saytdan çıxmış ziyarətçi 404
  await visitor("POST", `/widget/${key}/presence`, { vid: VID, path: "/elan/5", chat: "live" });
  assert.equal((await c.call("POST", `/tenant/visitors/${pid}/invite`, { text: "x" })).body.code, "VISITOR_IN_LIVE");
  assert.equal((await c.call("POST", `/tenant/visitors/0123456789abcdef/invite`, { text: "x" })).body.code, "VISITOR_GONE");
});

test("canlı söhbətdə şəkil: ziyarətçi göndərir, operator baxır; yad hesab və səhv format rədd olunur", async () => {
  const { c, key, visitor } = await setup();
  const s = (await visitor("POST", `/widget/${key}/live`, { message: "Salam" })).body;
  assert.equal((await visitor("POST", `/widget/${key}/live/${s.id}/sync`, { token: s.token, after: 1, image: Buffer.from("<svg/>").toString("base64") })).body.code, "BAD_IMAGE");
  const r = await visitor("POST", `/widget/${key}/live/${s.id}/sync`, { token: s.token, after: 1, image: PNG.toString("base64") });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(r.body.messages[0], { from: "visitor", text: "📷", at: r.body.messages[0].at, file: true }, "ziyarətçiyə fayl ID-si getmir");
  const msg = (await c.call("GET", `/tenant/live/${s.id}`)).body.chat.messages[1];
  assert.match(msg.file.id, /^[0-9a-f-]{36}$/); assert.equal(msg.file.mime, "image/png");
  const res = await fetch(`${p.base}/tenant/live/${s.id}/files/${msg.file.id}`, { headers: { cookie: c.cookie, origin: "http://localhost:3001" } });
  assert.equal(res.status, 200); assert.equal(res.headers.get("content-type"), "image/png"); assert.match(res.headers.get("content-security-policy")!, /sandbox/);
  assert.deepEqual(Buffer.from(await res.arrayBuffer()), PNG);
  assert.equal((await fetch(`${p.base}/tenant/live/${s.id}/files/${msg.file.id}`)).status, 401, "giriş olmadan yox");
  const other = await setup();
  assert.equal((await fetch(`${p.base}/tenant/live/${s.id}/files/${msg.file.id}`, { headers: { cookie: other.c.cookie } })).status, 404, "başqa hesab görmür");
  assert.equal((await fetch(`${p.base}/tenant/live/başqa/files/${msg.file.id}`, { headers: { cookie: c.cookie } })).status, 404, "fayl yalnız öz söhbətində");
});
