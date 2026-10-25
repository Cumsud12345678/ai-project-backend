import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { startPortal } from "./helpers.js";

let p: Awaited<ReturnType<typeof startPortal>>;
before(async () => { p = await startPortal(); });
after(() => p.close());

const config = { businessName: "Motoelan", domain: "motoelan.com", source: { type: "rest" } };
const ORIGIN = "https://motoelan.com";
let n = 0;
async function tenant() {
  const c = await p.signedIn(`l${++n}@example.com`);
  assert.equal((await c.call("POST", "/tenant", { config })).status, 201);
  const key = (await c.call("GET", "/tenant/widget")).body.widget.key as string;
  return { c, key };
}
const visitor = () => { const b = p.client(); return (method: string, path: string, body?: unknown) => b.call(method, path, body, { origin: ORIGIN }); };

test("canlı söhbət defolt söndürülüb: config live=false, başlatmaq 404", async () => {
  const { key } = await tenant();
  const v = visitor();
  assert.equal((await v("GET", `/widget/${key}/config`)).body.live, false);
  const r = await v("POST", `/widget/${key}/live`, { message: "salam" });
  assert.equal(r.status, 404);
  assert.equal(r.body.code, "LIVE_OFF");
});

test("canlı söhbət: ziyarətçi yazır, operator cavab verir, ziyarətçi oxuyur, operator bağlayır", async () => {
  const { c, key } = await tenant();
  assert.equal((await c.call("PUT", "/tenant/widget", { live: { enabled: true } })).body.widget.live.enabled, true);
  const v = visitor();
  assert.equal((await v("GET", `/widget/${key}/config`)).body.live, true);

  const start = await v("POST", `/widget/${key}/live`, { message: "Operatorla danışım", name: "Elnur", contact: "+994501234567", chat: [{ role: "user", text: "salam" }, { role: "model", text: "Buyurun" }] });
  assert.equal(start.status, 201);
  const { id, token } = start.body as { id: string; token: string };
  assert.equal(start.body.messages.length, 1);

  assert.deepEqual((await c.call("GET", "/tenant/live/count")).body, { enabled: true, open: 1, waiting: 1 });
  const list = (await c.call("GET", "/tenant/live")).body.items;
  assert.equal(list.length, 1);
  assert.equal(list[0].waiting, true);
  assert.equal(list[0].last.text, "Operatorla danışım");

  const opened = await c.call("GET", `/tenant/live/${id}`);
  assert.equal(opened.body.chat.context.length, 2);
  assert.equal(opened.body.chat.contact, "+994501234567");
  assert.equal((await c.call("GET", "/tenant/live/count")).body.waiting, 0, "operator açdıqdan sonra gözləyən yoxdur");

  assert.equal((await c.call("POST", `/tenant/live/${id}/messages`, { text: "Salam, buyurun" })).status, 201);
  const sync = await v("POST", `/widget/${key}/live/${id}/sync`, { token, after: 1 });
  assert.equal(sync.status, 200);
  assert.deepEqual(sync.body.messages.map((m: { from: string; text: string }) => [m.from, m.text]), [["operator", "Salam, buyurun"]]);

  const sent = await v("POST", `/widget/${key}/live/${id}/sync`, { token, after: 2, text: "Qiyməti nədir?" });
  assert.equal(sent.body.messages[0].text, "Qiyməti nədir?");
  assert.equal((await c.call("GET", "/tenant/live/count")).body.waiting, 1, "ziyarətçi yenə yazdı: yenə gözləyir");

  assert.equal((await c.call("POST", `/tenant/live/${id}/close`)).status, 200);
  const closed = await v("POST", `/widget/${key}/live/${id}/sync`, { token, after: 3 });
  assert.equal(closed.body.status, "closed");
  assert.equal(closed.body.messages[0].from, "system");
  assert.equal((await v("POST", `/widget/${key}/live/${id}/sync`, { token, text: "salam" })).body.code, "LIVE_CLOSED");
  assert.equal((await c.call("POST", `/tenant/live/${id}/messages`, { text: "x" })).status, 409);
  assert.equal((await c.call("GET", "/tenant/live?status=closed")).body.items.length, 1);
});

test("canlı söhbət təhlükəsizliyi: yanlış token, başqa müştəri, başqa açar", async () => {
  const a = await tenant(), b = await tenant();
  for (const t of [a, b]) await t.c.call("PUT", "/tenant/widget", { live: { enabled: true } });
  const v = visitor();
  const { id, token } = (await v("POST", `/widget/${a.key}/live`, { message: "gizli mesaj" })).body;

  assert.equal((await v("POST", `/widget/${a.key}/live/${id}/sync`, { token: "x".repeat(48), after: 0 })).status, 404);
  assert.equal((await v("POST", `/widget/${a.key}/live/${id}/sync`, { after: 0 })).status, 404);
  // başqa müştərinin açarı ilə düzgün token belə işləmir
  assert.equal((await v("POST", `/widget/${b.key}/live/${id}/sync`, { token, after: 0 })).status, 404);
  // başqa müştərinin operatoru bu söhbəti görmür və cavab yaza bilmir
  assert.equal((await b.c.call("GET", `/tenant/live/${id}`)).status, 404);
  assert.equal((await b.c.call("POST", `/tenant/live/${id}/messages`, { text: "salam" })).status, 404);
  assert.equal((await b.c.call("POST", `/tenant/live/${id}/close`)).status, 404);
  assert.equal((await b.c.call("GET", "/tenant/live")).body.items.length, 0);
  // yad saytdan başlatmaq olmaz
  assert.equal((await p.client().call("POST", `/widget/${a.key}/live`, { message: "x" }, { origin: "https://evil.com" })).status, 403);
  // giriş olmadan operator marşrutları bağlıdır
  assert.equal((await p.client().call("GET", "/tenant/live")).status, 401);
});

test("canlı söhbət: pis telefon rədd edilir, uzun mesaj rədd edilir", async () => {
  const { c, key } = await tenant();
  await c.call("PUT", "/tenant/widget", { live: { enabled: true } });
  const v = visitor();
  assert.equal((await v("POST", `/widget/${key}/live`, { contact: "abc" })).body.code, "BAD_CONTACT");
  const { id, token } = (await v("POST", `/widget/${key}/live`, {})).body;
  assert.equal((await v("POST", `/widget/${key}/live/${id}/sync`, { token, text: "a".repeat(1001) })).status, 400);
  assert.equal((await c.call("PUT", "/tenant/widget", { live: { enabled: "bəli" } })).status, 400);
});

test("rəy: 👍/👎 sayılır; sorğu jurnalı söndürülübsə mətn saxlanmır", async () => {
  const { c, key } = await tenant();
  const v = visitor();
  assert.equal((await v("POST", `/widget/${key}/feedback`, { rating: 5 })).status, 400);
  assert.equal((await v("POST", `/widget/${key}/feedback`, { rating: 1, question: "q1", answer: "a1" })).status, 201);
  assert.equal((await v("POST", `/widget/${key}/feedback`, { rating: -1, question: "Qiymət?", answer: "Bilmirəm" })).status, 201);
  let fb = (await c.call("GET", "/tenant/feedback")).body;
  assert.equal(fb.up, 1);
  assert.equal(fb.down, 1);
  assert.equal(fb.bad[0].question, "Qiymət?");
  assert.equal((await c.call("GET", "/tenant/overview")).body.feedback.down, 1);

  await c.call("PATCH", "/tenant/profile", { logQueries: false });
  await v("POST", `/widget/${key}/feedback`, { rating: -1, question: "gizli sual", answer: "gizli cavab" });
  fb = (await c.call("GET", "/tenant/feedback")).body;
  assert.equal(fb.down, 2);
  assert.ok(!JSON.stringify(fb).includes("gizli"), "jurnal söndürülübsə sual/cavab mətni saxlanmır");
});
