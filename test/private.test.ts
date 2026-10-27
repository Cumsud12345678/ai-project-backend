import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { startPortal } from "./helpers.js";

let p: Awaited<ReturnType<typeof startPortal>>;
before(async () => { p = await startPortal(); });
after(() => p.close());

const support = { businessName: "Magaza", domain: "magaza.az", email: "oz@example.com", profile: { language: "az", mode: "support" } };
let n = 0;
async function tenant() {
  const c = await p.signedIn(`pd${++n}@example.com`);
  assert.equal((await c.call("POST", "/tenant", { config: support })).status, 201);
  const w = await c.call("GET", "/tenant/widget");
  return { c, key: w.body.widget.key as string };
}

test("şəxsi məlumat marşrutları giriş tələb edir, sirr keşlənmir, AI servisinə öz tenantId ilə gedir", async () => {
  for (const [m, path] of [["GET", "/tenant/private-data"], ["PUT", "/tenant/private-data"], ["DELETE", "/tenant/private-data"], ["POST", "/tenant/private-data/identity-secret"], ["POST", "/tenant/private-data/test"]] as const)
    assert.equal((await p.client().call(m, path)).status, 401, `${m} ${path}`);
  const { c } = await tenant();
  assert.equal((await c.call("GET", "/tenant/private-data")).body.configured, false);
  const put = await c.call("PUT", "/tenant/private-data", { baseUrl: "https://api.magaza.az", apiSecret: "x" });
  assert.equal(put.status, 200);
  const call = p.ai.calls.filter((x) => x.fn === "setPrivateData").at(-1)!;
  assert.equal((call.args[1] as any).apiSecret, "x");
  const sec = await fetch(`${p.base}/tenant/private-data/identity-secret`, { method: "POST", headers: { cookie: c.cookie, origin: "http://localhost:3001" } });
  assert.equal(sec.status, 201); assert.equal(sec.headers.get("cache-control"), "no-store");
  assert.equal((await sec.json() as any).identitySecret, "cais_test");
  assert.equal((await c.call("POST", "/tenant/private-data/test", { kind: 5 })).status, 400);
});

test("vidjet: identity yalnız düzgün formatda AI servisinə ötürülür və 'invalid' cavabı qaytarılır", async () => {
  const { key } = await tenant();
  const orig = p.ai.chat;
  p.ai.chat = async (...a) => { p.ai.calls.push({ fn: "chat", args: a }); return { answer: "ok", identity: "invalid" }; };
  const send = (identity: unknown) => p.client().call("POST", `/widget/${key}/chat`, { message: "salam", identity }, { origin: "https://magaza.az" });
  try {
    const good = "v1.eyJzdWIiOiJhbGkifQ.abc-_123";
    const r = await send(good);
    assert.equal(r.status, 200); assert.equal(r.body.identity, "invalid");
    assert.equal((p.ai.calls.filter((x) => x.fn === "chat").at(-1)!.args[3] as any).identity, good);
    for (const bad of ["x", "v2.a.b", "v1.a", `v1.${"a".repeat(1100)}.b`, 5, { a: 1 }]) {
      await send(bad);
      assert.equal((p.ai.calls.filter((x) => x.fn === "chat").at(-1)!.args[3] as any).identity, undefined, String(bad).slice(0, 12));
    }
  } finally { p.ai.chat = orig; }
});
