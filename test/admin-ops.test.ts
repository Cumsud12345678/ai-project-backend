import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { AiError } from "../src/ai.js";
import { fingerprint, loggedMailer, redact } from "../src/errorlog.js";
import { createMemoryStore } from "../src/store/memory.js";
import { startPortal } from "./helpers.js";

describe("xəta jurnalı və admin əməliyyatları", () => {
  let p: Awaited<ReturnType<typeof startPortal>>;
  let admin: Awaited<ReturnType<typeof p.signedIn>>;
  let user: Awaited<ReturnType<typeof p.signedIn>>;
  before(async () => { p = await startPortal(); admin = await p.signedIn("boss@example.com"); user = await p.signedIn("plain@example.com"); });
  after(() => p.close());

  it("redact: e-poçt, açar və tokenlər silinir", () => {
    const out = redact("fail for a@b.com with Bearer abcdefgh12345678 key ca_live_abcdefghijk password=hunter2 hex " + "a".repeat(40));
    assert.ok(!out.includes("a@b.com") && !out.includes("abcdefgh12345678") && !out.includes("ca_live_abcdefghijk") && !out.includes("hunter2") && !out.includes("a".repeat(40)));
  });

  it("fingerprint: rəqəmlər fərqli olsa da eyni xəta qruplaşır", () => {
    assert.equal(fingerprint("api", "Timeout after 31 ms", "/tenant/kb/12"), fingerprint("api", "Timeout after 977 ms", "/tenant/kb/99"));
    assert.notEqual(fingerprint("api", "Timeout", "/a"), fingerprint("ai", "Timeout", "/a"));
  });

  it("adi istifadəçi xəta jurnalına və admin API-lərinə baxa bilmir", async () => {
    for (const path of ["/admin/errors", "/admin/overview", "/admin/health", "/admin/audit", "/admin/announcement", "/admin/users.csv"]) {
      assert.equal((await user.call("GET", path)).status, 403, path);
    }
    assert.equal((await user.call("DELETE", "/admin/errors")).status, 403);
  });

  it("gözlənilməz xəta 500 qaytarır və jurnala yazılır, təkrarlar qruplaşır", async () => {
    for (let i = 0; i < 2; i++) {
      p.ai.failNext = new Error(`boom ${i} for x@y.com`) as AiError;
      assert.equal((await admin.call("GET", "/admin/usage")).status, 500);
    }
    const r = await admin.call("GET", "/admin/errors?range=1d");
    assert.equal(r.status, 200);
    assert.equal(r.body.total, 2);
    assert.equal(r.body.groups.length, 1);
    const g = r.body.groups[0];
    assert.equal(g.count, 2); assert.equal(g.source, "api"); assert.equal(g.status, 500);
    assert.ok(!g.message.includes("x@y.com"), "e-poçt gizlədilməlidir");
    assert.equal(g.path, "/admin/usage");
  });

  it("AI servisi xətası ai mənbəsi ilə yazılır, müştəri xətası (402) yazılmır", async () => {
    p.ai.failNext = new AiError(500, "model çökdü", "AI_ERROR");
    assert.equal((await admin.call("GET", "/admin/usage")).status, 502);
    p.ai.failNext = new AiError(402, "balans bitib", "NO_BALANCE");
    await admin.call("GET", "/admin/usage");
    const r = await admin.call("GET", "/admin/errors?source=ai");
    assert.equal(r.body.groups.length, 1);
    assert.match(r.body.groups[0].message, /model çökdü/);
  });

  it("panelin brauzer xətası qəbul olunur (girişsiz də), süzgəc və axtarış işləyir", async () => {
    const anon = p.client();
    const post = await anon.call("POST", "/client-errors", { message: "Cannot read properties of undefined", stack: "at X (a.js:1)", page: "/dashboard" });
    assert.equal(post.status, 204);
    assert.equal((await anon.call("POST", "/client-errors", { message: "" })).status, 204); // boş mesaj yazılmır
    const r = await admin.call("GET", "/admin/errors?source=client");
    assert.equal(r.body.groups.length, 1);
    assert.equal(r.body.groups[0].path, "/dashboard");
    const q = await admin.call("GET", "/admin/errors?q=undefined");
    assert.equal(q.body.groups.length, 1);
    assert.equal((await admin.call("GET", "/admin/errors?q=yoxdurbelə")).body.groups.length, 0);
    assert.ok(r.body.bySource.api >= 2 && r.body.bySource.client === 1);
  });

  it("client-errors IP üzrə limitlidir", async () => {
    const anon = p.client();
    for (let i = 0; i < 25; i++) await anon.call("POST", "/client-errors", { message: `spam ${i}` });
    const r = await admin.call("GET", "/admin/errors?q=spam");
    assert.ok(r.body.total <= 20, `limitdən çox yazıldı: ${r.body.total}`);
  });

  it("qrupu silmək və hamısını təmizləmək işləyir, audit-ə yazılır", async () => {
    const before = await admin.call("GET", "/admin/errors");
    const fp = before.body.groups.find((g: any) => g.source === "api").fingerprint as string;
    const del = await admin.call("DELETE", `/admin/errors?fingerprint=${fp}`);
    assert.equal(del.body.deleted, 2);
    assert.ok(!(await admin.call("GET", "/admin/errors")).body.groups.some((g: any) => g.fingerprint === fp));
    assert.equal((await admin.call("DELETE", "/admin/errors")).status, 200);
    assert.equal((await admin.call("GET", "/admin/errors")).body.total, 0);
    const actions = (await admin.call("GET", "/admin/audit")).body.items.map((i: any) => i.action);
    assert.ok(actions.includes("errors.delete_group") && actions.includes("errors.clear"));
  });

  it("overview və health", async () => {
    const o = await admin.call("GET", "/admin/overview");
    assert.equal(o.status, 200);
    assert.equal(o.body.users.total, 2);
    assert.equal(o.body.users.verified, 2);
    assert.equal(o.body.users.admins, 1);
    assert.equal(o.body.signups.length, 30);
    assert.equal(o.body.signups.reduce((s: number, x: any) => s + x.users, 0), 2);
    assert.ok(o.body.pendingTopups >= 1);
    assert.equal(typeof o.body.errors.last24h, "number");
    const h = await admin.call("GET", "/admin/health");
    assert.equal(h.body.database.ok, true); assert.equal(h.body.ai.ok, true);
    assert.equal(h.body.mail.configured, false);
    assert.ok(h.body.server.uptimeSec >= 0);
  });

  it("health: AI servisi çöküb → ok:false, səhifə yenə cavab verir", async () => {
    p.ai.failNext = new AiError(502, "yoxdur", "AI_UNREACHABLE");
    const h = await admin.call("GET", "/admin/health");
    assert.equal(h.status, 200); assert.equal(h.body.ai.ok, false); assert.equal(h.body.database.ok, true);
  });

  it("elan: admin təyin edir, giriş etmiş istifadəçi görür, gizlədəndə yox olur", async () => {
    assert.equal((await user.call("GET", "/announcement")).body.announcement, null);
    assert.equal((await admin.call("PUT", "/admin/announcement", { text: "  " })).status, 400);
    const put = await admin.call("PUT", "/admin/announcement", { text: "Bu gecə 02:00-da texniki işlər", level: "warn" });
    assert.equal(put.status, 200);
    const seen = await user.call("GET", "/announcement");
    assert.deepEqual(seen.body.announcement, { text: "Bu gecə 02:00-da texniki işlər", level: "warn" });
    assert.equal((await p.client().call("GET", "/announcement")).body.announcement, null, "girişsiz görməməlidir");
    await admin.call("PUT", "/admin/announcement", { text: "Bu gecə 02:00-da texniki işlər", active: false });
    assert.equal((await user.call("GET", "/announcement")).body.announcement, null);
    await admin.call("DELETE", "/admin/announcement");
    assert.equal((await admin.call("GET", "/admin/announcement")).body.announcement, null);
  });

  it("admin əməliyyatları audit jurnalına düşür", async () => {
    await admin.call("POST", "/admin/tenants/nope/rotate-key"); // 404: yazılmamalıdır
    await admin.call("POST", "/admin/billing/requests/r1/approve");
    const a = (await admin.call("GET", "/admin/audit")).body.items;
    assert.ok(a.some((i: any) => i.action === "billing.approve" && i.actor === "boss@example.com" && i.target === "r1"));
    assert.ok(!a.some((i: any) => i.action === "tenant.rotate_key"));
  });

  it("users.csv: BOM, başlıq və yalnız admin", async () => {
    const r = await fetch(`${p.base}/admin/users.csv`, { headers: { cookie: admin.cookie, origin: "http://localhost:3001" } });
    assert.equal(r.status, 200);
    assert.match(r.headers.get("content-type") ?? "", /text\/csv/);
    const buf = Buffer.from(await r.arrayBuffer());
    assert.deepEqual([...buf.subarray(0, 3)], [0xef, 0xbb, 0xbf], "Excel üçün UTF-8 BOM");
    const text = buf.toString("utf8");
    assert.ok(text.includes("email,verified,admin"));
    assert.ok(text.includes("plain@example.com"));
  });

  it("loggedMailer göndərmə xətasını jurnala yazır və yenidən atır", async () => {
    const store = createMemoryStore();
    const m = loggedMailer({ async send() { throw new Error("Resend 403: domain yoxlanmayıb"); } }, store);
    await assert.rejects(() => m.send("a@b.com", "s", "t"), /Resend 403/);
    const [e] = await store.listErrors({ limit: 5 });
    assert.equal(e!.source, "mail"); assert.match(e!.message, /Resend 403/);
  });
});
