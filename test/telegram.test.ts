import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { AiError } from "../src/ai.js";
import { decryptSecret, encryptSecret } from "../src/secrets.js";
import { formatReply } from "../src/telegram-channel.js";
import { startPortal } from "./helpers.js";

let p: Awaited<ReturnType<typeof startPortal>>;
before(async () => { p = await startPortal(); });
after(() => p.close());

const config = { businessName: "Kontakt", domain: "kontakt.az", profile: { mode: "support" }, source: { type: "rest" } };
const TOKEN = (id: number) => `${900000000 + id}:AAH${"x".repeat(32)}`;
let n = 0, uid = 1000;
async function tenant() {
  const c = await p.signedIn(`tg${++n}@example.com`);
  assert.equal((await c.call("POST", "/tenant", { config })).status, 201);
  return c;
}
/** Botu qoşur, webhook ünvanı və gizli başlığı qaytarır. */
async function connect(c: Awaited<ReturnType<typeof tenant>>, botId = 100 + n) {
  const token = TOKEN(botId);
  const r = await c.call("PUT", "/tenant/channels/telegram", { token });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const hook = p.telegram.hooks.get(token)!;
  return { token, path: new URL(hook.url).pathname, secret: hook.secret, body: r.body };
}
const update = (path: string, secret: string, text: string | undefined, o: { chat?: number; type?: string; bot?: boolean; id?: number } = {}) =>
  fetch(p.base + path, {
    method: "POST", headers: { "content-type": "application/json", "x-telegram-bot-api-secret-token": secret },
    body: JSON.stringify({ update_id: o.id ?? ++uid, message: { ...(text !== undefined && { text }), chat: { id: o.chat ?? 777, type: o.type ?? "private" }, from: { first_name: "Ali", username: "ali", is_bot: o.bot ?? false } } }),
  });
const waitFor = async (cond: () => boolean, ms = 1500) => { const t0 = Date.now(); while (!cond() && Date.now() - t0 < ms) await new Promise((r) => setTimeout(r, 10)); return cond(); };
const sentFor = (token: string) => p.telegram.sent.filter((m) => m.token === token);
const chatCalls = () => p.ai.calls.filter((c) => c.fn === "chat");

test("secrets: şifrələmə geri açılır, yanlış açar və dəyişdirilmiş mətn rədd olunur", () => {
  const blob = encryptSecret("123:secret", "k".repeat(32));
  assert.ok(!blob.includes("123:secret"));
  assert.equal(decryptSecret(blob, "k".repeat(32)), "123:secret");
  assert.notEqual(encryptSecret("123:secret", "k".repeat(32)), blob, "hər dəfə fərqli iv");
  assert.throws(() => decryptSecret(blob, "z".repeat(32)));
  assert.throws(() => decryptSecret(blob.slice(0, -2) + "AA", "k".repeat(32)));
});

test("formatReply: elanlar, mənbələr və uzunluq", () => {
  const t = formatReply({ answer: "Tapdım", listings: [{ title: "Sonic", price: 139, currency: "AZN", url: "https://x.az/1" }, { title: "Bad", url: "javascript:alert(1)" }], sources: [{ title: "Çatdırılma", url: "https://x.az/c" }] });
  assert.match(t, /Tapdım/); assert.match(t, /• Sonic — 139 AZN\nhttps:\/\/x\.az\/1/); assert.match(t, /Mənbə: Çatdırılma https:\/\/x\.az\/c/);
  assert.ok(!t.includes("javascript:"));
  assert.ok(formatReply({ answer: "a".repeat(9000) }).length <= 3900);
});

test("panel: tenant olmadan 404, səhv token 400, tanınmayan token 400", async () => {
  const c = await p.signedIn(`tg${++n}@example.com`);
  assert.equal((await c.call("GET", "/tenant/channels/telegram")).status, 404);
  const t = await tenant();
  assert.equal((await t.call("PUT", "/tenant/channels/telegram", { token: "abc" })).status, 400);
  p.telegram.badToken = TOKEN(555);
  const bad = await t.call("PUT", "/tenant/channels/telegram", { token: TOKEN(555) });
  assert.equal(bad.status, 400); assert.match(bad.body.error, /Token yanlışdır/);
  assert.equal((await t.call("GET", "/tenant/channels/telegram")).body.connected, false);
  assert.equal((await p.client().call("GET", "/tenant/channels/telegram")).status, 401);
});

test("qoşmaq: webhook qurulur, token bazada şifrəli, cavabda token yoxdur", async () => {
  const c = await tenant();
  const k = await connect(c);
  assert.equal(k.body.connected, true); assert.equal(k.body.enabled, true); assert.match(k.body.botUsername, /^bot_/);
  assert.ok(!JSON.stringify(k.body).includes(k.token));
  assert.match(k.path, /^\/telegram\/[a-f0-9]{24}$/);
  assert.equal(p.telegram.hooks.get(k.token)!.url, `https://portal.test${k.path}`);
  const t = (await p.store.listTenants(100)).find((x) => x.domain === "kontakt.az" && x.telegram?.hook === k.path.split("/")[2])!;
  assert.ok(!JSON.stringify(t.telegram).includes(k.token), "token açıq saxlanmamalıdır");
  assert.equal(decryptSecret(t.telegram!.tokenEnc, "test-secret-key-test-secret-key-0000"), k.token);
});

test("eyni bot iki hesaba qoşula bilməz", async () => {
  const a = await tenant(), b = await tenant();
  await connect(a, 4242);
  const r = await b.call("PUT", "/tenant/channels/telegram", { token: TOKEN(4242) });
  assert.equal(r.status, 409);
});

test("webhook: yanlış gizli başlıq və ya ünvan 404, düzgün olanda mesaj cavablanır", async () => {
  const k = await connect(await tenant());
  assert.equal((await update(k.path, "wrong", "salam")).status, 404);
  assert.equal((await update("/telegram/" + "0".repeat(24), k.secret, "salam")).status, 404);
  assert.equal((await update("/telegram/bad", k.secret, "salam")).status, 404);
  assert.equal(sentFor(k.token).length, 0);
  p.ai.nextChat = { answer: "Salam, necə kömək edim?", listings: [], usage: { tokens: 5 } };
  assert.equal((await update(k.path, k.secret, "Salam")).status, 200);
  assert.ok(await waitFor(() => sentFor(k.token).length === 1));
  assert.equal(sentFor(k.token)[0]!.chatId, "777"); assert.equal(sentFor(k.token)[0]!.text, "Salam, necə kömək edim?");
  assert.ok(p.telegram.actions > 0, "yazır… göstəricisi");
});

test("tarixçə serverdə saxlanır və AI-yə ötürülür; /start sıfırlayır", async () => {
  const k = await connect(await tenant());
  p.ai.nextChat = { answer: "Cavab 1", listings: [] };
  await update(k.path, k.secret, "Sual 1");
  assert.ok(await waitFor(() => sentFor(k.token).length === 1));
  const before = chatCalls().length;
  p.ai.nextChat = { answer: "Cavab 2", listings: [] };
  await update(k.path, k.secret, "Sual 2");
  assert.ok(await waitFor(() => sentFor(k.token).length === 2));
  const last = chatCalls().at(-1)!.args as [string, string, { role: string; text: string }[], { sid?: string }];
  assert.equal(chatCalls().length, before + 1);
  assert.deepEqual(last[2], [{ role: "user", text: "Sual 1" }, { role: "model", text: "Cavab 1" }]);
  assert.match(last[3].sid ?? "", /^[a-f0-9]{24}$/);
  await update(k.path, k.secret, "/start");
  assert.ok(await waitFor(() => sentFor(k.token).length === 3));
  assert.match(sentFor(k.token)[2]!.text, /Salam!/);
  await update(k.path, k.secret, "Sual 3");
  assert.ok(await waitFor(() => sentFor(k.token).length === 4));
  assert.deepEqual((chatCalls().at(-1)!.args as unknown[][])[2], [], "/start-dan sonra tarixçə boşdur");
});

test("qrup söhbəti, bot mesajı, mətnsiz mesaj və təkrar yeniləmə", async () => {
  const k = await connect(await tenant());
  const calls = chatCalls().length;
  await update(k.path, k.secret, "salam", { type: "group", chat: 1 });
  await update(k.path, k.secret, "salam", { bot: true, chat: 2 });
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(sentFor(k.token).length, 0); assert.equal(chatCalls().length, calls);
  await update(k.path, k.secret, undefined, { chat: 3 });
  assert.ok(await waitFor(() => sentFor(k.token).length === 1));
  assert.match(sentFor(k.token)[0]!.text, /yalnız yazılı/);
  await update(k.path, k.secret, "eyni", { id: 5_000_001 }); await update(k.path, k.secret, "eyni", { id: 5_000_001 });
  await waitFor(() => chatCalls().length === calls + 1); await new Promise((r) => setTimeout(r, 80));
  assert.equal(chatCalls().length, calls + 1, "təkrar update_id bir dəfə emal olunur");
});

test("çox uzun mesaj AI-yə getmir", async () => {
  const k = await connect(await tenant());
  const calls = chatCalls().length;
  await update(k.path, k.secret, "a".repeat(501));
  assert.ok(await waitFor(() => sentFor(k.token).length === 1));
  assert.match(sentFor(k.token)[0]!.text, /çox uzundur/); assert.equal(chatCalls().length, calls);
});

test("cavab tapılmayanda kontakt istənir, telefon müraciətə çevrilir və sahibə e-poçt gedir", async () => {
  const c = await tenant();
  const k = await connect(c);
  p.ai.nextChat = { answer: "Bilmirəm", unanswered: true, listings: [] };
  await update(k.path, k.secret, "Zəmanəti uzatmaq olarmı?");
  assert.ok(await waitFor(() => sentFor(k.token).length === 1));
  assert.match(sentFor(k.token)[0]!.text, /telefon nömrənizi/);
  const mails = p.mails.length;
  await update(k.path, k.secret, "+994501234567");
  assert.ok(await waitFor(() => sentFor(k.token).length === 2));
  assert.match(sentFor(k.token)[1]!.text, /Təşəkkürlər/);
  const lead = p.ai.calls.filter((x) => x.fn === "kbAddLead").at(-1)!.args as [string, { name: string; contact: string; question: string }];
  assert.equal(lead[1].contact, "+994501234567"); assert.equal(lead[1].question, "Zəmanəti uzatmaq olarmı?"); assert.match(lead[1].name, /Ali/);
  assert.ok(await waitFor(() => p.mails.length > mails));
  assert.match(p.mails.at(-1)!.subject, /Telegram/);
});

test("kontakt gözlənilərkən adi sual gəlsə, sual kimi cavablanır (ilişmir)", async () => {
  const k = await connect(await tenant());
  p.ai.nextChat = { answer: "Bilmirəm", unanswered: true, listings: [] };
  await update(k.path, k.secret, "Çətin sual");
  assert.ok(await waitFor(() => sentFor(k.token).length === 1));
  const leads = p.ai.calls.filter((x) => x.fn === "kbAddLead").length;
  p.ai.nextChat = { answer: "Çatdırılma 2 gündür", listings: [] };
  await update(k.path, k.secret, "Çatdırılma neçə günə gəlir?");
  assert.ok(await waitFor(() => sentFor(k.token).length === 2));
  assert.equal(sentFor(k.token)[1]!.text, "Çatdırılma 2 gündür");
  assert.equal(p.ai.calls.filter((x) => x.fn === "kbAddLead").length, leads);
});

test("dəqiqəlik limit: 10-dan sonra bir xəbərdarlıq, AI çağırılmır", async () => {
  const k = await connect(await tenant());
  const calls = chatCalls().length;
  for (let i = 0; i < 14; i++) await update(k.path, k.secret, `sual ${i}`, { chat: 888 });
  await waitFor(() => sentFor(k.token).length >= 11);
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(chatCalls().length, calls + 10);
  const warns = sentFor(k.token).filter((m) => /Çox tez-tez/.test(m.text));
  assert.equal(warns.length, 1, "xəbərdarlıq spam olmur");
});

test("AI xətası: istifadəçiyə nəzakətli mesaj, 500-lər jurnala düşür, balans bitməsi (402) düşmür", async () => {
  const admin = await p.signedIn("boss@example.com");
  const k = await connect(await tenant());
  p.ai.failNext = new AiError(402, "balans bitib", "NO_BALANCE");
  await update(k.path, k.secret, "salam");
  assert.ok(await waitFor(() => sentFor(k.token).length === 1));
  assert.match(sentFor(k.token)[0]!.text, /hazırda cavab verə bilmir/);
  p.ai.failNext = new AiError(500, "model çökdü", "AI_ERROR");
  await update(k.path, k.secret, "salam 2");
  assert.ok(await waitFor(() => sentFor(k.token).length === 2));
  const errs = (await admin.call("GET", "/admin/errors?source=channel")).body;
  assert.equal(errs.groups.length, 1); assert.match(errs.groups[0].message, /model çökdü/);
});

test("söndürmək: mesajlara cavab verilmir; yenidən yandıranda işləyir", async () => {
  const c = await tenant();
  const k = await connect(c);
  assert.equal((await c.call("PATCH", "/tenant/channels/telegram", { enabled: "yes" })).status, 400);
  assert.equal((await c.call("PATCH", "/tenant/channels/telegram", { enabled: false })).body.enabled, false);
  await update(k.path, k.secret, "salam");
  await new Promise((r) => setTimeout(r, 80));
  assert.equal(sentFor(k.token).length, 0);
  await c.call("PATCH", "/tenant/channels/telegram", { enabled: true });
  await update(k.path, k.secret, "salam");
  assert.ok(await waitFor(() => sentFor(k.token).length === 1));
});

test("ayırmaq: webhook silinir, sessiyalar təmizlənir, köhnə ünvan 404 verir", async () => {
  const c = await tenant();
  const k = await connect(c);
  await update(k.path, k.secret, "salam");
  assert.ok(await waitFor(() => sentFor(k.token).length === 1));
  assert.equal((await c.call("DELETE", "/tenant/channels/telegram")).status, 200);
  assert.equal(p.telegram.hooks.has(k.token), false);
  assert.equal((await c.call("GET", "/tenant/channels/telegram")).body.connected, false);
  assert.equal((await update(k.path, k.secret, "salam")).status, 404);
});

test("hesab silinəndə botun webhook-u da götürülür", async () => {
  const c = await tenant();
  const k = await connect(c);
  const r = await c.call("POST", "/auth/delete-account", { password: "parol12345" });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(p.telegram.hooks.has(k.token), false);
});

test("CHANNEL_SECRET_KEY olmayanda bot qoşmaq 503 verir (portal yenə işləyir)", async () => {
  const q = await startPortal({ secretKey: "" });
  try {
    const c = await q.signedIn("nokey@example.com");
    assert.equal((await c.call("POST", "/tenant", { config })).status, 201);
    const r = await c.call("PUT", "/tenant/channels/telegram", { token: TOKEN(321) });
    assert.equal(r.status, 503);
    assert.equal((await c.call("GET", "/tenant/channels/telegram")).body.keyReady, false);
  } finally { await q.close(); }
});
