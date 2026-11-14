// Məhsullar üzrə analitika: maraq (AI göstərib), sifariş (məhsul sahəsi, kataloq adına yığılır), randevu (ləğv sayılmır), əvvəlki dövr.
import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { startPortal } from "./helpers.js";
import { productOf } from "../src/product-insights.js";

let p: Awaited<ReturnType<typeof startPortal>>;
before(async () => { p = await startPortal(); });
after(() => p.close());

test("məhsul sahəsi: açar və ya ad üzrə", () => {
  assert.equal(productOf([{ key: "name", label: "Ad", value: "Leyla" }, { key: "product", label: "Məhsul", value: "Qara çanta" }]), "Qara çanta");
  assert.equal(productOf([{ key: "f1", label: "Товар", value: "Сумка" }]), "Сумка");
  assert.equal(productOf([{ key: "address", label: "Ünvan", value: "Bakı" }]), null);
});

test("maraq, sifariş və randevu payları; əvvəlki dövr", async () => {
  const c = await p.signedIn("pi@example.com");
  assert.equal((await c.call("POST", "/tenant", { config: { businessName: "Çanta Evi", domain: "canta.az", profile: { mode: "support" }, source: { type: "rest" } } })).status, 201);
  p.ai.interest = { enabled: true, days: 30, conversations: 10, prevConversations: 8, items: [{ title: "Qara çanta", shown: 6, prevShown: 4, clicks: 2 }, { title: "Ağ krossovka", shown: 3, prevShown: 0, clicks: 0 }] };
  const now = Date.now(), d = (n: number) => new Date(now - n * 86_400_000).toISOString();
  const order = (at: string, v: string) => ({ id: `o-${Math.random()}`, at, contact: "050", order: { title: "Sifariş", stage: "new", fields: [{ key: "product", label: "Məhsul", value: v }] } });
  p.ai.leads = [
    order(d(1), "Qara çanta M ölçü"), order(d(2), "qara çanta x2"), order(d(3), "Ağ krossovka 38"), order(d(40), "Qara çanta"),
    { id: "b1", at: d(1), contact: "050", booking: { service: "Saç kəsimi", status: "booked" } },
    { id: "b2", at: d(2), contact: "050", booking: { service: "Saç kəsimi", status: "cancelled" } },
  ];
  const r = (await c.call("GET", "/tenant/insights/products?days=30")).body;
  assert.equal(r.interest.total, 10);
  assert.deepEqual(r.interest.items.map((x: { title: string; count: number }) => [x.title, x.count]), [["Qara çanta", 6], ["Ağ krossovka", 3]]);
  assert.equal(r.orders.total, 3);
  assert.equal(r.orders.prevTotal, 1);
  assert.deepEqual(r.orders.items.map((x: { title: string; count: number; prev: number }) => [x.title, x.count, x.prev]), [["Qara çanta", 2, 1], ["Ağ krossovka", 1, 0]], "kataloq adına yığılır");
  assert.deepEqual(r.bookings.items.map((x: { title: string; count: number }) => [x.title, x.count]), [["Saç kəsimi", 1]], "ləğv olunan sayılmır");
});
