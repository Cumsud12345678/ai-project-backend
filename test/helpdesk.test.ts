// Operator helpdesk: daxili qeydlər, etiketlər, hazır cavablar, AI qaralaması, işçi saatları, CSAT.
import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { startPortal } from "./helpers.js";
import { matchPath, parseCanned, parseHours, campaignRunning, parseProactive, parseTags, withinHours } from "../src/helpdesk.js";

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
  // gecə növbəsi: yalnız cümə 22:00–02:00 (Bakı = UTC+4)
  const night = parseHours({ tz: "Asia/Baku", days: [null, null, null, null, null, { from: "22:00", to: "02:00" }, null] })!;
  assert.equal(withinHours(night, new Date("2026-10-30T18:30:00Z")), true, "cümə 22:30");
  assert.equal(withinHours(night, new Date("2026-10-30T21:30:00Z")), true, "şənbə 01:30 (cümə növbəsi)");
  assert.equal(withinHours(night, new Date("2026-10-30T22:00:00Z")), false, "şənbə 02:00 bitdi");
  assert.equal(withinHours(night, new Date("2026-10-30T17:00:00Z")), false, "cümə 21:00");
  assert.equal(withinHours(night, new Date("2026-10-23T21:30:00Z")), true, "əvvəlki şənbə 01:30");
  // bütün gün
  const all = parseHours({ tz: "Asia/Baku", days: [null, { from: "00:00", to: "00:00" }, null, null, null, null, null] })!;
  assert.equal(withinHours(all, new Date("2026-10-26T19:59:00Z")), true, "bazar ertəsi 23:59");
  assert.equal(withinHours(all, new Date("2026-10-26T20:00:00Z")), false, "çərşənbə axşamı 00:00");
  // 18:00-a qədər: 00:00 bitiş = gecə yarısı
  const eve = parseHours({ tz: "Asia/Baku", days: [null, { from: "18:00", to: "00:00" }, null, null, null, null, null] })!;
  assert.equal(withinHours(eve, new Date("2026-10-26T19:30:00Z")), true, "23:30");
  assert.equal(withinHours(eve, new Date("2026-10-26T20:10:00Z")), false, "çərşənbə axşamı 00:10");
  const ny = parseHours({ tz: "America/New_York", days: Array(7).fill({ from: "09:00", to: "17:00" }) })!;
  assert.equal(withinHours(ny, new Date("2026-10-28T14:00:00Z")), true, "10:00 Nyu-York");
  for (const bad of [{ tz: "Mars/Base", days: Array(7).fill(null) }, { tz: "Asia/Baku", days: [] }, { tz: "Asia/Baku", days: Array(7).fill(null) }, { tz: "Asia/Baku", days: Array(7).fill({ from: "9:00", to: "18:00" }) }, "x", 5])
    assert.throws(() => parseHours(bad), /İşçi saatları/, JSON.stringify(bad).slice(0, 50));
  assert.equal(parseHours(null), null);
});

test("proaktiv, hazır cavab və etiket doğrulaması", () => {
  const ok = parseProactive({ enabled: true, rules: [{ text: "Kömək lazımdır?", delaySec: 20, match: "/products/*, /" }] });
  assert.match(ok.rules[0]!.id, /^[a-f0-9]{8}$/);
  assert.deepEqual({ ...ok.rules[0], id: "" }, { id: "", text: "Kömək lazımdır?", delaySec: 20, match: "/products/*, /", active: true, audience: "all", device: "all", freq: "visit", online: false, startAt: null, endAt: null }, "köhnə qayda defoltlarla");
  const full = parseProactive({ enabled: true, rules: [{ name: "Geri qayıdanlar", title: "Xoş gəldin!", text: "Qaldığın yerdən davam edək?", delaySec: 0, match: "*", audience: "returning", device: "mobile", freq: "once", online: true, active: false,
    buttons: [{ label: "Söhbətə başla", kind: "chat" }, { label: "Sadəcə baxıram", kind: "close" }], startAt: "2026-12-01T00:00:00Z", endAt: "2026-12-31T00:00:00Z" }] }).rules[0]!;
  assert.equal(full.title, "Xoş gəldin!"); assert.equal(full.buttons!.length, 2); assert.equal(full.audience, "returning"); assert.equal(full.startAt, "2026-12-01T00:00:00.000Z");
  assert.equal(campaignRunning(full, true, new Date("2026-12-10")), false, "deaktiv");
  const on = { ...full, active: true };
  assert.equal(campaignRunning(on, true, new Date("2026-11-10")), false, "hələ başlamayıb");
  assert.equal(campaignRunning(on, true, new Date("2026-12-10")), true);
  assert.equal(campaignRunning(on, false, new Date("2026-12-10")), false, "operator onlayn deyil");
  assert.equal(campaignRunning(on, true, new Date("2027-01-02")), false, "bitib");
  const r1 = { text: "salam", delaySec: 10, match: "*" };
  for (const bad of [{ enabled: true, rules: Array(11).fill(r1) }, { enabled: true, rules: [{ ...r1, text: "ab" }] }, { enabled: true, rules: [{ ...r1, delaySec: 601 }] }, { enabled: true, rules: [{ ...r1, match: "<script>" }] }, { enabled: "yes", rules: [] }, { enabled: true, rules: [{ ...r1, text: "x".repeat(301) }] },
    { enabled: true, rules: [{ ...r1, audience: "vip" }] }, { enabled: true, rules: [{ ...r1, buttons: Array(4).fill({ label: "a", kind: "chat" }) }] }, { enabled: true, rules: [{ ...r1, buttons: [{ label: "", kind: "chat" }] }] },
    { enabled: true, rules: [{ ...r1, startAt: "2026-12-02", endAt: "2026-12-01" }] }, { enabled: true, rules: [{ ...r1, title: "x".repeat(41) }] }])
    assert.throws(() => parseProactive(bad), /Proaktiv|proactive|Gözləmə|şablonu|Ən çox|Kampaniya|düymə|Düymə|tarix|başlığı/, JSON.stringify(bad).slice(0, 80));
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

  // Kampaniya: başlıq/düymələr vidjetə gedir; deaktiv və "yalnız operator onlayn" (canlı söhbət söndürülüb) göstərilmir
  const rules = [
    { id, text: "Kömək lazımdır?", delaySec: 15, match: "*", title: "Salam!", buttons: [{ label: "Yaz", kind: "chat" }], audience: "returning", freq: "once" },
    { text: "Deaktiv", delaySec: 5, match: "*", active: false },
    { text: "Operator lazımdır?", delaySec: 5, match: "*", online: true },
  ];
  assert.equal((await c.call("PUT", "/tenant/widget", { live: { enabled: false }, proactive: { enabled: true, rules } })).status, 200);
  const live = (await cfg()).proactive;
  assert.equal(live.length, 1); assert.equal(live[0].title, "Salam!"); assert.equal(live[0].audience, "returning"); assert.equal(live[0].freq, "once"); assert.deepEqual(live[0].buttons, [{ label: "Yaz", kind: "chat" }]);
  // statistika: göstərildi, klik, söhbət; tanınmayan ID sayılmır
  const w = p.client();
  for (const ev of ["shown", "shown", "click", "chat"]) assert.equal((await w.call("POST", `/widget/${key}/campaign`, { id, ev }, ORIGIN)).status, 204);
  await w.call("POST", `/widget/${key}/campaign`, { id: "00000000", ev: "shown" }, ORIGIN);
  const st = (await c.call("GET", "/tenant/campaigns/stats")).body.stats;
  assert.deepEqual(st, { [id]: { shown: 2, clicked: 1, chats: 1 } });
  assert.equal((await c.call("DELETE", `/tenant/campaigns/${id}/stats`)).status, 200);
  assert.deepEqual((await c.call("GET", "/tenant/campaigns/stats")).body.stats, {});
});

test("kanal mesajlarının dili", async () => {
  const { chatLang, channelTexts } = await import("../src/channel-i18n.js");
  const t = (language?: string) => ({ config: language ? { profile: { language } } : {} }) as never;
  assert.equal(chatLang(t(), "salam"), "az");
  assert.equal(chatLang(t("en"), "привет"), "ru");
  assert.equal(chatLang(t("ru"), "maşın lazımdır, nə qiymətə?"), "az");
  assert.equal(chatLang(t("en"), "hello"), "en");
  assert.equal(chatLang(t("xx"), "hello"), "az");
  for (const l of ["az", "en", "ru", "tr"] as const) {
    const m = channelTexts(l, 500, 60);
    assert.match(m.tooLong, /500/); assert.match(m.voiceLong, /60/); assert.ok(m.live.offHours && m.live.on.includes("/bot"));
  }
});
