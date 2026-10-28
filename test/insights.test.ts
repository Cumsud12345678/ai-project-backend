import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { startPortal } from "./helpers.js";

let p: Awaited<ReturnType<typeof startPortal>>;
before(async () => { p = await startPortal(); });
after(() => p.close());

test("analitika: trend və bəyənmə, təhlil AI-a ötürülür; girişsiz 401; sürət limiti 429", async () => {
  const c = await p.signedIn("ins1@example.com");
  assert.equal((await c.call("GET", "/tenant/insights/trend")).status, 404, "hesab yoxdur");
  assert.equal((await c.call("POST", "/tenant", { config: { businessName: "Kontakt", domain: "kontakt.az", profile: { mode: "support" }, source: { type: "rest" } } })).status, 201);
  const tr = await c.call("GET", "/tenant/insights/trend?days=7");
  assert.equal(tr.status, 200);
  assert.equal(tr.body.daily.length, 7);
  assert.deepEqual(tr.body.feedback, { up: 0, down: 0, satisfaction: null });
  const a = await c.call("POST", "/tenant/insights/analyze", { days: 30 });
  assert.equal(a.status, 200);
  assert.equal(a.body.topics[0].name, "Çatdırılma");
  const call = p.ai.calls.find((x) => x.fn === "insights")!;
  assert.equal((call.args[1] as any).days, 30);
  assert.equal((await p.client().call("POST", "/tenant/insights/analyze", {})).status, 401);
  let last = 200;
  for (let i = 0; i < 7; i++) last = (await c.call("POST", "/tenant/insights/analyze", { days: 30 })).status;
  assert.equal(last, 429);
});
