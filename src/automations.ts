// Avtomatlaşdırmalar: "nə vaxt [hadisə] olanda, [şərt] uyğundursa → [addımlar]".
// Hadisələr: yeni müraciət, pis qiymət (CSAT 1-2 və ya 👎), canlı söhbət bağlandı, hər gün (xülasə).
// Addımlar: Telegram qrupu, e-poçt (sahibə), webhook, Bitrix24 (bağlantılar "Müraciətləri ötür"dəndir), müraciət (bilet) yarat, teq qoy.
// Ziyarətçini heç vaxt gözlətmir; səhvlər xəta jurnalına və avtomatlaşdırmanın "son işləmə"sinə yazılır.
// Köhnə hesablar (automations yoxdur): qoşulmuş yerlərə "yeni müraciət → göndər" əvvəlki kimi işləyir.
import { randomBytes } from "node:crypto";
import { Router } from "express";
import type { Deps } from "./deps.js";
import { recordError } from "./errorlog.js";
import { HttpError } from "./http.js";
import { currentUser, requireAuth } from "./middleware.js";
import { sendNotify } from "./operator-notify.js";
import { bitrixFields, bitrixMethod, forwardView, safePost, type Lead } from "./lead-forward.js";
import { decryptSecret } from "./secrets.js";
import { funnel } from "./stats.js";
import type { AutoAction, AutoTrigger, Automation, TenantRecord } from "./store/types.js";

export const MAX_AUTOMATIONS = 15;
const TRIGGERS: AutoTrigger[] = ["lead", "bad_rating", "chat_closed", "daily"];
/** Hər hadisədə hansı addımlar mənalıdır (məs. gündəlik xülasədə teq qoymaq olmaz) */
export const ALLOWED: Record<AutoTrigger, AutoAction["type"][]> = {
  lead: ["telegram", "webhook", "bitrix"], // e-poçt yoxdur: sahib hər müraciəti onsuz da e-poçtla alır
  bad_rating: ["telegram", "email", "webhook", "ticket", "tag"],
  chat_closed: ["telegram", "email", "webhook", "bitrix", "ticket", "tag"],
  daily: ["telegram", "email", "webhook"],
};
const RUNS_PER_HOUR = 30; // bir avtomatlaşdırma saatda ən çox bu qədər işləyir (spam fırtınasına qarşı)

type Channel = "site" | "telegram" | "whatsapp";
type Msg = { role: string; text: string };
export type DailySummary = { day: string; conversations: number | null; questions: number; unanswered: number; leads: number; live: number; up: number; down: number; csatAvg: number | null; costAzn: number | null; topUnanswered: string[] };
export type AutoEvent =
  | { trigger: "lead"; lead: Lead; channel: Channel }
  | { trigger: "bad_rating"; source: "csat" | "feedback"; rating: number; channel: Channel; chatId?: string; name?: string; contact?: string; comment?: string; question?: string; answer?: string; transcript?: Msg[] }
  | { trigger: "chat_closed"; chatId: string; channel: Channel; name: string; contact: string; tags: string[]; count: number; transcript: Msg[]; by?: string }
  | { trigger: "daily"; summary: DailySummary };

// ---------------------------------------------------------------- doğrulama
const clean = (v: unknown, max: number) => (typeof v === "string" ? v.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim() : "").slice(0, max + 1);
export function parseAutomations(v: unknown, prev: Automation[] = []): Automation[] {
  if (!Array.isArray(v)) throw new HttpError(400, "items siyahı olmalıdır");
  if (v.length > MAX_AUTOMATIONS) throw new HttpError(400, `Ən çox ${MAX_AUTOMATIONS} avtomatlaşdırma ola bilər`);
  const out = v.map((raw): Automation => {
    const x = (raw ?? {}) as Record<string, unknown>;
    const name = clean(x.name, 60);
    if (!name || name.length > 60) throw new HttpError(400, "Avtomatlaşdırmanın adı 1-60 simvol olmalıdır");
    const trigger = x.trigger as AutoTrigger;
    if (!TRIGGERS.includes(trigger)) throw new HttpError(400, "Hadisə düzgün deyil");
    if (!Array.isArray(x.actions) || !x.actions.length || x.actions.length > 6) throw new HttpError(400, "Ən azı bir, ən çox 6 addım olmalıdır");
    const actions = x.actions.map((a): AutoAction => {
      const y = (a ?? {}) as Record<string, unknown>;
      const type = y.type as AutoAction["type"];
      if (!ALLOWED[trigger].includes(type)) throw new HttpError(400, `Bu hadisədə “${String(type).slice(0, 20)}” addımı olmaz`);
      if (type === "ticket") return { type, priority: y.priority === "high" ? "high" : "normal" };
      if (type === "tag") {
        const tag = clean(y.tag, 24);
        if (!tag || tag.length > 24) throw new HttpError(400, "Teq 1-24 simvol olmalıdır");
        return { type, tag };
      }
      return { type } as AutoAction;
    });
    if (new Set(actions.map((a) => a.type)).size !== actions.length) throw new HttpError(400, "Eyni addım iki dəfə yazılıb");
    const w = (x.when ?? {}) as Record<string, unknown>;
    const when: Automation["when"] = {};
    if (w.channel !== undefined && w.channel !== "any") { if (!["site", "telegram", "whatsapp"].includes(w.channel as string)) throw new HttpError(400, "Kanal düzgün deyil"); when.channel = w.channel as Channel; }
    if (w.withContact === true) when.withContact = true;
    if (trigger === "bad_rating" && (w.source === "csat" || w.source === "feedback")) when.source = w.source;
    if (trigger === "daily") {
      const h = w.hour ?? 9;
      if (typeof h !== "number" || !Number.isInteger(h) || h < 0 || h > 23) throw new HttpError(400, "Saat 0-23 olmalıdır");
      when.hour = h;
    }
    const id = typeof x.id === "string" && /^[a-f0-9]{8}$/.test(x.id) ? x.id : randomBytes(4).toString("hex");
    const old = prev.find((p) => p.id === id);
    return {
      id, name, trigger, enabled: x.enabled !== false, actions, ...(Object.keys(when).length && { when }),
      createdAt: old?.createdAt ?? new Date().toISOString(),
      ...(old?.lastRun && { lastRun: old.lastRun }), ...(old?.runs && { runs: old.runs }), ...(old?.lastDay && { lastDay: old.lastDay }),
    };
  });
  if (new Set(out.map((a) => a.id)).size !== out.length) throw new HttpError(400, "Identifikatorlar təkrarlanır");
  return out;
}

/** Saxlanmış siyahı; köhnə hesabda qoşulmuş yerlərdən qurulan gizli "yeni müraciət → göndər" */
export function automationsOf(t: TenantRecord): { items: Automation[]; implicit: boolean } {
  if (t.automations) return { items: t.automations, implicit: false };
  const f = t.leadForward ?? {};
  const actions = (["telegram", "bitrix", "webhook"] as const).filter((k) => f[k]).map((type) => ({ type }));
  return { items: actions.length ? [{ id: "00000000", name: "Yeni müraciəti ötür", trigger: "lead", enabled: true, actions, createdAt: new Date(0).toISOString() }] : [], implicit: true };
}

const channelOf = (ev: AutoEvent): Channel | null => (ev.trigger === "daily" ? null : ev.channel);
const contactOf = (ev: AutoEvent): string => (ev.trigger === "lead" ? ev.lead.contact : ev.trigger === "daily" ? "" : ev.contact ?? "");
export function matches(a: Automation, ev: AutoEvent): boolean {
  if (!a.enabled || a.trigger !== ev.trigger) return false;
  const w = a.when ?? {};
  const ch = channelOf(ev);
  if (w.channel && ch && w.channel !== ch) return false;
  if (w.withContact && !contactOf(ev)) return false;
  if (ev.trigger === "bad_rating" && w.source && w.source !== ev.source) return false;
  return true;
}

// ---------------------------------------------------------------- mətnlər
const CH: Record<Channel, string> = { site: "sayt", telegram: "Telegram", whatsapp: "WhatsApp" };
const convo = (m: Msg[] | undefined, n = 6) => (m ?? []).slice(-n).map((x) => `${x.role === "user" || x.role === "visitor" ? "Ziyarətçi" : x.role === "operator" ? "Operator" : "Çat"}: ${x.text.slice(0, 200)}`).join("\n");
export function eventText(t: TenantRecord, ev: AutoEvent, test = false): { subject: string; text: string } {
  const pre = test ? "🧪 Sınaq · " : "";
  if (ev.trigger === "lead") {
    const l = ev.lead, c = convo(l.conversation);
    return { subject: `${pre}Yeni müraciət: ${t.businessName}`, text: [`${pre}📩 Yeni müraciət (${l.source}) · ${t.businessName}`, "", `Ad: ${l.name || "-"}`, `Əlaqə: ${l.contact}`, `Sual: ${l.question || "-"}`, ...(l.page ? [`Səhifə: ${l.page}`] : []), ...(c ? ["", "Söhbətin son hissəsi:", c] : [])].join("\n") };
  }
  if (ev.trigger === "bad_rating") {
    const head = ev.source === "csat" ? `⚠️ Pis qiymət: ${ev.rating}/5 (${CH[ev.channel]})` : `👎 Cavab bəyənilmədi (${CH[ev.channel]})`;
    const c = convo(ev.transcript);
    return { subject: `${pre}${ev.source === "csat" ? `Pis qiymət ${ev.rating}/5` : "Cavab bəyənilmədi"}: ${t.businessName}`, text: [`${pre}${head} · ${t.businessName}`, "",
      ...(ev.name ? [`Ad: ${ev.name}`] : []), ...(ev.contact ? [`Əlaqə: ${ev.contact}`] : []), ...(ev.comment ? [`Rəy: ${ev.comment}`] : []),
      ...(ev.question ? [`Sual: ${ev.question}`] : []), ...(ev.answer ? [`Cavab: ${ev.answer.slice(0, 400)}`] : []), ...(c ? ["", "Söhbət:", c] : [])].join("\n") };
  }
  if (ev.trigger === "chat_closed") {
    const c = convo(ev.transcript, 8);
    return { subject: `${pre}Söhbət bağlandı: ${ev.name || ev.contact || CH[ev.channel]}`, text: [`${pre}✅ Söhbət bağlandı (${CH[ev.channel]}) · ${t.businessName}`, "",
      `Ad: ${ev.name || "-"}`, `Əlaqə: ${ev.contact || "-"}`, `Mesaj sayı: ${ev.count}`, ...(ev.tags.length ? [`Teqlər: ${ev.tags.join(", ")}`] : []), ...(ev.by ? [`Bağladı: ${ev.by}`] : []), ...(c ? ["", "Söhbət:", c] : [])].join("\n") };
  }
  const s = ev.summary;
  return { subject: `${pre}${t.businessName}: ${s.day} xülasəsi`, text: [`${pre}📊 ${t.businessName} · ${s.day}`, "",
    `Söhbətlər: ${s.conversations ?? "—"}`, `Suallar: ${s.questions}`, `Cavabsız qalan: ${s.unanswered}`, `Müraciətlər: ${s.leads}`, `Canlı söhbətlər: ${s.live}`,
    `Rəylər: 👍 ${s.up} · 👎 ${s.down}${s.csatAvg !== null ? ` · CSAT ${s.csatAvg}` : ""}`, ...(s.costAzn !== null ? [`Bu ayın xərci: ${s.costAzn.toFixed(2)} AZN`] : []),
    ...(s.topUnanswered.length ? ["", "Cavab tapılmayan suallar:", ...s.topUnanswered.map((q) => `• ${q.slice(0, 120)}`)] : [])].join("\n") };
}

function webhookPayload(t: TenantRecord, ev: AutoEvent, test: boolean) {
  const base = { event: test ? "test" : ev.trigger, at: new Date().toISOString(), site: t.domain, business: t.businessName };
  if (ev.trigger === "lead") { const l = ev.lead; return { ...base, source: l.source, name: l.name, contact: l.contact, question: l.question, page: l.page ?? "", conversation: l.conversation ?? [] }; }
  if (ev.trigger === "daily") return { ...base, summary: ev.summary };
  const { trigger: _t, ...rest } = ev;
  return { ...base, ...rest };
}

// ---------------------------------------------------------------- icra
type StepResult = { type: AutoAction["type"]; ok: boolean; note?: string };
async function runAction(deps: Deps, t: TenantRecord, a: AutoAction, ev: AutoEvent, test: boolean): Promise<StepResult> {
  const f = t.leadForward ?? {};
  const post = deps.httpPost ?? safePost;
  try {
    switch (a.type) {
      case "telegram": {
        if (!f.telegram) return { type: a.type, ok: false, note: "Telegram qrupu qoşulmayıb" };
        const r = await sendNotify(deps, f.telegram.chatId, eventText(t, ev, test).text.slice(0, 3900));
        if (r === "gone") { await deps.store.updateTenant(t.tenantId, { leadForward: { ...f, telegram: null } }); return { type: a.type, ok: false, note: "Bot qrupdan çıxarılıb, bağlantı silindi" }; }
        return r === "ok" ? { type: a.type, ok: true } : { type: a.type, ok: false, note: "Telegram-a göndərilmədi" };
      }
      case "email": {
        const owner = await deps.store.findUserById(t.userId);
        if (!owner) return { type: a.type, ok: false, note: "Sahib tapılmadı" };
        const m = eventText(t, ev, test);
        await deps.mailer.send(owner.email, m.subject, m.text);
        return { type: a.type, ok: true };
      }
      case "webhook": {
        if (!f.webhook) return { type: a.type, ok: false, note: "Webhook qoşulmayıb" };
        const r = await post(decryptSecret(f.webhook.urlEnc, deps.config.secretKey), webhookPayload(t, ev, test));
        return r.ok ? { type: a.type, ok: true } : { type: a.type, ok: false, note: `Webhook HTTP ${r.status}` };
      }
      case "bitrix": {
        if (!f.bitrix) return { type: a.type, ok: false, note: "Bitrix24 qoşulmayıb" };
        const lead: Lead | null = ev.trigger === "lead" ? ev.lead
          : ev.trigger === "chat_closed" && ev.contact ? { source: `canlı söhbət, ${CH[ev.channel]}`, name: ev.name, contact: ev.contact, question: ev.transcript.find((m) => m.role === "user" || m.role === "visitor")?.text.slice(0, 300) ?? "", conversation: ev.transcript } : null;
        if (!lead) return { type: a.type, ok: true, note: "Əlaqə yoxdur, keçildi" };
        if (test) return { type: a.type, ok: true, note: "Sınaqda CRM-də lid yaradılmır" };
        const r = await post(bitrixMethod(decryptSecret(f.bitrix.urlEnc, deps.config.secretKey), "crm.lead.add"), { fields: bitrixFields(t, lead), params: { REGISTER_SONET_EVENT: "Y" } });
        const j = (r.json ?? {}) as { result?: unknown; error_description?: string };
        return r.ok && j.result !== undefined ? { type: a.type, ok: true } : { type: a.type, ok: false, note: `Bitrix24: ${String(j.error_description ?? `HTTP ${r.status}`).slice(0, 120)}` };
      }
      case "ticket": {
        if (ev.trigger !== "bad_rating" && ev.trigger !== "chat_closed") return { type: a.type, ok: true };
        if (!ev.contact) return { type: a.type, ok: true, note: "Müştərinin əlaqəsi yoxdur, müraciət yaradılmadı" };
        if (test) return { type: a.type, ok: true, note: "Sınaqda müraciət yaradılmır" };
        const question = ev.trigger === "bad_rating" ? `${ev.source === "csat" ? `Pis qiymət ${ev.rating}/5` : "Cavab bəyənilmədi"}${ev.comment ? `: ${ev.comment}` : ""}` : `Bağlanan söhbət (${CH[ev.channel]})`;
        const r = await deps.ai.kbAddLead(t.tenantId, { name: ev.name ?? "", contact: ev.contact, question: question.slice(0, 500), conversation: (ev.transcript ?? []).slice(-10).map((m) => ({ role: m.role === "user" || m.role === "visitor" ? "user" : "model", text: m.text.slice(0, 600) })) });
        const id = (r as { lead?: { id?: string } }).lead?.id;
        if (id && a.priority === "high") await deps.ai.kbUpdateLead(t.tenantId, id, { priority: "high", by: "Avtomatlaşdırma" }).catch(() => {});
        return { type: a.type, ok: true };
      }
      case "tag": {
        const chatId = ev.trigger === "chat_closed" ? ev.chatId : ev.trigger === "bad_rating" ? ev.chatId : undefined;
        if (!chatId) return { type: a.type, ok: true, note: "Canlı söhbət deyil, teq qoyulmadı" };
        if (test) return { type: a.type, ok: true, note: "Sınaqda teq qoyulmur" };
        const chat = await deps.store.getLive(t.tenantId, chatId);
        if (!chat) return { type: a.type, ok: false, note: "Söhbət tapılmadı" };
        const tags = chat.tags ?? [];
        if (!tags.some((g) => g.toLowerCase() === a.tag.toLowerCase()) && tags.length < 5) await deps.store.patchLive(t.tenantId, chatId, { tags: [...tags, a.tag] });
        return { type: a.type, ok: true };
      }
    }
  } catch (e) {
    return { type: a.type, ok: false, note: e instanceof Error && e.name === "TimeoutError" ? "8 saniyədə cavab gəlmədi" : `Alınmadı${e instanceof Error ? ` (${e.message.slice(0, 80)})` : ""}` };
  }
}

/** Bir avtomatlaşdırmanı icra edir (addımlar ardıcıl). Sınaqda heç nə yaradılmır, yalnız mesajlar "Sınaq" qeydi ilə göndərilir. */
export async function execute(deps: Deps, t: TenantRecord, a: Automation, ev: AutoEvent, opts: { test?: boolean; log?: boolean; lastDay?: string } = {}): Promise<StepResult[]> {
  const steps: StepResult[] = [];
  for (const act of a.actions) steps.push(await runAction(deps, t, act, ev, Boolean(opts.test)));
  const failed = steps.filter((s) => !s.ok);
  if (opts.log !== false && !opts.test) {
    await deps.store.setAutomationRun(t.tenantId, a.id, { at: new Date().toISOString(), ok: !failed.length, ...(failed.length && { error: failed.map((s) => s.note).join("; ").slice(0, 300) }) }, opts.lastDay).catch(() => {});
    if (failed.length) void recordError(deps.store, { source: "channel", message: `Avtomatlaşdırma “${a.name}”: ${failed.map((s) => `${s.type}: ${s.note}`).join("; ")}`.slice(0, 500), tenantId: t.tenantId, code: "AUTOMATION" });
  }
  return steps;
}

/** Hadisə baş verəndə uyğun avtomatlaşdırmaları işə salır. Heç vaxt xəta atmır. */
export async function runAutomations(deps: Deps, t: TenantRecord, ev: AutoEvent): Promise<void> {
  try {
    const { items, implicit } = automationsOf(t);
    await Promise.all(items.filter((a) => matches(a, ev)).map(async (a) => {
      if (!deps.limiter.hit(`auto:${t.tenantId}:${a.id}`, RUNS_PER_HOUR, 60 * 60_000)) return;
      await execute(deps, t, a, ev, { log: !implicit });
    }));
  } catch (e) { console.warn(`[automations] ${t.tenantId}:`, e instanceof Error ? e.message : e); }
}

// ---------------------------------------------------------------- gündəlik xülasə
const tzOf = (t: TenantRecord) => t.widget?.live?.hours?.tz || "Asia/Baku";
function localNow(tz: string, now: Date) {
  try {
    const p = Object.fromEntries(new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", hourCycle: "h23" }).formatToParts(now).map((x) => [x.type, x.value]));
    return { day: `${p.year}-${p.month}-${p.day}`, hour: Number(p.hour) };
  } catch { return { day: now.toISOString().slice(0, 10), hour: now.getUTCHours() }; }
}
export async function dailySummary(deps: Deps, t: TenantRecord, day: string): Promise<DailySummary> {
  const f = await funnel(deps, t, 1);
  let top: string[] = [];
  try {
    const u = (await deps.ai.kbUnanswered(t.tenantId)) as { items?: { message?: string; at?: string }[] };
    const since = Date.now() - 86_400_000;
    top = (u.items ?? []).filter((x) => x.message && (!x.at || new Date(x.at).getTime() >= since)).slice(0, 5).map((x) => x.message!);
  } catch { /* bilik bazası yoxdur */ }
  return { day, conversations: f.conversations, questions: f.questions, unanswered: f.unanswered, leads: f.leads, live: f.live, up: f.feedbackUp, down: f.feedbackDown, csatAvg: f.csatAvg, costAzn: f.costAzn, topUnanswered: top };
}
/** Saatı çatmış gündəlik avtomatlaşdırmaları işə salır (hər gün bir dəfə, saytın saat qurşağına görə). Qaytarır: işləyənlərin sayı. */
export async function runDaily(deps: Deps, now = new Date()): Promise<number> {
  let n = 0;
  for (const t of await deps.store.listTenants(5000)) {
    const due = (t.automations ?? []).filter((a) => a.enabled && a.trigger === "daily");
    if (!due.length || t.suspended) continue;
    const { day, hour } = localNow(tzOf(t), now);
    const ready = due.filter((a) => hour >= (a.when?.hour ?? 9) && a.lastDay !== day);
    if (!ready.length) continue;
    for (const a of ready) await deps.store.setAutomationRun(t.tenantId, a.id, null, day); // əvvəl qeyd et: təkrar göndərilməsin
    try {
      const summary = await dailySummary(deps, t, day);
      for (const a of ready) { await execute(deps, t, a, { trigger: "daily", summary }); n++; }
    } catch (e) { console.warn(`[automations] daily ${t.tenantId}:`, e instanceof Error ? e.message : e); }
  }
  return n;
}
/** 10 dəqiqədən bir yoxlayır. Çoxlu server olsa yalnız birində işlədin (AUTOMATIONS=off digərlərində). */
export function startAutomationScheduler(deps: Deps): () => void {
  if (process.env.AUTOMATIONS === "off") return () => {};
  const tick = () => { runDaily(deps).catch((e) => { void recordError(deps.store, { source: "job", message: `Gündəlik avtomatlaşdırma: ${e instanceof Error ? e.message : String(e)}`, code: "AUTOMATION_JOB" }); }); };
  const first = setTimeout(tick, 90_000);
  const timer = setInterval(tick, 10 * 60_000);
  first.unref?.(); timer.unref?.();
  return () => { clearTimeout(first); clearInterval(timer); };
}

// ---------------------------------------------------------------- panel
const SAMPLES = (t: TenantRecord): Record<AutoTrigger, AutoEvent> => ({
  lead: { trigger: "lead", channel: "site", lead: { source: "sayt", name: "Sınaq Müştəri", contact: "+994501234567", question: "Bu, avtomatlaşdırmanın yoxlanması üçün sınaq müraciətidir." } },
  bad_rating: { trigger: "bad_rating", source: "csat", rating: 2, channel: "site", name: "Sınaq Müştəri", contact: "+994501234567", comment: "Cavab gec gəldi", transcript: [{ role: "visitor", text: "Sifarişim hələ gəlməyib" }, { role: "operator", text: "Yoxlayıram" }] },
  chat_closed: { trigger: "chat_closed", chatId: "test", channel: "site", name: "Sınaq Müştəri", contact: "+994501234567", tags: [], count: 4, transcript: [{ role: "visitor", text: "Çatdırılma var?" }, { role: "operator", text: "Bəli, Bakı daxilində pulsuz" }] },
  daily: { trigger: "daily", summary: { day: new Date().toISOString().slice(0, 10), conversations: 42, questions: 97, unanswered: 6, leads: 3, live: 5, up: 11, down: 1, csatAvg: 4.6, costAzn: t ? 1.25 : 0, topUnanswered: ["Kreditlə almaq olar?"] } },
});

const view = (deps: Deps, t: TenantRecord) => ({ ...automationsOf(t), connections: forwardView(deps, t.leadForward), max: MAX_AUTOMATIONS, tz: tzOf(t) });

/** Panel: /tenant/automations (yalnız sahib) */
export function automationRoutes(deps: Deps) {
  const { store, limiter } = deps;
  const r = Router();
  r.use("/automations", requireAuth);
  const mine = async (res: Parameters<typeof currentUser>[0]) => {
    const t = await store.findTenantByUser(currentUser(res).id);
    if (!t) throw new HttpError(404, "Əvvəlcə qurulumu tamamla", "NO_TENANT");
    return t;
  };
  r.get("/automations", async (_req, res) => { res.json(view(deps, await mine(res))); });
  r.put("/automations", async (req, res) => {
    const t = await mine(res);
    const items = parseAutomations(req.body?.items, t.automations ?? []);
    await store.updateTenant(t.tenantId, { automations: items });
    res.json(view(deps, { ...t, automations: items }));
  });
  // Sınaq: seçilmiş avtomatlaşdırmanın addımları nümunə məlumatla işləyir (mesajlar "Sınaq" qeydi ilə; lid, müraciət və teq yaradılmır)
  r.post("/automations/test", async (req, res) => {
    const t = await mine(res);
    if (!limiter.hit(`auto:test:${t.tenantId}`, 10, 10 * 60_000)) throw new HttpError(429, "Çox tez-tez sınaq, bir az gözlə", "RATE_LIMITED");
    const [a] = parseAutomations([req.body?.item]);
    const ev = a!.trigger === "daily" ? { trigger: "daily" as const, summary: await dailySummary(deps, t, localNow(tzOf(t), new Date()).day) } : SAMPLES(t)[a!.trigger];
    res.json({ steps: await execute(deps, t, a!, ev, { test: true }) });
  });
  return r;
}

/** Canlı söhbətdən hadisə məlumatı (bağlanma və CSAT üçün) */
export function liveEventBase(c: import("./store/types.js").LiveChat) {
  const transcript: Msg[] = [...c.context.map((m) => ({ role: m.role, text: m.text })), ...c.messages.filter((m) => m.from !== "system").map((m) => ({ role: m.from, text: m.text }))].slice(-10);
  return { chatId: c.id, channel: (c.channel?.type ?? "site") as Channel, name: c.name, contact: c.contact, transcript };
}
export const chatClosedEvent = (c: import("./store/types.js").LiveChat, by?: string): AutoEvent => ({
  trigger: "chat_closed", ...liveEventBase(c), tags: c.tags ?? [], count: c.messages.filter((m) => m.from !== "system").length, ...(by && { by }),
});
