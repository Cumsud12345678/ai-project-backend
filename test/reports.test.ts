import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { startPortal } from "./helpers.js";
import { chatTimes, dayKey } from "../src/reports.js";

let p: Awaited<ReturnType<typeof startPortal>>;
before(async () => { p = await startPortal(); });
after(() => p.close());
const config = { businessName: "Motoelan", domain: "motoelan.com", source: { type: "rest" } };
const ORIGIN = "https://motoelan.com";

test("söhbət vaxtları: ilk cavab və müddət", () => {
  const t0 = new Date("2026-11-01T10:00:00Z");
  const at = (s: number) => new Date(t0.getTime() + s * 1000);
  const c = { createdAt: t0, updatedAt: at(600), status: "closed", messages: [
    { from: "visitor", text: "salam", at: at(0) }, { from: "operator", text: "buyurun", at: at(45), by: "ali" },
    { from: "operator", text: "?", at: at(90), by: "nigar" }, { from: "system", text: "closed", at: at(300) }] } as never;
  assert.deepEqual(chatTimes(c), { firstResponseSec: 45, durationSec: 300, operators: ["ali", "nigar"], answered: true });
  assert.equal(dayKey("2026-11-01T21:30:00Z"), "2026-11-02", "Bakı vaxtı ilə yeni gün");
});

test("hesabat: canlı söhbət, CSAT, komanda, gündəlik bölgü; operator görə bilmir", async () => {
  const c = await p.signedIn("rep1@example.com");
  assert.equal((await c.call("POST", "/tenant", { config })).status, 201);
  const key = (await c.call("GET", "/tenant/widget")).body.widget.key as string;
  await c.call("PUT", "/tenant/widget", { live: { enabled: true } });
  const v = (m: string, path: string, b?: unknown) => p.client().call(m, path, b, { origin: ORIGIN });
  for (const rating of [5, 2]) {
    const s = await v("POST", `/widget/${key}/live`, { message: "Kömək lazımdır", name: "Elnur", contact: "+994501234567" });
    const { id, token } = s.body as { id: string; token: string };
    await c.call("POST", `/tenant/live/${id}/messages`, { text: "Buyurun" });
    await c.call("POST", `/tenant/live/${id}/close`);
    await v("POST", `/widget/${key}/live/${id}/csat`, { token, rating });
  }
  const missed = (await v("POST", `/widget/${key}/live`, { message: "salam?" })).body.id as string;
  await c.call("POST", `/tenant/live/${missed}/close`);

  const r = await c.call("GET", "/tenant/reports?days=7");
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const cur = r.body.cur;
  assert.equal(cur.liveNew, 3); assert.equal(cur.liveClosed, 3); assert.equal(cur.missed, 1);
  assert.deepEqual(cur.csat, { good: 1, neutral: 0, bad: 1, avg: 3.5 });
  assert.equal(typeof cur.firstResponseSec, "number");
  assert.equal(r.body.daily.length, 7);
  assert.equal(r.body.daily.at(-1).live, 3); assert.equal(r.body.daily.at(-1).csatBad, 1);
  assert.equal(r.body.team.length, 1); assert.equal(r.body.team[0].name, "rep1"); assert.equal(r.body.team[0].chats, 2);
  assert.equal(r.body.prev.liveNew, 0);
  assert.equal((await c.call("GET", "/tenant/reports?days=13")).body.days, 7, "yalnız 7/30/90");

  await c.call("POST", "/tenant/team", { email: "op-rep@example.com" });
  assert.equal((await (await p.signedIn("op-rep@example.com")).call("GET", "/tenant/reports")).status, 404);
});
