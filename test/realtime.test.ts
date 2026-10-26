import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import WebSocket from "ws";
import { startPortal } from "./helpers.js";

let p: Awaited<ReturnType<typeof startPortal>>;
before(async () => { p = await startPortal(); });
after(() => p.close());

const config = { businessName: "Motoelan", domain: "motoelan.com", source: { type: "rest" } };
const ORIGIN = "https://motoelan.com";
let n = 0;
async function setup() {
  const c = await p.signedIn(`ws${++n}@example.com`);
  assert.equal((await c.call("POST", "/tenant", { config })).status, 201);
  const key = (await c.call("GET", "/tenant/widget")).body.widget.key as string;
  await c.call("PUT", "/tenant/widget", { live: { enabled: true } });
  const v = p.client();
  const visitor = (method: string, path: string, body?: unknown) => v.call(method, path, body, { origin: ORIGIN });
  const start = await visitor("POST", `/widget/${key}/live`, { message: "Salam" });
  return { c, key, visitor, id: start.body.id as string, token: start.body.token as string };
}

/** Soket açır; gələn bütün mesajları `events`-ə yığır; close kodunu qeyd edir. */
function open(origin: string, auth: Record<string, unknown> | null) {
  const ws = new WebSocket(p.base.replace("http", "ws") + "/ws", { headers: { origin } });
  const events: Record<string, unknown>[] = [];
  const o = { ws, events, closed: undefined as number | undefined, opened: new Promise<void>((r) => ws.on("open", () => r())) };
  ws.on("message", (d) => events.push(JSON.parse(d.toString())));
  ws.on("close", (code) => { o.closed = code; });
  ws.on("error", () => {});
  if (auth) ws.on("open", () => ws.send(JSON.stringify(auth)));
  return o;
}
const until = async (cond: () => boolean, ms = 1500) => { const t = Date.now(); while (!cond()) { if (Date.now() - t > ms) throw new Error("gözləmə bitdi"); await new Promise((r) => setTimeout(r, 15)); } };
const ticketOf = async (c: Awaited<ReturnType<typeof setup>>["c"]) => (await c.call("POST", "/tenant/live/ws-ticket")).body.ticket as string;

test("ziyarətçi soketi: düzgün token ilə ready; operator cavab verəndə dərhal 'new' siqnalı gəlir", async () => {
  const { c, key, id, token } = await setup();
  const vs = open(ORIGIN, { t: "auth", role: "visitor", key, id, token });
  await until(() => vs.events.some((e) => e.t === "ready"));
  assert.equal((await c.call("POST", `/tenant/live/${id}/messages`, { text: "Buyurun" })).status, 201);
  await until(() => vs.events.some((e) => e.t === "new"));
  assert.deepEqual(vs.events.find((e) => e.t === "new"), { t: "new", total: 2 });
  vs.ws.close();
});

test("operator soketi: bilet ilə ready; ziyarətçi yazanda və yeni söhbət başlayanda 'live' siqnalı gəlir; yazır siqnalı hər iki istiqamətdə", async () => {
  const { c, key, visitor, id, token } = await setup();
  const op = open("http://localhost:3001", { t: "auth", role: "operator", ticket: await ticketOf(c) });
  const vs = open(ORIGIN, { t: "auth", role: "visitor", key, id, token });
  await until(() => op.events.some((e) => e.t === "ready") && vs.events.some((e) => e.t === "ready"));

  await visitor("POST", `/widget/${key}/live/${id}/sync`, { token, after: 1, text: "Qiymət?" });
  await until(() => op.events.some((e) => e.t === "live" && e.kind === "message"));

  const started = await visitor("POST", `/widget/${key}/live`, { message: "Başqa söhbət" });
  await until(() => op.events.some((e) => e.t === "live" && e.kind === "start" && e.id === started.body.id));

  vs.ws.send(JSON.stringify({ t: "typing" }));
  await until(() => op.events.some((e) => e.t === "typing" && e.id === id));
  op.ws.send(JSON.stringify({ t: "typing", id }));
  await until(() => vs.events.some((e) => e.t === "typing"));

  await c.call("POST", `/tenant/live/${id}/close`);
  await until(() => vs.events.some((e) => e.t === "new")); // bağlanma da siqnal verir, ziyarətçi sync ilə "closed" görür
  op.ws.close(); vs.ws.close();
});

test("təhlükəsizlik: səhv token, yad sayt, söndürülmüş canlı söhbət, saxta bilet, auth-suz soket", async () => {
  const { c, key, id, token } = await setup();
  const bad = open(ORIGIN, { t: "auth", role: "visitor", key, id, token: "x".repeat(48) });
  await until(() => bad.closed !== undefined); assert.equal(bad.closed, 4404);

  const foreign = open("https://evil.example", { t: "auth", role: "visitor", key, id, token });
  await until(() => foreign.closed !== undefined); assert.equal(foreign.closed, 4403);

  const fake = open("http://localhost:3001", { t: "auth", role: "operator", ticket: "abc.def" });
  await until(() => fake.closed !== undefined); assert.equal(fake.closed, 4403);

  const wrongOrigin = open("https://evil.example", { t: "auth", role: "operator", ticket: await ticketOf(c) });
  await until(() => wrongOrigin.closed !== undefined); assert.equal(wrongOrigin.closed, 4403);

  const silent = open(ORIGIN, null);
  await silent.opened;
  silent.ws.send(JSON.stringify({ t: "typing" })); // auth-dan əvvəl heç nə qəbul edilmir
  await until(() => silent.closed !== undefined, 6500); assert.equal(silent.closed, 4401);

  await c.call("PUT", "/tenant/widget", { live: { enabled: false } });
  const off = open(ORIGIN, { t: "auth", role: "visitor", key, id, token });
  await until(() => off.closed !== undefined); assert.equal(off.closed, 4403);
});

test("bilet: giriş tələb olunur; başqa müştərinin söhbətinə operator soketi 'yazır' göndərə bilmir", async () => {
  const anon = p.client();
  assert.equal((await anon.call("POST", "/tenant/live/ws-ticket")).status, 401);
  const a = await setup(), b = await setup();
  const opB = open("http://localhost:3001", { t: "auth", role: "operator", ticket: await ticketOf(b.c) });
  const vsA = open(ORIGIN, { t: "auth", role: "visitor", key: a.key, id: a.id, token: a.token });
  await until(() => opB.events.some((e) => e.t === "ready") && vsA.events.some((e) => e.t === "ready"));
  opB.ws.send(JSON.stringify({ t: "typing", id: a.id })); // A-nın söhbəti B-yə aid deyil
  await new Promise((r) => setTimeout(r, 200));
  assert.ok(!vsA.events.some((e) => e.t === "typing"));
  opB.ws.close(); vsA.ws.close();
});
