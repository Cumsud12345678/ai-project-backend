// Operator helpdesk: daxili qeydlər, etiketlər, hazır cavablar, AI qaralaması, işçi saatları, CSAT.
import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { startPortal } from "./helpers.js";
import { matchPath, parseCanned, parseHours, parseProactive, parseTags, withinHours } from "../src/helpdesk.js";

let p: Awaited<ReturnType<typeof startPortal>>;
before(async () => { p = await startPortal(); });
after(() => p.close());
const support = { businessName: "Magaza", domain: "magaza.az", email: "oz@example.com", profile: { language: "az", mode: "support" } };
let n = 0;
const ORIGIN = { origin: "https://magaza.az" };
async function setup() {
  const c = await p.signedIn(`hd${++n}@example.com`);
  assert.equal((await c.call("POST", "/tenant", { config: support })).status, 201);
  const key = (await c.call("GET", "/tenant/widget")).body.widget.key as string;
  assert.equal((await c.call("PUT", "/tenant/widget", { live: { enabled: true } })).status, 200);
  return { c, key };
}
async function startLive(key: string) {
  const v = p.client();
  const r = await v.call("POST", `/widget/${key}/live`, { message: "Salam, sifarişim haradadır?", name: "Ali" }, ORIGIN);
  assert.equal(r.status, 201);
  return { v, id: r.body.id as string, token: r.body.token as string };
}

test("işçi saatları: gün/saat, saat qurşağı və yoxlama", () => {
  const h = parseHours({ tz: "Asia/Baku", days: [null, { from: "09:00", to: "18:00" }, { from: "09:00", to: "18:00" }, { from: "09:00", to: "18:00" }, { from: "09:00", to: "18:00" }, { from: "09:00", to: "18:00" }, null] })!;
  // 2026-10-28 çərşənbə 16:00 Bakı = 12:00 UTC
  assert.equal(withinHours(h, new Date("2026-10-28T12:00:00Z")), true);
  assert.equal(withinHours(h, new Date("2026-10-28T14:00:00Z")), false, "18:00 Bakı: bitib (qeyri-daxil)");
  assert.equal(withinHours(h, new Date("2026-10-28T04:59:00Z")), false, "08:59 Bakı");
  assert.equal(withinHours(h, new Date("2026-10-31T10:00:00Z")), false, "şənbə");
  assert.equal(withinHours(h, new Date("2026-10-25T10:00:00Z")), false, "bazar");
  assert.equal(withinHours(null), true);
  const ny = parseHours({ tz: "America/New_York", days: Array(7).fill({ from: "09:00", to: "17:00" }) })!;
  assert.equal(withinHours(ny, new Date("2026-10-28T14:00:00Z")), true, "10:00 Nyu-York");
  for (const bad of [{ tz: "Mars/Base", days: Array(7).fill(null) }, { tz: "Asia/Baku", days: [] }, { tz: "Asia/Baku", days: Array(7).fill(null) }, { tz: "Asia/Baku", days: Array(7).fill({ from: "18:00", to: "09:00" }) }, { tz: "Asia/Baku", days: Array(7).fill({ from: "9:00", to: "18:00" }) }, "x", 5])
    assert.throws(() => parseHours(bad), /İşçi saatları/, JSON.stringify(bad).slice(0, 50));
  assert.equal(parseHours(null), null);
});

test("proaktiv, hazır cavab və etiket doğrulaması", () => {
  const ok = parseProactive({ enabled: true, rules: [{ text: "Kömək lazımdır?", delaySec: 20, match: "/products/*, /" }] });
  assert.match(ok.rules[0]!.id, /^[a-f0-9]{8}$/);
  for (const bad of [{ enabled: true, rules: Array(6).fill({ text: "salam", delaySec: 10, match: "*" }) }, { enabled: true, rules: [{ text: "ab", delaySec: 10, match: "*" }] }, { enabled: true, rules: [{ text: "salam", delaySec: 1, match: "*" }] }, { enabled: true, rules: [{ text: "salam", delaySec: 10, match: "<script>" }] }, { enabled: "yes", rules: [] }, { enabled: true, rules: [{ text: "x".repeat(141), delaySec: 10, match: "*" }] }])
    assert.throws(() => parseProactive(bad), /Proaktiv|proactive|Gözləmə|şablonu|Ən çox/);
  assert.equal(matchPath("/", "/"), true); assert.equal(matchPath("/products/*", "/products/1"), true); assert.equal(matchPath("/products/*", "/productsX"), false);
  assert.equal(matchPath("*", "/x"), true); assert.equal(matchPath("/a, /b", "/b"), true); assert.equal(matchPath("/a", "/a/b"), false);
  assert.throws(() => parseCanned(Array.from({ length: 31 }, () => ({ title: "a", text: "b" }))), /30/);
  assert.throws(() => parseCanned([{ title: "", text: "b" }]), /adı/); assert.throws(() => parseCanned([{ title: "a", text: "x".repeat(1001) }]), /mətni/);
  assert.deepEqual(parseTags([" VIP ", "vip", "Gecikmə"]), ["VIP", "Gecikmə"], "təkrar (böyük/kiçik hərfsiz) atılır");
  assert.throws(() => parseTags(Array(6).fill("a").map((x, i) => x + i)), /5/); assert.throws(() => parseTags(["x".repeat(25)]), /24/); assert.throws(() => parseTags("x"), /5/);
});

test("daxili qeyd: operator yazır, ziyarətçi görmür; limit və uzunluq", async () => {
  const { c, key } = await setup();
  const { v, id, token } = await startLive(key);
  assert.equal((await c.call("POST", `/tenant/live/${id}/notes`, { text: "Müştəri VIP-dir" })).status, 201);
  assert.equal((await c.call("POST", `/tenant/live/${id}/notes`, { text: "" })).status, 400);
  assert.equal((await c.call("POST", `/tenant/live/${id}/notes`, { text: "x".repeat(1001) })).status, 400);
  const got = await c.call("GET", `/tenant/live/${id}`);
  assert.equal(got.body.chat.notes.length, 1); assert.equal(got.body.chat.notes[0].text, "Müştəri VIP-dir");
  const sync = await v.call("POST", `/widget/${key}/live/${id}/sync`, { token, after: 0 }, ORIGIN);
  assert.doesNotMatch(JSON.stringify(sync.body), /VIP/, "ziyarətçiyə qeyd getmir");
  const list = await c.call("GET", "/tenant/live?status=open");
  assert.equal(list.body.items[0].notes, 1);
  assert.equal((await c.call("POST", `/tenant/live/yoxdur/notes`, { text: "x" })).status, 404);
});

test("etiketlər: təyin olunur, siyahıda görünür, səhv format rədd olunur", async () => {
  const { c, key } = await setup();
  const { id } = await startLive(key);
  const put = await c.call("PUT", `/tenant/live/${id}/tags`, { tags: ["VIP", "gecikmə"] });
  assert.equal(put.status, 200); assert.deepEqual(put.body.tags, ["VIP", "gecikmə"]);
  assert.deepEqual((await c.call("GET", "/tenant/live?status=open")).body.items[0].tags, ["VIP", "gecikmə"]);
  assert.equal((await c.call("PUT", `/tenant/live/${id}/tags`, { tags: ["a", "b", "c", "d", "e", "f"] })).status, 400);
  assert.equal((await c.call("PUT", `/tenant/live/${id}/tags`, { tags: [""] })).status, 400);
});

test("hazır cavablar: operator oxuyur, yalnız sahib yazır", async () => {
  const { c } = await setup();
  assert.equal((await c.call("PUT", "/tenant/canned", { items: [{ title: "Salam", text: "Salam! Necə kömək edim?" }, { title: "Çatdırılma", text: "Çatdırılma 1-3 gündür." }] })).status, 200);
  const got = await c.call("GET", "/tenant/canned");
  assert.equal(got.body.items.length, 2); assert.match(got.body.items[0].id, /^[a-f0-9]{8}$/);
  assert.equal((await c.call("PUT", "/tenant/canned", { items: "x" })).status, 400);
  const email = `op-hd${n}@example.com`;
  assert.equal((await c.call("POST", "/tenant/team", { email })).status, 201);
  const op = await p.signedIn(email);
  assert.equal((await op.call("GET", "/tenant/canned")).body.items.length, 2, "operator oxuya bilir");
  assert.notEqual((await op.call("PUT", "/tenant/canned", { items: [] })).status, 200, "operator dəyişə bilmir");
  assert.equal((await c.call("GET", "/tenant/canned")).body.items.length, 2);
});

test("AI qaralaması: söhbət AI-a gedir, nəticə qayıdır; ziyarətçiyə heç nə getmir; ziyarətçi yazmayıbsa rədd", async () => {
  const { c, key } = await setup();
  const { v, id, token } = await startLive(key);
  p.ai.nextDraft = { draft: "Salam Ali, sifarişinizi yoxlayıram." };
  const r = await c.call("POST", `/tenant/live/${id}/draft`);
  assert.equal(r.status, 200); assert.equal(r.body.draft, "Salam Ali, sifarişinizi yoxlayıram.");
  const call = p.ai.calls.filter((x) => x.fn === "draft").at(-1)!;
  assert.equal((call.args[1] as any).messages[0].text, "Salam, sifarişim haradadır?");
  const sync = await v.call("POST", `/widget/${key}/live/${id}/sync`, { token, after: 0 }, ORIGIN);
  assert.doesNotMatch(JSON.stringify(sync.body), /sifarişinizi yoxlayıram/);
  // ziyarətçi mesajsız söhbət (operator başladıb)
  const { AiError } = await import("../src/ai.js");
  const orig = p.ai.draft;
  try {
    p.ai.draft = async () => { throw new AiError(402, "balans", "NO_FUNDS"); };
    assert.equal((await c.call("POST", `/tenant/live/${id}/draft`)).status, 402);
    p.ai.draft = async () => { throw new AiError(500, "x", "X"); };
    assert.equal((await c.call("POST", `/tenant/live/${id}/draft`)).status, 502);
  } finally { p.ai.draft = orig; }
  assert.equal((await p.client().call("POST", `/tenant/live/${id}/draft`)).status, 401);
});

test("işçi saatları vidjetdə: kənarda canlı düymə gizlənir və başlatmaq 409 verir; saat daxilində açıqdır", async () => {
  const { c, key } = await setup();
  const cfg = async () => (await p.client().call("GET", `/widget/${key}/config`, undefined, ORIGIN)).body;
  assert.equal((await cfg()).live, true);
  const today = new Date().getDay();
  const closed = Array(7).fill(null).map((_, i) => (i === (today + 3) % 7 ? { from: "09:00", to: "18:00" } : null)); // yalnız 3 gün sonra
  assert.equal((await c.call("PUT", "/tenant/widget", { live: { enabled: true, hours: { tz: "Asia/Baku", days: closed } } })).status, 200);
  assert.equal((await cfg()).live, false);
  const r = await p.client().call("POST", `/widget/${key}/live`, { message: "salam" }, ORIGIN);
  assert.equal(r.status, 409); assert.equal(r.body.code, "OUTSIDE_HOURS");
  const open = Array(7).fill({ from: "00:00", to: "23:59" });
  assert.equal((await c.call("PUT", "/tenant/widget", { live: { enabled: true, hours: { tz: "Asia/Baku", days: open } } })).status, 200);
  assert.equal((await cfg()).live, true);
  assert.equal((await c.call("PUT", "/tenant/widget", { live: { enabled: true, hours: null } })).status, 200);
  assert.equal((await c.call("PUT", "/tenant/widget", { live: { enabled: true, hours: { tz: "Yox/Yer", days: open } } })).status, 400);
  const view = await c.call("GET", "/tenant/widget"); assert.equal(view.body.widget.live.enabled, true);
});

test("CSAT: yalnız bağlı söhbətdə, token sahibi, bir dəfə, 1-5; operator siyahıda orta bal görür", async () => {
  const { c, key } = await setup();
  const { v, id, token } = await startLive(key);
  const rate = (body: object) => v.call("POST", `/widget/${key}/live/${id}/csat`, body, ORIGIN);
  assert.equal((await rate({ token, rating: 5 })).status, 409, "söhbət hələ açıqdır");
  assert.equal((await c.call("POST", `/tenant/live/${id}/close`)).status, 200);
  assert.equal((await rate({ token: "yanlis", rating: 5 })).status, 404);
  for (const bad of [0, 6, 2.5, "5", null]) assert.equal((await rate({ token, rating: bad })).status, 400, String(bad));
  assert.equal((await rate({ token, rating: 4, comment: "Sağ olun\n<b>x</b>" })).status, 201);
  assert.equal((await rate({ token, rating: 1 })).status, 409, "ikinci dəfə olmaz");
  const closedList = await c.call("GET", "/tenant/live?status=closed");
  assert.equal(closedList.body.items[0].csat, 4); assert.deepEqual(closedList.body.csat, { count: 1, avg: 4 });
  assert.equal((await c.call("GET", `/tenant/live/${id}`)).body.chat.csat.rating, 4);
  assert.equal((await c.call("PUT", "/tenant/widget", { live: { enabled: true, csat: false } })).status, 200);
  assert.equal((await p.client().call("GET", `/widget/${key}/config`, undefined, ORIGIN)).body.csat, false);
});

test("proaktiv mesajlar: saxlanır, vidjet konfiqurasiyasına yalnız aktivdirsə düşür; səhv rədd olunur", async () => {
  const { c, key } = await setup();
  const cfg = async () => (await p.client().call("GET", `/widget/${key}/config`, undefined, ORIGIN)).body;
  assert.deepEqual((await cfg()).proactive, []);
  const put = await c.call("PUT", "/tenant/widget", { proactive: { enabled: true, rules: [{ text: "Kömək lazımdır?", delaySec: 15, match: "/products/*" }] } });
  assert.equal(put.status, 200); assert.equal(put.body.widget.proactive.rules.length, 1);
  const got = (await cfg()).proactive;
  assert.equal(got.length, 1); assert.equal(got[0].text, "Kömək lazımdır?"); assert.equal(got[0].delaySec, 15); assert.equal(got[0].match, "/products/*");
  const id = got[0].id;
  assert.equal((await c.call("PUT", "/tenant/widget", { proactive: { enabled: false, rules: put.body.widget.proactive.rules } })).status, 200);
  assert.deepEqual((await cfg()).proactive, []);
  assert.equal((await c.call("PUT", "/tenant/widget", { proactive: { enabled: true, rules: [{ id, text: "ab", delaySec: 15, match: "*" }] } })).status, 400);
});
