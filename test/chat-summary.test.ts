// AI xülasəsi: canlı söhbətdə saxlanır, yeni mesaj gəlməyibsə təkrar AI çağırılmır; AI söhbətində keşlənir; operator də istifadə edir.
import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { startPortal } from "./helpers.js";
import { cleanSummary, liveTranscript } from "../src/chat-summary.js";
import type { LiveChat } from "../src/store/types.js";

let p: Awaited<ReturnType<typeof startPortal>>;
before(async () => { p = await startPortal(); });
after(() => p.close());

const chat = (tenantId: string, id: string, over: Partial<LiveChat> = {}): LiveChat => ({
  id, tenantId, tokenHash: "x", name: "Aysel", contact: "", status: "open", createdAt: new Date(), updatedAt: new Date(),
  context: [{ role: "user", text: "Qırmızı ayaqqabı var?" }, { role: "model", text: "Bəli, 3 model." }],
  messages: [{ from: "visitor", text: "Çatdırılma neçəyədir?", at: new Date() }, { from: "system", text: "closed", at: new Date() }], ...over,
});
const sums = () => p.ai.calls.filter((x) => x.fn === "summarize").length;

test("cleanSummary və liveTranscript: dəyərlər yoxlanır, sistem mesajı atılır, AI yazışması da daxildir", () => {
  assert.equal(cleanSummary({ intent: "x" }), null);
  assert.equal(cleanSummary({ summary: "ok", mood: "furious", temperature: "x" })!.mood, "neutral");
  const tr = liveTranscript(chat("t", "c"));
  assert.deepEqual(tr.map((m) => m.from), ["visitor", "ai", "visitor"]);
});

test("canlı söhbət: ilk dəfə AI çağırılır və saxlanır, təkrar açılış pulsuzdur, yeni mesajdan sonra köhnəlir", async () => {
  const c = await p.signedIn("sum@example.com");
  assert.equal((await c.call("POST", "/tenant", { config: { businessName: "S", domain: "sum.az", source: { type: "rest" } } })).status, 201);
  const t = (await c.call("GET", "/tenant")).body.tenant;
  await p.store.createLive(chat(t.tenantId, "live-sum-1"));
  const n0 = sums();
  const first = await c.call("POST", "/tenant/live/live-sum-1/summary");
  assert.equal(first.status, 200);
  assert.equal(first.body.cached, false);
  assert.equal(first.body.summary.intent, "Qiymət öyrənmək");
  const sent = p.ai.calls.filter((x) => x.fn === "summarize").at(-1)!.args[1] as { from: string }[];
  assert.ok(!sent.some((m) => m.from === "system"), "sistem mesajı AI-a getmir");
  const again = await c.call("POST", "/tenant/live/live-sum-1/summary");
  assert.equal(again.body.cached, true);
  assert.equal(sums(), n0 + 1, "saxlanmış xülasə üçün AI çağırılmır");
  const view = await c.call("GET", "/tenant/live/live-sum-1");
  assert.equal(view.body.chat.summary.stale, false, "söhbət açılanda xülasə də gəlir");
  await p.store.pushLive(t.tenantId, "live-sum-1", { from: "visitor", text: "Endirim var?", at: new Date() });
  assert.equal((await c.call("GET", "/tenant/live/live-sum-1")).body.chat.summary.stale, true, "yeni mesajdan sonra köhnəlib");
  assert.equal((await c.call("POST", "/tenant/live/live-sum-1/summary")).body.cached, false);
  assert.equal((await c.call("POST", "/tenant/live/live-sum-1/summary", { force: true })).body.cached, false, "yenilə düyməsi");
});

test("müştəri yazmayıbsa 400; balans bitibsə 402", async () => {
  const c = await p.signedIn("sum2@example.com");
  assert.equal((await c.call("POST", "/tenant", { config: { businessName: "S", domain: "sum2.az", source: { type: "rest" } } })).status, 201);
  const t = (await c.call("GET", "/tenant")).body.tenant;
  await p.store.createLive(chat(t.tenantId, "live-empty", { context: [], messages: [{ from: "operator", text: "Salam", at: new Date() }] }));
  assert.equal((await c.call("POST", "/tenant/live/live-empty/summary")).status, 400);
  await p.store.createLive(chat(t.tenantId, "live-402"));
  const { AiError } = await import("../src/ai.js");
  const orig = p.ai.summarize;
  p.ai.summarize = async () => { throw new AiError(402, "Balans bitib", "BALANCE_EMPTY"); };
  try { assert.equal((await c.call("POST", "/tenant/live/live-402/summary")).status, 402); } finally { p.ai.summarize = orig; }
});

test("AI söhbəti: xülasə keşlənir, söhbət böyüyəndə yenilənir", async () => {
  const c = await p.signedIn("sum3@example.com");
  assert.equal((await c.call("POST", "/tenant", { config: { businessName: "S", domain: "sum3.az", source: { type: "rest" } } })).status, 201);
  const n0 = sums();
  const r = await c.call("POST", "/tenant/conversations/aaaaaaaa11/summary");
  assert.equal(r.status, 200);
  assert.equal(r.body.cached, false);
  const sent = p.ai.calls.filter((x) => x.fn === "summarize").at(-1)!.args[1];
  assert.deepEqual(sent, [{ from: "visitor", text: "salam" }, { from: "ai", text: "Salam!" }]);
  assert.equal((await c.call("POST", "/tenant/conversations/aaaaaaaa11/summary")).body.cached, true);
  assert.equal(sums(), n0 + 1);
});
