// Telegram API müştərisi: bağlantı qırılanda (keep-alive bağlanıb) bir dəfə təkrar; ikinci dəfə də alınmasa səbəb kodu ilə xəta, URL/token yox.
import test from "node:test";
import assert from "node:assert/strict";
import { createTelegramApi } from "../src/telegram.js";

const netErr = () => Object.assign(new TypeError("fetch failed"), { cause: { code: "UND_ERR_SOCKET" } });
const ok = () => new Response(JSON.stringify({ ok: true, result: true }), { status: 200 });

test("şəbəkə xətası bir dəfə təkrarlanır və mesaj gedir", async () => {
  let n = 0;
  const api = createTelegramApi((async () => { if (n++ === 0) throw netErr(); return ok(); }) as typeof fetch);
  await api.sendMessage("123:SECRET", "1", "salam");
  assert.equal(n, 2);
});

test("iki dəfə alınmasa: səbəb kodu yazılır, token xətada görünmür; vaxt aşımı təkrarlanmır", async () => {
  let n = 0;
  const api = createTelegramApi((async () => { n++; throw netErr(); }) as typeof fetch);
  await assert.rejects(api.sendMessage("123:SECRET", "1", "x"), (e: Error) => /sendMessage, UND_ERR_SOCKET/.test(e.message) && !/SECRET/.test(e.message));
  assert.equal(n, 2);
  n = 0;
  const slow = createTelegramApi((async () => { n++; throw Object.assign(new Error("t"), { name: "TimeoutError" }); }) as typeof fetch);
  await assert.rejects(slow.sendMessage("1:A", "1", "x"), /TIMEOUT/);
  assert.equal(n, 1);
});
