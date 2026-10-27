import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { startPortal } from "./helpers.js";

let p: Awaited<ReturnType<typeof startPortal>>;
before(async () => { p = await startPortal(); });
after(() => p.close());

const config = { businessName: "Kontakt", domain: "kontakt.az", profile: { mode: "support" }, source: { type: "rest" } };
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(200, 1)]);
let n = 0;
async function tenant() {
  const c = await p.signedIn(`th${++n}@example.com`);
  assert.equal((await c.call("POST", "/tenant", { config })).status, 201);
  const w = (await c.call("GET", "/tenant/widget")).body.widget;
  return { c, key: w.key as string };
}
const cfgOf = (key: string) => fetch(`${p.base}/widget/${key}/config`, { headers: { origin: "https://kontakt.az" } }).then((r) => r.json());

test("açılış rejimi: yoxlanır, saxlanır, ictimai konfiqdə görünür", async () => {
  const { c, key } = await tenant();
  assert.equal((await cfgOf(key)).theme, "light");
  assert.equal((await c.call("PUT", "/tenant/widget", { theme: "neon" })).status, 400);
  const ok = await c.call("PUT", "/tenant/widget", { theme: "auto" });
  assert.equal(ok.status, 200); assert.equal(ok.body.widget.theme, "auto");
  assert.equal((await cfgOf(key)).theme, "auto");
  assert.equal((await cfgOf(key)).bg, undefined, "fon rəngi artıq yoxdur");
});

test("loqo: PNG yüklənir, ictimai ünvandan düzgün başlıqlarla verilir, baytlar panelə qayıtmır, silinir", async () => {
  const { c, key } = await tenant();
  assert.equal((await fetch(`${p.base}/widget/${key}/logo`)).status, 404);
  const r = await c.call("PUT", "/tenant/widget/logo", { data: PNG.toString("base64") });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.match(r.body.widget.logoUrl, new RegExp(`/widget/${key}/logo\\?v=\\d+`)); assert.equal(r.body.widget.logo, undefined);
  assert.equal((await c.call("GET", "/tenant/widget")).body.widget.logo, undefined);
  const img = await fetch(`${p.base}/widget/${key}/logo`);
  assert.equal(img.status, 200); assert.equal(img.headers.get("content-type"), "image/png");
  assert.equal(img.headers.get("x-content-type-options"), "nosniff"); assert.match(img.headers.get("content-security-policy")!, /sandbox/);
  assert.equal(img.headers.get("cross-origin-resource-policy"), "cross-origin");
  assert.deepEqual(Buffer.from(await img.arrayBuffer()), PNG);
  assert.match((await cfgOf(key)).logo, /\/logo\?v=\d+/);
  assert.equal((await c.call("PUT", "/tenant/widget", { title: "Yeni" })).body.widget.logoUrl.includes("/logo"), true, "başqa ayar loqonu silməməlidir");
  assert.equal((await c.call("DELETE", "/tenant/widget/logo")).body.widget.logoUrl, null);
  assert.equal((await fetch(`${p.base}/widget/${key}/logo`)).status, 404);
});

test("loqo: SVG, səhv format və böyük fayl rədd olunur; söndürülmüş vidjetin loqosu verilmir", async () => {
  const { c, key } = await tenant();
  const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>').toString("base64");
  assert.equal((await c.call("PUT", "/tenant/widget/logo", { data: svg })).body.code, "LOGO_TYPE");
  assert.equal((await c.call("PUT", "/tenant/widget/logo", { data: "" })).status, 400);
  const big = Buffer.concat([PNG.subarray(0, 8), Buffer.alloc(110 * 1024)]).toString("base64");
  assert.equal((await c.call("PUT", "/tenant/widget/logo", { data: big })).body.code, "LOGO_TOO_LARGE");
  await c.call("PUT", "/tenant/widget/logo", { data: PNG.toString("base64") });
  await c.call("PUT", "/tenant/widget", { enabled: false });
  assert.equal((await fetch(`${p.base}/widget/${key}/logo`)).status, 404);
});
