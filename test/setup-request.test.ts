// Pulsuz qurulum: müştəri forma göndərir, admin xəbər alır, bir kliklə dəstək botu yaradılır, sahibə "hazırdır" e-poçtu gedir.
import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { startPortal } from "./helpers.js";
import { siteHost } from "../src/setup-request.js";

let p: Awaited<ReturnType<typeof startPortal>>;
before(async () => { p = await startPortal(); });
after(() => p.close());

/** Artıq qeydiyyatdan keçmiş hesabla daxil olur */
async function login(email: string) {
  const c = p.client();
  const r = await c.call("POST", "/auth/login", { email, password: "parol12345" });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return c;
}

const form = {
  businessName: "Gül Çiçək", website: "https://www.gulcicek.az/", phone: "+994 50 111 22 33", channels: ["whatsapp", "instagram", "site"],
  description: "Bakıda çiçək mağazası. Buketlər 25 AZN-dən başlayır, qızılgül buketi 45 AZN. Çatdırılma Bakı daxili 5 AZN, 2 saata. Hər gün 9:00-21:00.",
  salesScript: "Əvvəl büdcəni soruş, sonra 2 variant təklif et, sonda ünvan və vaxtı al.",
  faq: "Kartla ödəniş var? Bəli, kuryerə kartla ödəmək olar. Eyni gün çatdırılma? Bəli, saat 18:00-a qədər sifarişlərə.",
};

test("siteHost: sayt ünvanı domenə çevrilir, səhv ünvan boş qayıdır", () => {
  assert.equal(siteHost("https://www.Shop.az/elanlar"), "shop.az");
  assert.equal(siteHost("shop.com.az"), "shop.com.az");
  assert.equal(siteHost("instagram"), "");
});

test("forma yoxlanır və qəbul olunur: adminə xəbərdarlıq, müştəriyə təsdiq e-poçtu", async () => {
  const admin = await p.signedIn("boss@example.com"); void admin;
  const c = await p.signedIn("gul@example.com");
  assert.equal((await c.call("POST", "/setup-request", { ...form, description: "qısa" })).status, 400);
  assert.equal((await c.call("POST", "/setup-request", { ...form, phone: "12" })).status, 400);
  assert.equal((await c.call("POST", "/setup-request", { ...form, website: "bura sayt deyil" })).status, 400);
  const r = await c.call("POST", "/setup-request", form);
  assert.equal(r.status, 201);
  assert.deepEqual(r.body.request.channels, ["whatsapp", "site"], "dəstəklənməyən kanal atılır");
  assert.equal(r.body.request.status, "new");
  assert.ok(p.mails.some((m) => m.to === "gul@example.com" && m.subject.includes("qəbul olundu")));
  assert.ok(p.mails.some((m) => m.to === "boss@example.com" && m.subject.includes("Yeni qurulum sorğusu")), "adminə xəbər");
  // Yeni sorğu olduqca dəyişmək olur (təkrar xəbərdarlıq getmir)
  const adminMails = p.mails.filter((m) => m.to === "boss@example.com").length;
  assert.equal((await c.call("POST", "/setup-request", { ...form, phone: "+994502223344" })).status, 200);
  assert.equal(p.mails.filter((m) => m.to === "boss@example.com").length, adminMails);
  assert.equal((await c.call("GET", "/setup-request")).body.request.phone, "+994502223344");
});

test("admin siyahını görür, statusu dəyişir; işlənən sorğunu müştəri dəyişə bilmir", async () => {
  const admin = await login("boss@example.com");
  const list = await admin.call("GET", "/admin/setup-requests");
  assert.equal(list.status, 200);
  const item = list.body.items.find((x: { email: string }) => x.email === "gul@example.com");
  assert.ok(item);
  assert.equal(list.body.counts.new >= 1, true);
  assert.equal((await admin.call("PATCH", `/admin/setup-requests/${item.userId}`, { status: "in_progress", adminNote: "Zəng etdim" })).status, 200);
  const c = await login("gul@example.com");
  assert.equal((await c.call("POST", "/setup-request", form)).status, 409);
  assert.equal((await c.call("GET", "/admin/setup-requests")).status, 403, "adi istifadəçi admin siyahısını görmür");
});

test("bir kliklə qurulum: dəstək botu yaradılır, məlumat bilik bazasına düşür, sahibə 'hazırdır' gedir", async () => {
  const admin = await login("boss@example.com");
  const userId = (await p.store.findUserByEmail("gul@example.com"))!.id;
  const r = await admin.call("POST", `/admin/setup-requests/${userId}/build`);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.created, true);
  assert.equal(r.body.request.status, "done");
  const cfg = p.ai.calls.filter((x) => x.fn === "createTenant").at(-1)!.args[0] as { domain: string; profile: { mode: string; company: { phone: string; website: string }; extraInstructions: string } };
  assert.equal(cfg.domain, "gulcicek.az");
  assert.equal(cfg.profile.mode, "support");
  assert.equal(cfg.profile.company.website, "https://gulcicek.az");
  assert.match(cfg.profile.extraInstructions, /büdcəni soruş/);
  const texts = p.ai.calls.filter((x) => x.fn === "kbAddText").map((x) => x.args[1]);
  assert.deepEqual(texts, ["Biznes, məhsul və xidmətlər", "Tez-tez verilən suallar"]);
  assert.ok(await p.store.findTenantByUser(userId), "portal bazasında müştəri var");
  assert.ok(p.mails.some((m) => m.to === "gul@example.com" && m.subject.includes("hazırdır")));
  // Hesab artıq var: təkrar qurulum yeni bot yaratmır, yalnız bilik bazasına əlavə edir
  const c = await login("gul@example.com");
  assert.equal((await c.call("POST", "/setup-request", { ...form, description: form.description + " Yeni: toy buketləri 150 AZN." })).status, 201);
  const again = await admin.call("POST", `/admin/setup-requests/${userId}/build`);
  assert.equal(again.body.created, false);
});

test("komanda üzvü (operator) qurulum sorğusu göndərə bilmir", async () => {
  const owner = await p.signedIn("sahib@example.com");
  assert.equal((await owner.call("POST", "/tenant", { config: { businessName: "X", domain: "x-sahib.az", source: { type: "rest" } } })).status, 201);
  assert.equal((await owner.call("POST", "/tenant/team", { email: "op@example.com" })).status, 201);
  const op = await p.signedIn("op@example.com");
  assert.equal((await op.call("POST", "/setup-request", form)).status, 403);
});
