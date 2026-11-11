// Kod yoxlamasında tapılan xətaların reqressiya testləri:
//  - təsdiqlənməmiş hesabın təkrar qeydiyyatla ələ keçirilməsi
//  - pulsuz sınağın hesabı silib yenidən açmaqla təkrar alınması
//  - AI servisində "yetim" müştərinin qalması
//  - vidjet ayarları yazılanda eyni anda yüklənən loqonun silinməsi
//  - admin sağlamlıq səhifəsində TRUST_PROXY yoxlaması
import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { startPortal } from "./helpers.js";
import { canonicalEmail } from "../src/trial.js";

let p: Awaited<ReturnType<typeof startPortal>>;
before(async () => { p = await startPortal(); });
after(() => p.close());

const config = { businessName: "Mağaza", domain: "magaza.az", source: { type: "rest" } };
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(32, 1)]).toString("base64");

test("təkrar qeydiyyat köhnə kodu ləğv edir: başqasının parolu ilə hesab təsdiqlənə bilməz", async () => {
  const victim = p.client(), attacker = p.client();
  const email = "qurban@example.com";
  assert.equal((await victim.call("POST", "/auth/register", { email, password: "qurbanparol1" })).status, 201);
  const victimCode = p.lastCode(email);
  // Təcavüzkar eyni e-poçtla təkrar qeydiyyat edir (parol onun parolu ilə əvəz olunur)
  assert.equal((await attacker.call("POST", "/auth/register", { email, password: "tecavuzkar1" })).status, 201);
  const newCode = p.lastCode(email);
  assert.notEqual(newCode, victimCode, "yeni kod göndərilir");
  // Qurbanın köhnə kodu artıq işləmir
  assert.equal((await victim.call("POST", "/auth/verify", { email, code: victimCode })).status, 400);
  assert.equal((await p.store.findUserByEmail(email))!.verified, false);
});

test("canonicalEmail: gmail nöqtələri və +etiket eyni e-poçt sayılır", () => {
  assert.equal(canonicalEmail("Ali.Veli+test@GMail.com"), "aliveli@gmail.com");
  assert.equal(canonicalEmail("ali.veli@googlemail.com"), "aliveli@gmail.com");
  assert.equal(canonicalEmail("ali.veli+x@firma.az"), "ali.veli@firma.az");
});

test("sınaq bir dəfə: hesab silinib eyni e-poçtla yenidən açılanda yeni müştəri noTrial ilə yaradılır", async () => {
  const email = "sinaq@gmail.com";
  const c1 = await p.signedIn(email);
  assert.equal((await c1.call("POST", "/tenant", { config })).status, 201);
  const first = p.ai.calls.filter((x) => x.fn === "createTenant").at(-1)!.args[0] as Record<string, unknown>;
  assert.equal(first.noTrial, undefined, "ilk dəfə sınaq verilir");
  assert.equal((await c1.call("POST", "/auth/delete-account", { password: "parol12345" })).status, 200);

  const c2 = await p.signedIn("si.naq+yeni@gmail.com"); // eyni gmail qutusu
  assert.equal((await c2.call("POST", "/tenant", { config })).status, 201);
  const second = p.ai.calls.filter((x) => x.fn === "createTenant").at(-1)!.args[0] as Record<string, unknown>;
  assert.equal(second.noTrial, true, "təkrar qeydiyyatda sınaq verilmir");
});

test("portal bazasına yazılmasa AI servisindəki müştəri silinir (yetim qalmır)", async () => {
  const c = await p.signedIn("yetim@example.com");
  const orig = p.store.createTenant;
  let attempted = "";
  p.store.createTenant = async (t) => { attempted = t.tenantId; throw new Error("db düşdü"); };
  const deletesBefore = p.ai.calls.filter((x) => x.fn === "deleteTenant").length;
  try { assert.equal((await c.call("POST", "/tenant", { config })).status, 500); }
  finally { p.store.createTenant = orig; }
  const deletes = p.ai.calls.filter((x) => x.fn === "deleteTenant");
  assert.equal(deletes.length, deletesBefore + 1, "deleteTenant bir dəfə çağırılır");
  assert.equal(deletes.at(-1)!.args[0], attempted, "məhz yaradılan müştəri silinir");
});

test("vidjet ayarlarının yazılması loqonu silmir (loqo ayrıca saxlanır)", async () => {
  const c = await p.signedIn("loqo@example.com");
  assert.equal((await c.call("POST", "/tenant", { config })).status, 201);
  await c.call("GET", "/tenant/widget");
  const t = await p.store.findTenantByUser((await p.store.findUserByEmail("loqo@example.com"))!.id);
  // Köhnə nüsxə (loqosuz) əlində olan sorğu ilə eyni anda loqo yüklənir
  assert.equal((await c.call("PUT", "/tenant/widget/logo", { data: PNG })).status, 200);
  await p.store.patchWidget(t!.tenantId, { ...t!.widget!, title: "Yeni başlıq" });
  assert.equal((await c.call("PUT", "/tenant/widget", { title: "Başqa başlıq" })).status, 200);
  const after = await p.store.findTenantByUser(t!.userId);
  assert.equal(after!.widget!.title, "Başqa başlıq");
  assert.ok(after!.widget!.logo?.data, "loqo yerində qalır");
  // Açarın yenilənməsi də loqonu silmir
  assert.equal((await c.call("POST", "/tenant/widget/rotate")).status, 200);
  assert.ok((await p.store.findTenantByUser(t!.userId))!.widget!.logo?.data);
});

test("admin sağlamlıq: backend-in gördüyü IP və TRUST_PROXY göstərilir", async () => {
  const admin = await p.signedIn("boss@example.com");
  const h = await admin.call("GET", "/admin/health");
  assert.equal(h.status, 200);
  assert.equal(typeof h.body.network.ip, "string");
  assert.equal(h.body.network.trustProxy, 1);
  assert.equal(h.body.network.privateIp, true, "testdə X-Forwarded-For 10.0.x.x-dir: daxili IP kimi işarələnir");
});
