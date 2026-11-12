// Randevu və sifariş lövhəsi (portal): kanal ünvanı AI-a gedir, randevuya xatırlatma planlanır və vaxtında göndərilir,
// ləğvdə xatırlatma silinir və müştəriyə mesaj gedir, sifariş mərhələsi dəyişəndə müştəriyə Telegram/e-poçt mesajı.
import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { startPortal } from "./helpers.js";
import { reminderAt, runReminders } from "../src/booking.js";
import { orderStageText, bookingText } from "../src/customer-notify.js";

let p: Awaited<ReturnType<typeof startPortal>>;
before(async () => { p = await startPortal(); });
after(() => p.close());

const waitFor = async (cond: () => boolean | Promise<boolean>, ms = 2000) => { const t0 = Date.now(); while (!(await cond()) && Date.now() - t0 < ms) await new Promise((r) => setTimeout(r, 10)); return cond(); };
const calls = (fn: string) => p.ai.calls.filter((c) => c.fn === fn);
let n = 0, upd = 7000;
async function setup() {
  const c = await p.signedIn(`bo${++n}@example.com`);
  assert.equal((await c.call("POST", "/tenant", { config: { businessName: "Salon", domain: "salon.az", profile: { mode: "support" }, source: { type: "rest" } } })).status, 201);
  const token = `94000${n}000:AAH${"b".repeat(32)}`;
  assert.equal((await c.call("PUT", "/tenant/channels/telegram", { token })).status, 200);
  const hook = p.telegram.hooks.get(token)!;
  const say = async (text: string, chat = 777) => {
    await fetch(p.base + new URL(hook.url).pathname, { method: "POST", headers: { "content-type": "application/json", "x-telegram-bot-api-secret-token": hook.secret }, body: JSON.stringify({ update_id: ++upd, message: { text, chat: { id: chat, type: "private" }, from: { first_name: "Aysel", is_bot: false } } }) });
  };
  const toCustomer = (chat = "777") => p.telegram.sent.filter((s) => s.token === token && s.chatId === chat).map((s) => s.text);
  const tenantId = (await p.store.findTenantByUser((await p.store.findUserByEmail(`bo${n}@example.com`))!.id))!.tenantId;
  return { c, say, toCustomer, tenantId };
}

test("xatırlatma vaxtı: 24 saat əvvəl, yaxın randevuda 2 saat əvvəl, çox yaxında yox", () => {
  const now = Date.parse("2030-01-01T00:00:00Z");
  assert.equal(reminderAt(now + 48 * 3_600_000, now), now + 24 * 3_600_000);
  assert.equal(reminderAt(now + 10 * 3_600_000, now), now + 8 * 3_600_000);
  assert.equal(reminderAt(now + 2 * 3_600_000, now), null);
  assert.match(bookingText("reminder", { date: "2030-01-05", time: "14:30", service: "Saç" }, "Salon", "az"), /^Salon: ⏰ Xatırlatma: 05\.01\.2030 saat 14:30/);
  assert.match(orderStageText("shipped", "abcdef1234", "Tort Evi", "ru")!, /Ваш заказ №ABCDEF12 отправлен/);
  assert.equal(orderStageText("new", "x", "B"), null);
});

test("Telegram randevusu: kanal ünvanı AI-a gedir, xatırlatma planlanır və vaxtı çatanda göndərilir", async () => {
  const { say, toCustomer, tenantId } = await setup();
  const start = new Date(Date.now() + 30 * 3_600_000).toISOString();
  p.ai.nextChat = { answer: "Randevunuz qeydə alındı!", listings: [], booking: { id: "bk-1", title: "Randevu", service: "Saç kəsimi", date: start.slice(0, 10), time: "14:00", start, name: "Aysel", contact: "+994501234567", reminders: true } };
  await say("Bəli, təsdiq edirəm");
  assert.ok(await waitFor(() => toCustomer().includes("Randevunuz qeydə alındı!")));
  const reach = (calls("chat").at(-1)!.args[3] as { reach: Record<string, unknown> }).reach;
  assert.equal(reach.type, "telegram");
  assert.equal(reach.chatId, "777");
  let due: unknown[] = [];
  assert.ok(await waitFor(async () => { due = await p.store.dueReminders(new Date(Date.now() + 7 * 3_600_000), 10); return due.length === 1; }), "24 saat əvvələ xatırlatma");
  assert.equal((await p.store.dueReminders(new Date(), 10)).length, 0, "hələ vaxtı deyil");
  assert.ok(p.mails.some((m) => /Yeni randevu: Saç kəsimi/.test(m.subject)), "sahibə e-poçt");
  // Vaxt çatdı
  const sent = await runReminders(p.deps, Date.now() + 7 * 3_600_000);
  assert.equal(sent, 1);
  assert.match(toCustomer().at(-1)!, /^Salon: ⏰ Xatırlatma: .* saat 14:00 sizi gözləyirik \(Saç kəsimi\)/);
  assert.equal((await p.store.dueReminders(new Date(Date.now() + 48 * 3_600_000), 10)).filter((r) => r.tenantId === tenantId).length, 0, "bir dəfə göndərilir");
});

test("panel: randevu ləğvi xatırlatmanı silir və müştəriyə mesaj göndərir; siyahıda kanal ünvanı görünmür", async () => {
  const { c, toCustomer, tenantId } = await setup();
  const start = new Date(Date.now() + 50 * 3_600_000).toISOString();
  const reach = { type: "telegram", chatId: "777", lang: "az" };
  const { scheduleBookingReminder } = await import("../src/booking.js");
  const t = (await p.store.findTenantById(tenantId))!;
  await scheduleBookingReminder(p.deps, t, { id: "booking-0002", date: start.slice(0, 10), time: "11:00", service: "Manikür", start }, reach as never);
  assert.equal((await p.store.dueReminders(new Date(Date.now() + 49 * 3_600_000), 50)).filter((r) => r.ref === "booking-0002").length, 1);

  p.ai.leads = [{ id: "booking-0002", name: "Aysel", contact: "+994501234567", booking: { service: "Manikür", date: start.slice(0, 10), time: "11:00", start, status: "booked", reach } }];
  const list = await c.call("GET", "/tenant/bookings");
  assert.equal(list.body.items[0].booking.notify, "channel");
  assert.equal(list.body.items[0].booking.reach, undefined, "kanal ünvanı panelə çıxmır");
  assert.deepEqual(calls("kbLeads").at(-1)!.args, [tenantId, "booking"]);

  p.ai.nextLead = { id: "booking-0002", contact: "+994501234567", booking: { service: "Manikür", date: start.slice(0, 10), time: "11:00", start, status: "cancelled", reach } };
  const r = await c.call("PATCH", "/tenant/bookings/booking-0002", { status: "cancelled", notify: true, note: "Usta xəstələnib" });
  assert.equal(r.status, 200);
  assert.equal(r.body.notified, "channel");
  assert.match(toCustomer().at(-1)!, /randevunuz \(Manikür\) ləğv olundu\.\nQeyd: Usta xəstələnib/);
  assert.deepEqual(calls("kbUpdateLead").at(-1)!.args[2], { bookingStatus: "cancelled", by: `bo${n}`, note: "Müştəriyə: Usta xəstələnib" });
  assert.equal((await p.store.dueReminders(new Date(Date.now() + 49 * 3_600_000), 50)).filter((r) => r.ref === "booking-0002").length, 0, "xatırlatma silinir");
  assert.equal((await c.call("PATCH", "/tenant/bookings/booking-0002", { status: "gone" })).status, 400);
});

test("sifariş lövhəsi: mərhələ dəyişəndə Telegram müştərisinə, saytdan gələn e-poçtlu müştəriyə məktub; bildirişsiz də olur", async () => {
  const { c, toCustomer } = await setup();
  const reach = { type: "telegram", chatId: "777", lang: "az" };
  p.ai.leads = [{ id: "order-0001", contact: "+994501234567", order: { title: "Sifariş", fields: [], stage: "new", reach } }, { id: "order-0002", contact: "leyla@mail.az", order: { title: "Sifariş", fields: [], stage: "new" } }, { id: "lead-x", contact: "0501112233", question: "sual" }];
  const list = await c.call("GET", "/tenant/orders");
  assert.deepEqual(list.body.items.map((x: { id: string; order: { notify: string | null } }) => [x.id, x.order.notify]), [["order-0001", "channel"], ["order-0002", "email"]]);

  p.ai.nextLead = { id: "ord-1a2b3c4d5e", contact: "+994501234567", order: { title: "Sifariş", fields: [], stage: "shipped", reach } };
  const r = await c.call("PATCH", "/tenant/orders/ord-1a2b3c4d5e/stage", { stage: "shipped", notify: true, note: "Kuryer: 050 000 00 00" });
  assert.equal(r.body.notified, "channel");
  assert.equal(toCustomer().at(-1), "Salon: 🚚 Sifarişiniz №ORD-1A2B yola çıxdı.\nQeyd: Kuryer: 050 000 00 00");
  assert.equal((calls("kbUpdateLead").at(-1)!.args[2] as { orderStage: string }).orderStage, "shipped");

  p.ai.nextLead = { id: "order-0002", contact: "leyla@mail.az", order: { title: "Sifariş", fields: [], stage: "delivered" } };
  const before = p.mails.length;
  assert.equal((await c.call("PATCH", "/tenant/orders/order-0002/stage", { stage: "delivered", notify: true })).body.notified, "email");
  assert.equal(p.mails.length, before + 1);
  assert.equal(p.mails.at(-1)!.to, "leyla@mail.az");

  const sentBefore = toCustomer().length;
  p.ai.nextLead = { id: "order-0001", contact: "+994501234567", order: { title: "Sifariş", fields: [], stage: "confirmed", reach } };
  assert.equal((await c.call("PATCH", "/tenant/orders/order-0001/stage", { stage: "confirmed", notify: false })).body.notified, null);
  assert.equal(toCustomer().length, sentBefore, "bildiriş seçilməyibsə müştəriyə getmir");
  assert.equal((await c.call("PATCH", "/tenant/orders/order-0001/stage", { stage: "lost" })).status, 400);
});
