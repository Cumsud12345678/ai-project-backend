import test from "node:test";
import assert from "node:assert/strict";
import { createMailer, renderHtml } from "../src/mailer.js";
import { loadConfig } from "../src/config.js";

const res = (status: number, body: object = {}) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

test("Resend: düzgün sorğu (açar başlıqda, from/to/subject/text/html, reply_to)", async () => {
  const calls: { url: string; init: RequestInit }[] = [];
  const m = createMailer({ apiKey: "re_SECRET", from: "Car <a@b.az>", replyTo: "d@b.az", fetchFn: (async (u: string, init: RequestInit) => { calls.push({ url: u, init }); return res(200, { id: "1" }); }) as any });
  await m.send("x@y.az", "Kod", "Salam\n\n123456\n\n--\nAlt qeyd");
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.url, "https://api.resend.com/emails");
  assert.equal((calls[0]!.init.headers as Record<string, string>).authorization, "Bearer re_SECRET");
  const b = JSON.parse(String(calls[0]!.init.body));
  assert.deepEqual([b.from, b.to, b.subject, b.reply_to], ["Car <a@b.az>", ["x@y.az"], "Kod", "d@b.az"]);
  assert.match(b.text, /123456/); assert.match(b.html, /letter-spacing:8px/);
});

test("Resend: 5xx/429 təkrarlanır, 4xx təkrarlanmır, xəta mətnində açar yoxdur", async () => {
  let n = 0;
  const flaky = createMailer({ apiKey: "re_SECRET", from: "a", retryDelayMs: 1, fetchFn: (async () => (++n < 3 ? res(503, { message: "busy" }) : res(200))) as any });
  await flaky.send("x@y.az", "s", "t"); assert.equal(n, 3);
  n = 0;
  const bad = createMailer({ apiKey: "re_SECRET", from: "a", retryDelayMs: 1, fetchFn: (async () => { n++; return res(403, { message: "domain not verified" }); }) as any });
  await assert.rejects(bad.send("x@y.az", "s", "t"), (e: Error) => /403/.test(e.message) && /domain not verified/.test(e.message) && !/re_SECRET/.test(e.message));
  assert.equal(n, 1);
  const down = createMailer({ apiKey: "re_SECRET", from: "a", retryDelayMs: 1, fetchFn: (async () => { throw new Error("re_SECRET boom"); }) as any });
  await assert.rejects(down.send("x@y.az", "s", "t"), (e: Error) => !/re_SECRET/.test(e.message));
});

test("açar yoxdursa konsola yazılır, HTML təhlükəsizdir", async () => {
  const logs: string[] = []; const orig = console.log; console.log = (...a) => { logs.push(a.join(" ")); };
  try { await createMailer({ from: "a" }).send("x@y.az", "S", "mətn"); } finally { console.log = orig; }
  assert.match(logs.join(""), /x@y\.az/);
  const h = renderHtml("<b>Başlıq</b>", 'Link: https://a.az/x?y=1.\n<script>alert(1)</script>');
  assert.doesNotMatch(h, /<script>/); assert.match(h, /&lt;b&gt;Başlıq/); assert.match(h, /href="https:\/\/a\.az\/x\?y=1"/);
});

test("production-da RESEND_API_KEY və MAIL_FROM məcburidir", () => {
  const base = { NODE_ENV: "production", MONGODB_URI: "m", AI_SERVICE_URL: "http://a", AI_SERVICE_TOKEN: "t" };
  assert.throws(() => loadConfig(base), /RESEND_API_KEY/);
  assert.throws(() => loadConfig({ ...base, RESEND_API_KEY: "re_x" }), /MAIL_FROM/);
  assert.equal(loadConfig({ ...base, RESEND_API_KEY: "re_x", MAIL_FROM: "A <a@b.az>" }).resendApiKey, "re_x");
});
