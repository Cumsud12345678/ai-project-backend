// Yeni sifariş/randevu: paneldə qırmızı nişan (səhifə açılana qədər) və Telegram-ı bağlı sahibəyə bildiriş.
import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { startPortal } from "./helpers.js";
import { onOrder } from "../src/orders.js";
import { onBooking } from "../src/booking.js";
import { __setNotifyBot } from "../src/operator-notify.js";

let p: Awaited<ReturnType<typeof startPortal>>;
before(async () => { p = await startPortal({ notifyBotToken: "999:notify" }); __setNotifyBot("notify_bot"); });
after(() => p.close());

const att = (b: { attention: { kind: string; count: number }[] }, k: string) => b.attention.find((a) => a.kind === k)?.count ?? 0;

test("nişan: yeni sifariş və randevu sayılır, səhifə açılandan sonra sıfırlanır", async () => {
  const c = await p.signedIn("la1@example.com");
  assert.equal((await c.call("POST", "/tenant", { config: { businessName: "Dükan", domain: "dk.az", profile: { mode: "support" }, source: { type: "rest" } } })).status, 201);
  const now = new Date().toISOString();
  p.ai.leads = [
    { id: "order-0001", at: now, contact: "050", order: { title: "Sifariş", fields: [], stage: "new" } },
    { id: "order-0002", at: now, contact: "050", order: { title: "Sifariş", fields: [], stage: "confirmed" } },
    { id: "booking-0001", at: now, contact: "050", booking: { service: "Saç", date: "2030-01-01", time: "10:00", start: "2030-01-01T10:00:00Z", status: "booked" } },
  ];
  let o = (await c.call("GET", "/tenant/overview")).body;
  assert.equal(att(o, "orders"), 1);
  assert.equal(att(o, "bookings"), 1);
  assert.equal((await c.call("POST", "/tenant/seen", { kind: "orders" })).status, 200);
  assert.equal((await c.call("POST", "/tenant/seen", { kind: "x" })).status, 400);
  o = (await c.call("GET", "/tenant/overview")).body;
  assert.equal(att(o, "orders"), 0, "baxılandan sonra sıfır");
  assert.equal(att(o, "bookings"), 1);
  p.ai.leads = [...p.ai.leads, { id: "order-0003", at: new Date(Date.now() + 1000).toISOString(), contact: "050", order: { title: "Sifariş", fields: [], stage: "new" } }];
  assert.equal(att((await c.call("GET", "/tenant/overview")).body, "orders"), 1, "sonra gələn yenidən sayılır");
});

test("Telegram: bağlı sahibəyə yeni sifariş və randevu bildirişi", async () => {
  const c = await p.signedIn("la2@example.com");
  assert.equal((await c.call("POST", "/tenant", { config: { businessName: "Tort Evi", domain: "te.az", profile: { mode: "support" }, source: { type: "rest" } } })).status, 201);
  const u = (await p.store.findUserByEmail("la2@example.com"))!;
  await p.store.updateUser(u.id, { tgNotify: { chatId: "5551", name: "Sahib", at: new Date() } });
  const t = (await p.store.findTenantByUser(u.id))!;
  await onOrder(p.deps, t, { id: "ord-abcdef12", contact: "+994501112233", name: "Leyla", fields: [{ label: "Tort", value: "Şokoladlı" }] }, "Telegram");
  const toOwner = () => p.telegram.sent.filter((s) => s.chatId === "5551").map((s) => s.text);
  assert.match(toOwner().at(-1)!, /🛒 Yeni sifariş №ORD-ABCD \(Telegram\) · Tort Evi[\s\S]*Tort: Şokoladlı[\s\S]*\/orders$/);
  await onBooking(p.deps, t, { id: "bk-1", title: "Randevu", service: "Dad", date: "2030-02-02", time: "12:00", start: "2030-02-02T12:00:00Z", name: "Leyla", contact: "+994501112233" }, "sayt", null);
  assert.match(toOwner().at(-1)!, /📅 Yeni randevu \(sayt\) · Tort Evi\n\nDad · 2030-02-02 12:00[\s\S]*\/bookings$/);
});
