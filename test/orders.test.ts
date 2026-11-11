// API-siz sifariş: AI cavabında order gələndə sahibə e-poçt gedir, panel forması yalnız sahibə açıqdır.
import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { startPortal } from "./helpers.js";
import { leadText } from "../src/lead-forward.js";
import { parseOrder } from "../src/orders.js";

let p: Awaited<ReturnType<typeof startPortal>>;
before(async () => { p = await startPortal(); });
after(() => p.close());

const config = { businessName: "Tort Evi", domain: "tortevi.az", source: { type: "rest" } };
const order = { id: "a1b2c3d4e5f60718", title: "Tort sifarişi", name: "Leyla", contact: "+994501234567", fields: [{ label: "Ad", value: "Leyla" }, { label: "Telefon", value: "+994501234567" }, { label: "Tort", value: "Napoleon" }] };
const wait = () => new Promise((r) => setTimeout(r, 30));

test("vidjetdən sifariş gələndə sahibə 'Yeni sifariş' e-poçtu gedir", async () => {
  const c = await p.signedIn("tort@example.com");
  assert.equal((await c.call("POST", "/tenant", { config })).status, 201);
  const key = (await c.call("GET", "/tenant/widget")).body.widget.key;
  p.ai.nextChat = { answer: "Sifarişiniz qəbul olundu", listings: [], order };
  const r = await fetch(`${p.base}/widget/${key}/chat`, { method: "POST", headers: { "content-type": "application/json", origin: "https://tortevi.az" }, body: JSON.stringify({ message: "bəli təsdiq edirəm" }) });
  assert.equal(r.status, 200);
  await wait();
  const mail = p.mails.find((m) => m.to === "tort@example.com" && m.subject.includes("Yeni sifariş"));
  assert.ok(mail, "sahibə sifariş e-poçtu");
  assert.match(mail!.subject, /№A1B2C3D4/);
  assert.match(mail!.text, /Tort: Napoleon/);
});

test("order sahəsi yoxlanır: əlaqəsiz və ya boş sifariş nəzərə alınmır, mətn təmizlənir", () => {
  assert.equal(parseOrder(null), null);
  assert.equal(parseOrder({ ...order, contact: "" }), null);
  assert.equal(parseOrder({ ...order, fields: [] }), null);
  const o = parseOrder({ ...order, fields: [{ label: "Ünvan\u0000", value: "Bülbül 5\n" }] })!;
  assert.deepEqual(o.fields, [{ label: "Ünvan", value: "Bülbül 5" }]);
});

test("ötürmə mətni sifarişi sahələri ilə göstərir", () => {
  const t = { businessName: "Tort Evi" } as never;
  const text = leadText(t, { source: "sayt, sifariş", name: "Leyla", contact: "+994501234567", question: "", order: { title: "Tort sifarişi", fields: order.fields } });
  assert.match(text, /🛒 Yeni sifariş: Tort sifarişi/);
  assert.match(text, /Tort: Napoleon/);
});

test("sifariş forması: sahib oxuyur və yazır, operator yox", async () => {
  const owner = await p.signedIn("forma@example.com");
  assert.equal((await owner.call("POST", "/tenant", { config: { ...config, domain: "forma.az" } })).status, 201);
  const form = { enabled: true, fields: [{ key: "phone", label: "Telefon", type: "phone", required: true }] };
  assert.equal((await owner.call("PUT", "/tenant/order-form", form)).status, 200);
  assert.deepEqual(p.ai.calls.filter((x) => x.fn === "setOrderForm").at(-1)!.args[1], form);
  assert.equal((await owner.call("GET", "/tenant/order-form")).status, 200);
  assert.equal((await owner.call("POST", "/tenant/team", { email: "isci@example.com" })).status, 201);
  const op = await p.signedIn("isci@example.com");
  assert.equal((await op.call("PUT", "/tenant/order-form", form)).status, 404, "operatorun öz hesabı yoxdur: sahib marşrutu ona bağlıdır");
});
