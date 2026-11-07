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

test("AI söhbətini ələ almaq: sid presence-ə düşür, dəvət AI yazışmasını kontekst kimi götürür; operator şəkil və PDF göndərir", async () => {
  const { c, key, visitor } = await setup();
  const vid = "f0e1d2c3b4a5968778695a4b", sid = "aaaaaaaa11aaaaaa";
  await visitor("POST", `/widget/${key}/presence`, { vid, path: "/elan/9", chat: "ai", sid });
  let row = (await c.call("GET", "/tenant/visitors")).body.items.find((x: { sid?: string }) => x.sid === sid);
  assert.ok(row, "sid panelə gəlir");
  // ziyarətçi başqa vərəqə keçdi: siyahıda qalır, "gizli" işarəsi ilə
  await visitor("POST", `/widget/${key}/presence`, { vid, path: "/elan/9", chat: "ai", sid, hidden: true });
  row = (await c.call("GET", "/tenant/visitors")).body.items.find((x: { sid?: string }) => x.sid === sid);
  assert.equal(row.hidden, true);
  await visitor("POST", `/widget/${key}/presence`, { vid, path: "/elan/9", chat: "ai", sid });
  assert.equal((await c.call("GET", "/tenant/visitors")).body.items.find((x: { sid?: string }) => x.sid === sid).hidden, undefined);
  const inv = await c.call("POST", `/tenant/visitors/${row.pid}/invite`, { text: "Salam, mən operatoram." });
  assert.equal(inv.status, 201);
  const chat = (await c.call("GET", `/tenant/live/${inv.body.id}`)).body.chat;
  assert.deepEqual(chat.context, [{ role: "user", text: "salam" }, { role: "model", text: "Salam!" }]);
  const got = (await visitor("POST", `/widget/${key}/presence`, { vid, path: "/elan/9", chat: "ai", sid })).body.invite;

  // operator şəkil göndərir, ziyarətçi tokenlə yükləyir
  const up = await c.call("POST", `/tenant/live/${inv.body.id}/files`, { data: PNG.toString("base64"), name: "qiymet.png", text: "Qiymət cədvəli" });
  assert.equal(up.status, 201);
  const pdf = Buffer.concat([Buffer.from("%PDF-1.4\n"), Buffer.alloc(200, 32)]);
  assert.equal((await c.call("POST", `/tenant/live/${inv.body.id}/files`, { data: pdf.toString("base64"), name: "muqavile" })).status, 201);
  assert.equal((await c.call("POST", `/tenant/live/${inv.body.id}/files`, { data: Buffer.from("<html>").toString("base64"), name: "x.html" })).body.code, "BAD_FILE");
  const sync = (await visitor("POST", `/widget/${key}/live/${inv.body.id}/sync`, { token: got.token, after: 0 })).body;
  const files = sync.messages.filter((m: { file?: { id: string } }) => m.file && typeof m.file === "object");
  assert.equal(files.length, 2);
  assert.equal(files[1].file.name, "muqavile.pdf");
  assert.equal(files[1].text, "📄 muqavile.pdf");
  assert.equal((await visitor("POST", `/widget/${key}/live/${inv.body.id}/file`, { token: got.token, fid: files[0].file.id })).status, 200);
  assert.equal((await visitor("POST", `/widget/${key}/live/${inv.body.id}/file`, { token: "yanlis", fid: files[0].file.id })).status, 404);
  // imzasız/yanlış imzalı ictimai link işləmir
  assert.equal((await p.client().call("GET", `/widget/f/x/${files[0].file.id}?e=9999999999&s=abc`)).status, 404);
});

test("bloklama, ziyarətçi məlumatı, müştəri kartı və elan klikinin söhbətə bağlanması", async () => {
  const { c, key, visitor } = await setup();
  const vid = "0a1b2c3d4e5f60718293a4b5", sid = "cccccccc33cccccc";
  // canlı söhbət: ziyarətçi məlumatı (saat qurşağı, ilk ziyarət, ziyarət sayı)
  const first = Date.now() - 3 * 86_400_000;
  const live = await visitor("POST", `/widget/${key}/live`, { message: "salam", vid, tz: "Asia/Baku", first, visits: 4, lang: "az", mobile: true, contact: "+994 50 123 45 67" });
  assert.equal(live.status, 201);
  const chat = (await c.call("GET", `/tenant/live/${live.body.id}`)).body.chat;
  assert.deepEqual({ tz: chat.visitor.tz, visits: chat.visitor.visits, mobile: chat.visitor.mobile, pid: chat.visitor.pid }, { tz: "Asia/Baku", visits: 4, mobile: true, pid: undefined });
  assert.equal(chat.blocked, false);
  // müştəri kartı: söhbət + eyni telefonla gələn müraciət birləşir (fake AI-dan müraciət gəlmir: yalnız söhbət)
  const cust = (await c.call("GET", "/tenant/customers")).body.items;
  assert.equal(cust[0].chats[0].id, live.body.id);
  assert.deepEqual(cust[0].contacts, ["+994 50 123 45 67"]);
  // blokla: söhbət bağlanır, ziyarətçi çata və canlı söhbətə yaza bilmir
  assert.equal((await c.call("POST", `/tenant/live/${live.body.id}/block`)).status, 200);
  assert.equal((await c.call("GET", "/tenant/blocks")).body.items.length, 1);
  assert.equal((await visitor("POST", `/widget/${key}/chat`, { message: "yenə", vid })).body.code, "BLOCKED");
  assert.equal((await visitor("POST", `/widget/${key}/live`, { message: "yenə", vid })).body.code, "BLOCKED");
  assert.deepEqual((await visitor("POST", `/widget/${key}/presence`, { vid, path: "/" })).body, {});
  assert.equal((await c.call("GET", "/tenant/customers")).body.items[0].blocked, true);
  const k = (await c.call("GET", "/tenant/blocks")).body.items[0].key;
  assert.equal((await c.call("DELETE", `/tenant/blocks/${encodeURIComponent(k)}`)).status, 200);
  assert.notEqual((await visitor("POST", `/widget/${key}/chat`, { message: "indi", vid })).body.code, "BLOCKED");
  // elan kliki AI söhbətinə bağlanır
  p.ai.calls.length = 0;
  assert.equal((await visitor("POST", `/widget/${key}/click`, { sid, id: 77, title: "Honda" })).status, 204);
  await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual(p.ai.calls.find((x: { fn: string }) => x.fn === "recordClick")?.args.slice(1), [sid, { id: "77", title: "Honda" }]);
});
