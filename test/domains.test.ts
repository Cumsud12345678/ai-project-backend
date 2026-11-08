// Domen nəzarəti: eyni sayt fərqli hesablarda, silinmiş hesab da görünür, blok yeni qeydiyyatı dayandırır, blok götürüləndə bərpa.
import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { domainHost, domainRoot } from "../src/domains.js";
import { resetAlerts } from "../src/alerts.js";
import { startPortal } from "./helpers.js";

let p: Awaited<ReturnType<typeof startPortal>>;
before(async () => { p = await startPortal(); resetAlerts(); });
after(() => p.close());

let n = 0;
let adminC: Awaited<ReturnType<typeof p.signedIn>> | undefined;
const admin = async () => (adminC ??= await p.signedIn("boss@example.com"));
async function site(domain: string) {
  const email = `dom${++n}@example.com`;
  const c = await p.signedIn(email);
  const r = await c.call("POST", "/tenant", { config: { businessName: `Sayt ${n}`, domain, source: { type: "rest" } } });
  return { c, email, r };
}
const wait = (ms = 40) => new Promise((r) => setTimeout(r, ms));

test("əsas domen: www, alt domen, protokol və ikinci səviyyəli zona", () => {
  assert.equal(domainHost("https://WWW.Shop.az:443/a?b"), "shop.az");
  assert.equal(domainRoot("m.shop.az"), "shop.az");
  assert.equal(domainRoot("a.b.shop.com.az"), "shop.com.az");
  assert.equal(domainRoot("shop.co.uk"), "shop.co.uk");
  assert.equal(domainRoot("localhost"), "localhost");
});

test("eyni domen ikinci hesabda: şübhəli siyahıda, silinmiş hesab da qalır; normaldır → siyahıdan çıxır", async () => {
  const a = await site("motosatis.az");
  assert.equal(a.r.status, 201);
  const b = await site("https://www.motosatis.az/");
  assert.equal(b.r.status, 201);
  await wait();
  const ad = await admin();
  let g = (await ad.call("GET", "/admin/domains?f=dup")).body;
  const grp = g.groups.find((x: { root: string }) => x.root === "motosatis.az");
  assert.ok(grp, JSON.stringify(g));
  assert.equal(grp.emails, 2);
  assert.ok(p.mails.some((m) => m.subject.includes("Eyni domen yeni hesabda: motosatis.az")), "adminə xəbər");
  assert.equal((await ad.call("GET", "/admin/overview")).body.domains.suspicious >= 1, true);

  // birinci hesab silinir, amma jurnalda qalır
  await p.deps.store.deleteTenant(a.r.body.tenant.tenantId);
  g = (await ad.call("GET", "/admin/domains?f=dup")).body;
  const after1 = g.groups.find((x: { root: string }) => x.root === "motosatis.az");
  assert.ok(after1.accounts.some((x: { email: string; deleted: boolean }) => x.email === a.email && x.deleted), JSON.stringify(after1));

  assert.equal((await ad.call("POST", "/admin/domains/ok", { domain: "motosatis.az" })).status, 200);
  g = (await ad.call("GET", "/admin/domains?f=dup")).body;
  assert.ok(!g.groups.some((x: { root: string }) => x.root === "motosatis.az"), "normaldır → şübhəlidə yoxdur");
  // yeni hesab gələndə yenidən şübhəli
  assert.equal((await site("motosatis.az")).r.status, 201);
  await wait();
  g = (await ad.call("GET", "/admin/domains?f=dup")).body;
  assert.ok(g.groups.some((x: { root: string }) => x.root === "motosatis.az"));
});

test("blok: mövcud hesablar dayandırılır, yeni qeydiyyat və domen dəyişikliyi rədd olunur; blok götürüləndə bərpa", async () => {
  const a = await site("spamshop.az");
  const other = await site("legit-shop.az");
  const ad = await admin();
  assert.equal((await ad.call("POST", "/admin/domains/block", { domain: "www.spamshop.az", reason: "x" })).status, 400, "səbəb qısadır");
  const blk = await ad.call("POST", "/admin/domains/block", { domain: "www.spamshop.az", reason: "Pulsuz balans sui-istifadəsi", suspend: true });
  assert.equal(blk.status, 200, JSON.stringify(blk.body));
  assert.deepEqual(blk.body.block.suspended, [a.r.body.tenant.tenantId]);
  assert.ok((await p.deps.store.findTenantById(a.r.body.tenant.tenantId))?.suspended);
  assert.equal((await ad.call("POST", "/admin/domains/block", { domain: "spamshop.az", reason: "təkrar" })).status, 409);

  const c = await site("m.spamshop.az");
  assert.equal(c.r.status, 403); assert.equal(c.r.body.code, "DOMAIN_BLOCKED");
  const ch = await other.c.call("PUT", "/tenant/config", { config: { businessName: "X", domain: "spamshop.az", source: { type: "rest" } } });
  assert.equal(ch.status, 403, "domeni bloklanmış domenə dəyişmək olmur");
  assert.equal((await ad.call("GET", "/admin/domains?f=blocked")).body.groups[0].root, "spamshop.az");

  const un = await ad.call("POST", "/admin/domains/unblock", { domain: "spamshop.az" });
  assert.equal(un.status, 200); assert.equal(un.body.restored, 1);
  assert.equal((await p.deps.store.findTenantById(a.r.body.tenant.tenantId))?.suspended ?? null, null);
  assert.equal((await site("spamshop.az")).r.status, 201, "blok götürüldü");
  // operator/adi istifadəçi görə bilmir
  assert.equal((await other.c.call("GET", "/admin/domains")).status, 403);
});
