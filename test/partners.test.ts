// Partnyor proqramı: kod, qeydiyyatda bağlanma, real ödənişdən komissiya (bonus/hədiyyə sayılmır), 12 ay pəncərəsi,
// yeni müştəri bonusu (bir dəfə), admin düzəlişi və ödənişi, partnyor səhifəsi.
import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { resetPartnerSync, syncPartners } from "../src/partners.js";
import { startPortal } from "./helpers.js";

let p: Awaited<ReturnType<typeof startPortal>>;
before(async () => { p = await startPortal(); p.ai.payments = {}; });
after(() => p.close());

let adminClient: Awaited<ReturnType<typeof p.signedIn>> | undefined;
const admin = async () => (adminClient ??= await p.signedIn("boss@example.com"));
const iso = (daysAgo: number) => new Date(Date.now() - daysAgo * 86_400_000).toISOString();
const bonusCalls = () => p.ai.calls.filter((c) => c.fn === "billingBonusReplies").map((c) => c.args);

/** Qeydiyyat (kodla) → təsdiq → sayt yaradılır */
async function signupWith(email: string, ref: string | undefined, refSource: "link" | "code" = "code") {
  const c = p.client();
  const r = await c.call("POST", "/auth/register", { email, password: "parol12345", ...(ref !== undefined && { ref, refSource }) });
  if (r.status !== 201) return { r, c, tenantId: "" };
  const code = p.lastCode(email);
  await c.call("POST", "/auth/verify", { email, code });
  const t = await c.call("POST", "/tenant", { config: { businessName: `Sayt ${email.split("@")[0]}`, domain: `${email.split("@")[0]}.az`, profile: { language: "az", mode: "support" } } });
  return { r, c, tenantId: t.body.tenant.tenantId as string };
}

let partnerId = "";
let partner: Awaited<ReturnType<typeof p.signedIn>>;

test("admin partnyor təyin edir: yalnız təsdiqlənmiş hesab, kod unikal, faiz 1–50", async () => {
  const a = await admin();
  partner = await p.signedIn("dost@example.com");
  assert.equal((await partner.call("GET", "/partner")).status, 403, "hələ partnyor deyil");
  assert.equal((await a.call("POST", "/admin/partners", { email: "yoxdur@example.com" })).body.code, "USER_NOT_FOUND");
  assert.equal((await a.call("POST", "/admin/partners", { email: "dost@example.com", code: "x" })).body.code, "BAD_CODE");
  assert.equal((await a.call("POST", "/admin/partners", { email: "dost@example.com", rate: 80 })).body.code, "BAD_RATE");
  const ok = await a.call("POST", "/admin/partners", { email: "dost@example.com", code: "adil", rate: 15 });
  assert.equal(ok.status, 201, JSON.stringify(ok.body));
  assert.equal(ok.body.code, "ADIL", "böyük hərflə");
  partnerId = ok.body.id;
  await p.signedIn("dost2@example.com");
  assert.equal((await a.call("POST", "/admin/partners", { email: "dost2@example.com", code: "Adil" })).body.code, "CODE_TAKEN");
  assert.equal((await partner.call("GET", "/auth/me")).body.partner.code, "ADIL");
  assert.equal((await p.signedIn("plain@example.com").then((c) => c.call("GET", "/admin/partners"))).status, 403);
});

test("qeydiyyat: kod yoxlanır; səhv yazılmış kod xəta verir, köhnə link səssizcə keçir", async () => {
  const chk = await p.client().call("GET", "/auth/ref/adil");
  assert.equal(chk.body.valid, true); assert.equal(chk.body.bonusReplies, 200);
  assert.equal((await p.client().call("GET", "/auth/ref/YOXDUR")).body.valid, false);
  const bad = await p.client().call("POST", "/auth/register", { email: "sehv@example.com", password: "parol12345", ref: "YOXDUR", refSource: "code" });
  assert.equal(bad.body.code, "BAD_REF_CODE");
  const link = await signupWith("kohne@example.com", "YOXDUR", "link");
  assert.equal(link.r.status, 201);
  assert.equal((await p.store.findUserByEmail("kohne@example.com"))!.referredBy, undefined);
  const self = await p.client().call("POST", "/auth/register", { email: "dost@example.com", password: "parol12345", ref: "ADIL", refSource: "code" });
  assert.notEqual(self.status, 201, "partnyor öz kodu ilə yeni hesab aça bilməz (eyni e-poçt)");
});

test("komissiya: yalnız real ödənişlərdən, partnyorun faizi ilə, bir dəfə; bonus ilk ödənişdə bir dəfə və komissiya yaratmır", async () => {
  const m = await signupWith("musteri1@example.com", "adil", "link");
  assert.equal(m.r.status, 201);
  const u = (await p.store.findUserByEmail("musteri1@example.com"))!;
  assert.equal(u.referredBy?.code, "ADIL"); assert.equal(u.referredBy?.source, "link");

  // Ödəniş yoxdur: heç nə
  resetPartnerSync();
  assert.deepEqual(await syncPartners(p.deps), { commissions: 0, bonuses: 0 });

  // İki real ödəniş (bonus/hədiyyə AI tərəfdə "manual" sayılır və bu siyahıya düşmür)
  p.ai.payments![m.tenantId] = [{ id: "req:a1", at: iso(-0.001), amountAzn: 20 }, { id: "pay:x:2", at: iso(-0.002), amountAzn: 100 }];
  const r1 = await syncPartners(p.deps);
  assert.deepEqual(r1, { commissions: 2, bonuses: 1 });
  const bonus = bonusCalls().find((x) => (x[1] as { ref?: string }).ref === `partner:${u.id}`);
  assert.ok(bonus, "bonus verildi");
  assert.equal((bonus![1] as { replies: number }).replies, 200, "ilk ödənişdən sonra +200 cavab");
  assert.equal((bonus![0] as string), m.tenantId);
  assert.ok(p.mails.some((x) => x.to === "dost@example.com" && /Yeni qazanc: \+3\.00 AZN/.test(x.subject)), "partnyora qazanc e-poçtu");

  const again = await syncPartners(p.deps);
  assert.deepEqual(again, { commissions: 0, bonuses: 0 }, "təkrar sinxron heç nə yazmır");

  const t = (await p.store.partnerTotals([partnerId]))[partnerId]!;
  assert.equal(t.earned, 18, "(20 + 100) × 15% = 18");
  assert.equal(t.balance, 18);
});

test("bonus bir dəfə; 12 aydan sonrakı ödəniş sayılmır; admin bağlayanda bonus yoxdur, keçmiş ödənişlər istəyə görə", async () => {
  const m = await signupWith("musteri2@example.com", "ADIL");
  const u = (await p.store.findUserByEmail("musteri2@example.com"))!;
  p.ai.payments![m.tenantId] = [{ id: "req:b1", at: iso(-0.001), amountAzn: 200 }, { id: "req:b2", at: iso(-400), amountAzn: 50 }];
  await syncPartners(p.deps);
  assert.equal(bonusCalls().filter((x) => (x[1] as { ref?: string }).ref === `partner:${u.id}`).length, 1, "bonus bir dəfə");
  const by = await p.store.partnerTotalsByCustomer(partnerId);
  assert.equal(by[u.id]!.base, 200, "400 gün sonrakı ödəniş pəncərədən kənardır");

  // Admin köhnə müştərini bağlayır: keçmiş ödənişlər daxil
  const old = await signupWith("kohnemusteri@example.com", undefined);
  p.ai.payments![old.tenantId] = [{ id: "req:c1", at: iso(-0.001), amountAzn: 40 }];
  const a = await admin();
  const att = await a.call("POST", "/admin/partners/referrals", { email: "kohnemusteri@example.com", code: "adil", countPast: true });
  assert.equal(att.status, 200, JSON.stringify(att.body));
  const oldU = (await p.store.findUserByEmail("kohnemusteri@example.com"))!;
  assert.equal(oldU.referredBy?.source, "admin");
  assert.equal((await p.store.partnerTotalsByCustomer(partnerId))[oldU.id]!.base, 40);
  assert.ok(!bonusCalls().some((x) => (x[1] as { ref?: string }).ref === `partner:${oldU.id}`), "admin bağlayanda bonus yoxdur");
  assert.equal((await a.call("POST", "/admin/partners/referrals", { email: "kohnemusteri@example.com", code: "adil" })).status, 200);
  assert.equal((await a.call("POST", "/admin/partners/referrals", { email: "dost@example.com", code: "adil" })).body.code, "SELF_REFERRAL");
  // Ayırmaq
  assert.equal((await a.call("POST", "/admin/partners/referrals", { email: "kohnemusteri@example.com", code: "" })).status, 200);
  assert.equal((await p.store.findUserByEmail("kohnemusteri@example.com"))!.referredBy, null);
});

test("söndürülmüş partnyora yeni komissiya yazılmır; faiz dəyişəndə yeni ödənişlərə tətbiq olunur", async () => {
  const a = await admin();
  await a.call("PATCH", `/admin/partners/${partnerId}`, { active: false });
  const m = await signupWith("musteri3@example.com", "ADIL", "link");
  assert.equal((await p.store.findUserByEmail("musteri3@example.com"))!.referredBy, undefined, "söndürülmüş kod qeydiyyatda qəbul olunmur");
  const u2 = (await p.store.findUserByEmail("musteri1@example.com"))!;
  const t1 = (await p.store.findTenantsByUserIds([u2.id]))[0]!.tenantId;
  p.ai.payments![t1]!.push({ id: "req:a3", at: iso(-0.003), amountAzn: 10 });
  assert.equal((await syncPartners(p.deps)).commissions, 0);
  await a.call("PATCH", `/admin/partners/${partnerId}`, { active: true, rate: 20 });
  assert.equal((await syncPartners(p.deps)).commissions, 1);
  const last = (await p.store.listPartnerEntries(partnerId, 1))[0]!;
  assert.equal(last.rate, 20); assert.equal(last.amountAzn, 2);
  void m;
});

test("admin balansı dəyişir: səbəb məcburidir; ödəniş balansdan çox ola bilməz; partnyor görür, amma dəyişə bilmir", async () => {
  const a = await admin();
  const before = (await p.store.partnerTotals([partnerId]))[partnerId]!.balance;
  assert.equal((await a.call("POST", `/admin/partners/${partnerId}/entries`, { kind: "adjust", amountAzn: 5 })).body.code, "REASON_REQUIRED");
  assert.equal((await a.call("POST", `/admin/partners/${partnerId}/entries`, { kind: "adjust", amountAzn: -3, note: "qaytarılan ödəniş" })).status, 200);
  assert.equal((await a.call("POST", `/admin/partners/${partnerId}/entries`, { kind: "payout", amountAzn: 9999 })).body.code, "OVER_BALANCE");
  const pay = await a.call("POST", `/admin/partners/${partnerId}/entries`, { kind: "payout", amountAzn: 10, note: "Kartla ödədim" });
  assert.equal(pay.status, 200);
  assert.equal(pay.body.totals.balance, Math.round((before - 3 - 10) * 100) / 100);
  assert.equal(pay.body.totals.paidOut, 10);

  const mine = await partner.call("GET", "/partner");
  assert.equal(mine.status, 200);
  assert.equal(mine.body.partner.code, "ADIL");
  assert.match(mine.body.link, /\/r\/ADIL$/);
  assert.equal(mine.body.totals.balance, pay.body.totals.balance);
  assert.ok(mine.body.customers.length >= 2);
  assert.match(mine.body.customers[0].email, /^\w{2}\*\*\*@/, "e-poçt gizlədilir");
  assert.ok(mine.body.entries.some((e: any) => e.kind === "payout" && e.amountAzn === -10));
  assert.equal((await partner.call("POST", `/admin/partners/${partnerId}/entries`, { kind: "adjust", amountAzn: 100, note: "özümə" })).status, 403);

  const detail = await a.call("GET", `/admin/partners/${partnerId}`);
  assert.ok(detail.body.customers.some((c: any) => c.email === "musteri1@example.com"));
  const list = await a.call("GET", "/admin/partners");
  assert.equal(list.body.partners[0].code, "ADIL");
  assert.ok((await a.call("GET", "/admin/audit?action=partner.")).body.items.some((x: any) => x.action === "partner.payout"));
});

test("proqram ayarları: hədlər daxilində saxlanır", async () => {
  const a = await admin();
  const s = await a.call("PUT", "/admin/partners/settings", { defaultRate: 99, bonusReplies: 0, months: 6 });
  assert.equal(s.body.defaultRate, 50); assert.equal(s.body.bonusReplies, 0); assert.equal(s.body.months, 6);
  assert.equal((await p.client().call("GET", "/auth/ref/ADIL")).body.bonusReplies, 0);
  assert.equal((await a.call("PUT", "/admin/partners/settings", { bonusReplies: 99999 })).body.bonusReplies, 5000);
  await a.call("PUT", "/admin/partners/settings", { defaultRate: 10, bonusReplies: 200, months: 12 });
});
