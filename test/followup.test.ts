// Susan müştəriyə xatırlatma: vaxtı çatanda bir dəfə gedir, "sağ ol"dan sonra, operator söhbətində, söndürüləndə getmir.
import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { startPortal } from "./helpers.js";
import { conversationDone, dueFor, runFollowups } from "../src/followup.js";
import type { ChannelSession } from "../src/store/types.js";

let p: Awaited<ReturnType<typeof startPortal>>;
before(async () => { p = await startPortal(); });
after(() => p.close());

const HOUR = 60 * 60_000;
let n = 0;
/** Telegram qoşulmuş sahib + panel müştərisi */
async function owner() {
  const c = await p.signedIn(`fu${++n}@example.com`);
  assert.equal((await c.call("POST", "/tenant", { config: { businessName: "Mağaza", domain: `fu${n}.az`, source: { type: "rest" } } })).status, 201);
  assert.equal((await c.call("PUT", "/tenant/channels/telegram", { token: `${900500000 + n}:AAH${"x".repeat(32)}` })).status, 200);
  const t = (await p.store.findTenantByUser((await p.store.findUserByEmail(`fu${n}@example.com`))!.id))!;
  return { c, t };
}
const session = (tenantId: string, chatId: string, ago: number, history: ChannelSession["history"], extra: Partial<ChannelSession> = {}): ChannelSession =>
  ({ tenantId, channel: "telegram", chatId, sid: `s${chatId}`, history, updatedAt: new Date(Date.now() - ago), ...extra });
const asked = [{ role: "user" as const, text: "Qırmızı ayaqqabı var?" }, { role: "model" as const, text: "Bəli, 3 model var." }];

test("ayar: defolt söndürülüb, yalnız icazəli gecikmələr qəbul olunur", async () => {
  const { c } = await owner();
  assert.deepEqual((await c.call("GET", "/tenant/followup")).body.followup, { enabled: false, delayMin: 120 });
  assert.equal((await c.call("PUT", "/tenant/followup", { enabled: true, delayMin: 7 })).status, 400);
  assert.equal((await c.call("PUT", "/tenant/followup", { enabled: true, delayMin: 60, text: "x".repeat(301) })).status, 400);
  const ok = await c.call("PUT", "/tenant/followup", { enabled: true, delayMin: 60, text: "  Hələ maraqlanırsınız?  " });
  assert.deepEqual(ok.body.followup, { enabled: true, delayMin: 60, text: "Hələ maraqlanırsınız?" });
});

test("vaxtı çatan söhbətə bir dəfə xatırlatma gedir, tarixçəyə yazılır, təkrar getmir", async () => {
  const { c, t } = await owner();
  await c.call("PUT", "/tenant/followup", { enabled: true, delayMin: 120 });
  await p.store.saveChannelSession(session(t.tenantId, "111", 3 * HOUR, asked));
  await p.store.saveChannelSession(session(t.tenantId, "222", 30 * 60_000, asked)); // hələ tezdir
  const before = p.telegram.sent.length;
  assert.equal(await runFollowups(p.deps), 1);
  const msg = p.telegram.sent.at(-1)!;
  assert.equal(msg.chatId, "111");
  assert.match(msg.text, /Sualınız qaldımı/);
  const s = (await p.store.getChannelSession(t.tenantId, "telegram", "111"))!;
  assert.equal(s.history.at(-1)!.text, msg.text, "xatırlatma tarixçəyə düşür (AI konteksti bilsin)");
  assert.ok(s.followedUpAt);
  assert.equal(await runFollowups(p.deps), 0, "eyni sakitlik üçün ikinci dəfə getmir");
  assert.equal(p.telegram.sent.length, before + 1);
});

test("göndərilmir: söndürülüb, 'sağ ol' ilə bitib, operator söhbəti açıqdır, 23 saatdan köhnədir", async () => {
  const { c, t } = await owner();
  await p.store.saveChannelSession(session(t.tenantId, "301", 3 * HOUR, asked));
  assert.equal(await runFollowups(p.deps), 0, "ayar söndürülüb");
  await c.call("PUT", "/tenant/followup", { enabled: true, delayMin: 120 });
  await p.store.saveChannelSession(session(t.tenantId, "301", 3 * HOUR, [{ role: "user", text: "Qiymət?" }, { role: "model", text: "50 AZN" }, { role: "user", text: "Çox sağ ol!" }, { role: "model", text: "Buyurun!" }]));
  await p.store.saveChannelSession(session(t.tenantId, "302", 24 * HOUR, asked));
  await p.store.saveChannelSession(session(t.tenantId, "303", 3 * HOUR, asked));
  await p.store.createLive({ id: "live-303", tenantId: t.tenantId, tokenHash: "x", name: "", contact: "", status: "open", context: [], messages: [], createdAt: new Date(), updatedAt: new Date(), channel: { type: "telegram", chatId: "303" } });
  assert.equal(await runFollowups(p.deps), 0);
});

test("xüsusi mətn və müştərinin dili", async () => {
  const { c, t } = await owner();
  await c.call("PUT", "/tenant/followup", { enabled: true, delayMin: 60 });
  await p.store.saveChannelSession(session(t.tenantId, "401", 2 * HOUR, [{ role: "user", text: "Есть доставка?" }, { role: "model", text: "Да." }]));
  await runFollowups(p.deps);
  assert.match(p.telegram.sent.at(-1)!.text, /Остались вопросы/);
  await c.call("PUT", "/tenant/followup", { enabled: true, delayMin: 60, text: "Endirim bu gün bitir!" });
  await p.store.saveChannelSession(session(t.tenantId, "402", 2 * HOUR, asked));
  await runFollowups(p.deps);
  assert.equal(p.telegram.sent.at(-1)!.text, "Endirim bu gün bitir!");
});

test("yenidən yazan müştəri növbəti sakitlikdə yenə bir xatırlatma ala bilər", () => {
  const cfg = { enabled: true, delayMin: 60 };
  const old = new Date(Date.now() - 5 * HOUR);
  assert.equal(dueFor(session("t", "1", 2 * HOUR, asked, { followedUpAt: old }), cfg), true, "xatırlatmadan sonra yazıb, yenə susub");
  assert.equal(dueFor(session("t", "1", 2 * HOUR, asked, { followedUpAt: new Date() }), cfg), false);
  assert.equal(dueFor(session("t", "1", 2 * HOUR, asked, { pendingAction: { id: "a" } }), cfg), false, "BƏLİ/XEYR gözlənilir");
  assert.equal(conversationDone("tamam 👍"), true);
  assert.equal(conversationDone("tamam, bəs qiyməti?"), false);
});
