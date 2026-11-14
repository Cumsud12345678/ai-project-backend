// Kanal sağlamlığı: Telegram tokeni ləğv olunanda saatlıq yoxlama xətanı qeyd edir və sahibə bir dəfə xəbər verir; düzələndə xəta silinir.
import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { startPortal } from "./helpers.js";
import { checkTelegramBots } from "../src/channel-health.js";

let p: Awaited<ReturnType<typeof startPortal>>;
before(async () => { p = await startPortal(); });
after(() => p.close());

test("Telegram tokeni etibarsız: xəta paneldə görünür, sahibə bir dəfə məktub; token işləyəndə xəta silinir", async () => {
  const c = await p.signedIn("health@example.com");
  assert.equal((await c.call("POST", "/tenant", { config: { businessName: "Kitab Evi", domain: "kitab.az", profile: { mode: "support" }, source: { type: "rest" } } })).status, 201);
  const token = `93000777000:AAH${"h".repeat(32)}`;
  assert.equal((await c.call("PUT", "/tenant/channels/telegram", { token })).status, 200);
  assert.equal(await checkTelegramBots(p.deps), 0);
  p.telegram.badToken = token;
  const m0 = p.mails.length;
  assert.equal(await checkTelegramBots(p.deps), 1);
  assert.equal(await checkTelegramBots(p.deps), 1);
  const sent = p.mails.slice(m0).filter((m) => /Telegram bağlantısı kəsildi: Kitab Evi/.test(m.subject));
  assert.equal(sent.length, 1, "gündə bir dəfə");
  assert.match((await c.call("GET", "/tenant/channels/telegram")).body.error, /token/i);
  p.telegram.badToken = undefined;
  assert.equal(await checkTelegramBots(p.deps), 0);
  assert.equal((await c.call("GET", "/tenant/channels/telegram")).body.error, null);
});
