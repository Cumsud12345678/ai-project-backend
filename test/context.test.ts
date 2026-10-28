// Operator konteksti (səhifə, əvvəlki söhbətlər) və nəticə hesabatı (kart klikləri, funnel).
import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { startPortal } from "./helpers.js";

let p: Awaited<ReturnType<typeof startPortal>>;
before(async () => { p = await startPortal(); });
after(() => p.close());
const support = { businessName: "Magaza", domain: "magaza.az", email: "oz@example.com", profile: { language: "az", mode: "support" } };
const ORIGIN = { origin: "https://magaza.az" };
let n = 0;
async function setup() {
  const c = await p.signedIn(`ctx${++n}@example.com`);
  assert.equal((await c.call("POST", "/tenant", { config: support })).status, 201);
  const key = (await c.call("GET", "/tenant/widget")).body.widget.key as string;
  assert.equal((await c.call("PUT", "/tenant/widget", { live: { enabled: true } })).status, 200);
  return { c, key };
}

test("canlı söhbət: səhifə yolu saxlanır, sorğu parametrləri və hash atılır", async () => {
  const { c, key } = await setup();
  const v = p.client();
  const r = await v.call("POST", `/widget/${key}/live`, { message: "Salam", contact: "ali@example.com", page: { path: "/products/5?utm=x&email=a@b.c#top", title: "  Kross   velosiped \n" } }, ORIGIN);
  assert.equal(r.status, 201);
  const chat = (await c.call("GET", `/tenant/live/${r.body.id}`)).body.chat;
  assert.deepEqual(chat.page, { path: "/products/5", title: "Kross velosiped" });
  assert.deepEqual(chat.previous, []);
});

test("canlı söhbət: yanlış səhifə dəyəri atılır (xəta vermir)", async () => {
  const { c, key } = await setup();
  for (const page of [{ path: "https://evil.example/x" }, { path: 5 }, "x", null, { path: "no-slash" }]) {
    const r = await p.client().call("POST", `/widget/${key}/live`, { message: "Salam", page }, ORIGIN);
    assert.equal(r.status, 201);
    assert.equal((await c.call("GET", `/tenant/live/${r.body.id}`)).body.chat.page, null);
  }
});

test("əvvəlki söhbətlər: eyni əlaqə ilə olanlar görünür, başqaları yox", async () => {
  const { c, key } = await setup();
  const mk = async (contact: string, msg: string) => (await p.client().call("POST", `/widget/${key}/live`, { message: msg, contact }, ORIGIN)).body.id as string;
  const a1 = await mk("ali@example.com", "Birinci sual");
  await c.call("POST", `/tenant/live/${a1}/close`);
  await mk("veli@example.com", "Başqa müştəri");
  const a2 = await mk("ali@example.com", "İkinci sual");
  const prev = (await c.call("GET", `/tenant/live/${a2}`)).body.chat.previous as { id: string; first: string }[];
  assert.equal(prev.length, 1);
  assert.equal(prev[0]!.id, a1);
  assert.equal(prev[0]!.first, "Birinci sual");
});

test("kart klikləri: say artır, funnel göstərir; başqa sayt origin-i qəbul olunmur", async () => {
  const { c, key } = await setup();
  for (let i = 0; i < 3; i++) assert.equal((await p.client().call("POST", `/widget/${key}/click`, undefined, ORIGIN)).status, 204);
  assert.equal((await p.client().call("POST", `/widget/${key}/click`, undefined, { origin: "https://evil.example" })).status, 403);
  const f = (await c.call("GET", "/tenant/funnel?days=30")).body;
  assert.equal(f.cardClicks, 3);
  assert.equal(typeof f.feedbackUp, "number");
  assert.equal(f.csatAvg, null);
  assert.equal(f.csatCount, 0);
});

test("funnel: orta qiymət bağlanmış söhbətlərin CSAT-ından hesablanır", async () => {
  const { c, key } = await setup();
  const rate = async (n: number) => {
    const v = p.client();
    const r = await v.call("POST", `/widget/${key}/live`, { message: "Salam" }, ORIGIN);
    await c.call("POST", `/tenant/live/${r.body.id}/close`);
    assert.equal((await v.call("POST", `/widget/${key}/live/${r.body.id}/csat`, { token: r.body.token, rating: n }, ORIGIN)).status, 201);
  };
  await rate(5); await rate(4);
  const f = (await c.call("GET", "/tenant/funnel?days=30")).body;
  assert.equal(f.csatCount, 2);
  assert.equal(f.csatAvg, 4.5);
});

test("əməliyyat statistikası portaldan keçir", async () => {
  const { c } = await setup();
  const r = await c.call("GET", "/tenant/actions/stats");
  assert.equal(r.status, 200);
});
