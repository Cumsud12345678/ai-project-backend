// Sehirbaz axını: addım dəyişəndə sonrakılar sıfırlanır, sürətli başlanğıcın qaralamaları saxlanır,
// yenidən işə salınanda əvvəlki yaradılanlar silinir, sehirbaz bitəndə qaralamalar təmizlənir və kataloq seçilməyibsə rejim "support" olur.
import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { startPortal } from "./helpers.js";

let p: Awaited<ReturnType<typeof startPortal>>;
before(async () => { p = await startPortal(); });
after(() => p.close());
const calls = (fn: string) => p.ai.calls.filter((c) => c.fn === fn);
let n = 0;
async function setup() {
  const c = await p.signedIn(`sf${++n}@example.com`);
  assert.equal((await c.call("POST", "/tenant", { config: { businessName: "Salon", domain: `salon${n}.az`, profile: { mode: "both" }, source: { type: "rest" } } })).status, 201);
  const view = async () => (await c.call("GET", "/tenant")).body.tenant.setup;
  const okChat = async () => { p.ai.nextChat = { answer: "Saç kəsimi 15 AZN", listings: [], sources: [{ title: "Qiymətlər" }] }; await c.call("POST", "/tenant/chat", { message: "qiymət?" }); };
  return { c, view, okChat };
}

test("addım dəyişəndə sonrakılar sıfırlanır: biznes növü, ad/sayt; eyni seçim təkrar yazılanda yox", async () => {
  const { c, view, okChat } = await setup();
  assert.equal((await view()).stage, 1, "yeni hesab sehirbazın 1-ci addımındadır");
  assert.equal((await c.call("PUT", "/tenant/setup", { goals: ["answer"], bizType: "service" })).body.stage, 2);
  await okChat();
  assert.equal((await view()).stage, 4, "məlumatla cavab: sınaq tamam");
  assert.equal((await view()).tested, true);
  assert.equal((await c.call("PUT", "/tenant/setup", { goals: ["answer"], bizType: "service" })).body.stage, 4, "dəyişiklik yoxdur: sıfırlanmır");
  assert.equal((await c.call("PUT", "/tenant/setup", { goals: ["answer"], bizType: "social" })).body.stage, 2, "növ dəyişdi");
  assert.equal((await view()).tested, false);
  assert.equal((await c.call("GET", "/tenant/overview")).body.setup.tested, false);
  await okChat();
  assert.equal((await view()).stage, 4);
  const cfg = { businessName: "Salon Yeni", domain: `salon${n}.az`, profile: { mode: "both" }, source: { type: "rest" } };
  const up = await c.call("PUT", "/tenant/config", { config: cfg }); assert.equal(up.status, 200, JSON.stringify(up.body));
  assert.equal((await view()).stage, 1, "ad dəyişdi: hamısı yenidən");
  assert.equal((await c.call("PUT", "/tenant/setup/stage", { stage: 5 })).status, 409, "bitməmiş sehirbaz bitirilə bilməz");
});

test("qaralama saxlanır; yenidən işə salınanda əvvəlki yaradılanlar silinir; bitəndə qaralama silinir, kataloq seçilməyibsə rejim support", async () => {
  const { c, view, okChat } = await setup();
  await c.call("PUT", "/tenant/setup", { goals: ["answer"], bizType: "service" });
  assert.equal((await c.call("PUT", "/tenant/setup/draft", { type: "service", values: { list: "Saç kəsimi — 60 dəq", capacity: 3, useRem: false, hack: "x" } })).status, 200);
  assert.equal((await c.call("PUT", "/tenant/setup/draft", { type: "casino", values: {} })).status, 400);
  assert.deepEqual((await view()).drafts.service, { list: "Saç kəsimi — 60 dəq", capacity: 3, useRem: false });

  assert.equal((await c.call("PUT", "/tenant/setup/made", { type: "service", kbSources: ["src-1", "bad id!"], booking: true, orderForm: false })).body.stage, 3);
  assert.deepEqual((await view()).made, { type: "service", booking: true, orderForm: false, followup: false });
  // Növü dəyişir: əvvəlki növün randevusu və bilik mətni dərhal silinir (sınaqda qarışmasın), qaralama qalır
  await c.call("PUT", "/tenant/setup", { goals: ["answer"], bizType: "social" });
  assert.equal((await view()).bizType, "social");
  assert.equal((await c.call("POST", "/tenant/setup/quickstart/reset")).status, 200);
  assert.deepEqual(calls("kbDelete").at(-1)!.args.slice(1), ["src-1"]);
  assert.ok(calls("deleteBooking").length > 0);
  assert.equal(calls("deleteOrderForm").length, 0, "sifariş formasını sehirbaz yaratmayıb: toxunulmur");
  assert.equal((await view()).made, undefined);
  assert.ok((await view()).drafts.service, "əvvəlki növün qaralaması sehirbaz bitənə qədər qalır");

  await c.call("PUT", "/tenant/setup/made", { type: "social", kbSources: ["src-2"], orderForm: true });
  await okChat();
  assert.equal((await view()).stage, 4);
  const patches = calls("patchProfile").length;
  assert.equal((await c.call("PUT", "/tenant/setup/stage", { stage: 5 })).body.stage, 5);
  const v = await view();
  assert.equal(v.stage, 5);
  assert.equal(v.drafts, undefined, "qaralamalar silinir");
  assert.equal(v.made.type, "social", "son nəticə qalır");
  assert.equal(calls("patchProfile").length, patches + 1);
  assert.deepEqual(calls("patchProfile").at(-1)!.args[1], { mode: "support" }, "kataloq seçilməyib: köməkçi kataloqdan axtarmır");
  // Sehirbaz bitəndən sonra Ayarlarda adı dəyişmək hazırlığı pozmur
  const cur = (await c.call("GET", "/tenant")).body.tenant;
  assert.equal((await c.call("PUT", "/tenant/config", { config: { ...cur.config, businessName: "Yeni ad", domain: cur.domain } })).status, 200);
  assert.equal((await view()).stage, 5);
});
