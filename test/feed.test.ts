import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { startPortal } from "./helpers.js";

let p: Awaited<ReturnType<typeof startPortal>>;
before(async () => { p = await startPortal(); });
after(() => p.close());

const feedCfg = { businessName: "Mağaza", domain: "magaza.az", profile: { mode: "listings" }, source: { type: "feed", feed: { format: "csv" }, response: { fields: { id: "kod", title: "ad" } } } };

test("feed: preview AI-yə ötürülür (yalnız tanınan sahələr), böyük gövdə qəbul olunur", async () => {
  const c = await p.signedIn("feed1@example.com");
  const text = "ad;kod\n" + "a;1\n".repeat(300_000); // ~1.2 MB: 200kb standart limitdən böyük
  const r = await c.call("POST", "/tenant/feed/preview", { feedText: text, url: "https://x.az/f.csv", evil: "no" });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const call = p.ai.calls.filter((x) => x.fn === "feedPreview").at(-1)!;
  const sent = call.args[0] as Record<string, unknown>;
  assert.equal(sent.url, "https://x.az/f.csv"); assert.equal((sent.feedText as string).length, text.length); assert.equal("evil" in sent, false);
});

test("feed: hesab yaradılır, fayl AI-yə gedir amma portal bazasında saxlanmır; status və yeniləmə", async () => {
  const c = await p.signedIn("feed2@example.com");
  const r = await c.call("POST", "/tenant", { config: { ...feedCfg, feedText: "ad;kod\nçanta;1\n" } });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  const created = p.ai.calls.filter((x) => x.fn === "createTenant").at(-1)!.args[0] as Record<string, unknown>;
  assert.equal(created.feedText, "ad;kod\nçanta;1\n");
  const t = (await c.call("GET", "/tenant")).body.tenant;
  assert.equal("feedText" in t.config, false);
  assert.equal(t.config.source.type, "feed");
  assert.equal((await c.call("GET", "/tenant/feed")).body.feed.count, 3);
  const rf = await c.call("POST", "/tenant/feed/refresh", { feedText: "ad;kod\nyeni;2\n" });
  assert.equal(rf.status, 200); assert.equal(rf.body.count, 4);
  assert.deepEqual(p.ai.calls.filter((x) => x.fn === "feedRefresh").at(-1)!.args[1], { feedText: "ad;kod\nyeni;2\n" });
  const rf2 = await c.call("POST", "/tenant/feed/refresh", {});
  assert.equal(rf2.status, 200);
  assert.deepEqual(p.ai.calls.filter((x) => x.fn === "feedRefresh").at(-1)!.args[1], {});
});

test("feed: giriş tələb olunur", async () => {
  const r = await fetch(`${p.base}/tenant/feed/preview`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
  assert.ok([401, 403].includes(r.status));
});
