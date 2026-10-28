// Statistika: konversiya (söhbətdən müraciətə), CSV ixracı və aylıq e-poçt hesabatı.
import { recordError } from "./errorlog.js";
import type { Deps } from "./deps.js";
import type { TenantRecord } from "./store/types.js";

type Row = Record<string, unknown>;
const ok = <T,>(r: PromiseSettledResult<T>) => (r.status === "fulfilled" ? r.value : null);
const pct = (a: number, b: number) => (b > 0 ? Math.round((a / b) * 1000) / 10 : null);

export type Funnel = {
  days: number;
  /** AI-ın söhbət tarixçəsi qeydi söndürülübsə söhbət sayı bilinmir (null). */
  conversations: number | null;
  questions: number; answered: number; unanswered: number;
  /** Operatora yönəlmə: canlı söhbət və əlaqə formasından gələn müraciət */
  live: number; leads: number; leadsHandled: number; handoffs: number;
  /** handoffs / conversations (%), söhbət sayı yoxdursa null */
  handoffRate: number | null;
  /** Müraciətlərin neçə faizi "emal olunub" işarələnib */
  handledRate: number | null;
  /** AI-ın xərci (manat): operatora çatan hər müraciətin təxmini AI dəyəri */
  costAzn: number | null;
};

export async function funnel(deps: Deps, t: TenantRecord, days: number): Promise<Funnel> {
  const since = Date.now() - days * 86_400_000;
  const [stats, leads, open, closed, billing] = (await Promise.allSettled([
    deps.ai.queryStats(t.tenantId, days),
    deps.ai.kbLeads(t.tenantId),
    deps.store.listLive(t.tenantId, "open", 500),
    deps.store.listLive(t.tenantId, "closed", 500),
    deps.ai.billing(t.tenantId),
  ])).map(ok) as [Row | null, Row | null, { createdAt: Date }[] | null, { createdAt: Date }[] | null, Row | null];
  const items = ((leads?.items ?? []) as { at: string; handled?: boolean }[]).filter((x) => new Date(x.at).getTime() >= since);
  const live = [...(open ?? []), ...(closed ?? [])].filter((c) => c.createdAt.getTime() >= since).length;
  const total = Number(stats?.total ?? 0), noResults = Number(stats?.noResults ?? 0), errors = Number(stats?.errors ?? 0);
  const conversations = stats && stats.enabled !== false && typeof stats.conversations === "number" ? stats.conversations : null;
  const handoffs = items.length + live;
  const month = (billing as { spend?: { monthAzn?: number } } | null)?.spend?.monthAzn;
  return {
    days, conversations, questions: total, answered: Math.max(0, total - noResults - errors), unanswered: noResults,
    live, leads: items.length, leadsHandled: items.filter((x) => x.handled).length, handoffs,
    handoffRate: conversations ? pct(handoffs, conversations) : null,
    handledRate: items.length ? pct(items.filter((x) => x.handled).length, items.length) : null,
    costAzn: typeof month === "number" ? month : null,
  };
}

// ---------- CSV ----------
/** Excel-də düstur kimi işləməsin deyə (=, +, -, @) ilə başlayan mətnin əvvəlinə ' qoyulur. Ayırıcı ";" (Excel AZ/RU/TR və Google Sheets düzgün açır). */
export function csvCell(v: unknown): string {
  let s = v instanceof Date ? v.toISOString() : v === null || v === undefined ? "" : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[";\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
export function toCsv(cols: { key: string; title: string }[], rows: Row[]): string {
  const head = cols.map((c) => csvCell(c.title)).join(";");
  const body = rows.map((r) => cols.map((c) => csvCell(r[c.key])).join(";"));
  return "﻿" + [head, ...body].join("\r\n") + "\r\n"; // BOM: Excel UTF-8 hərfləri (ə, ş) düzgün göstərsin
}

export const EXPORT_LIMIT = 5000;
export type ExportKind = "queries" | "conversations" | "leads" | "unanswered" | "live";

/** Qaytarır: { filename, csv, truncated }. Sorğular səhifə-səhifə yığılır (ən çox EXPORT_LIMIT sətir). */
export async function exportCsv(deps: Deps, t: TenantRecord, kind: ExportKind, days: number): Promise<{ filename: string; csv: string; truncated: boolean }> {
  const stamp = new Date().toISOString().slice(0, 10);
  let truncated = false;
  if (kind === "queries" || kind === "conversations") {
    const rows: Row[] = [];
    let cursor = "";
    while (rows.length < EXPORT_LIMIT) {
      const qs = new URLSearchParams({ days: String(days), limit: kind === "queries" ? "200" : "100" });
      if (cursor) qs.set("before", cursor);
      const r = kind === "queries" ? await deps.ai.queries(t.tenantId, qs.toString()) : await deps.ai.conversations(t.tenantId, qs.toString());
      rows.push(...((kind === "queries" ? r.queries : r.conversations) ?? []));
      if (!r.hasMore || !r.nextCursor) break;
      cursor = r.nextCursor;
    }
    if (rows.length >= EXPORT_LIMIT) { truncated = true; rows.length = EXPORT_LIMIT; }
    if (kind === "queries") return { filename: `suallar-${stamp}.csv`, truncated, csv: toCsv([
      { key: "at", title: "Vaxt" }, { key: "sid", title: "Söhbət" }, { key: "message", title: "Sual" }, { key: "results", title: "Nəticə" },
      { key: "tokens", title: "Token" }, { key: "cached", title: "Keşdən" }, { key: "error", title: "Xəta" }, { key: "costAzn", title: "Xərc (AZN)" },
    ], rows) };
    return { filename: `sohbetler-${stamp}.csv`, truncated, csv: toCsv([
      { key: "startedAt", title: "Başlanğıc" }, { key: "lastAt", title: "Son mesaj" }, { key: "sid", title: "Söhbət" }, { key: "messages", title: "Mesaj sayı" },
      { key: "unanswered", title: "Cavabsız" }, { key: "first", title: "İlk sual" }, { key: "costAzn", title: "Xərc (AZN)" },
    ], rows) };
  }
  const since = Date.now() - days * 86_400_000;
  if (kind === "leads" || kind === "unanswered") {
    const r = kind === "leads" ? await deps.ai.kbLeads(t.tenantId) : await deps.ai.kbUnanswered(t.tenantId);
    const rows = ((r.items ?? []) as Row[]).filter((x) => new Date(String(x.at)).getTime() >= since);
    if (kind === "leads") return { filename: `muracietler-${stamp}.csv`, truncated, csv: toCsv([
      { key: "at", title: "Vaxt" }, { key: "name", title: "Ad" }, { key: "contact", title: "Əlaqə" }, { key: "question", title: "Sual" }, { key: "handled", title: "Emal olunub" },
    ], rows) };
    return { filename: `cavabsiz-suallar-${stamp}.csv`, truncated, csv: toCsv([{ key: "at", title: "Vaxt" }, { key: "message", title: "Sual" }, { key: "reason", title: "Səbəb" }], rows) };
  }
  const [open, closed] = await Promise.all([deps.store.listLive(t.tenantId, "open", 500), deps.store.listLive(t.tenantId, "closed", 500)]);
  const rows = [...open, ...closed].filter((c) => c.createdAt.getTime() >= since).sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime()).map((c) => ({
    at: c.createdAt, name: c.name, contact: c.contact, status: c.status, visitorMessages: c.messages.filter((m) => m.from === "visitor").length,
    operatorMessages: c.messages.filter((m) => m.from === "operator").length,
    firstReplyMin: (() => { const v = c.messages.find((m) => m.from === "visitor"), o = c.messages.find((m) => m.from === "operator"); return v && o ? Math.round((o.at.getTime() - v.at.getTime()) / 6000) / 10 : ""; })(),
  }));
  return { filename: `canli-sohbetler-${stamp}.csv`, truncated, csv: toCsv([
    { key: "at", title: "Vaxt" }, { key: "name", title: "Ad" }, { key: "contact", title: "Əlaqə" }, { key: "status", title: "Status" },
    { key: "visitorMessages", title: "Ziyarətçi mesajı" }, { key: "operatorMessages", title: "Operator mesajı" }, { key: "firstReplyMin", title: "İlk cavab (dəq)" },
  ], rows) };
}

// ---------- Aylıq hesabat ----------
const L = {
  az: { subj: (b: string) => `${b}: aylıq çat hesabatı`, h: "Son 30 günün qısa nəticəsi", conv: "Söhbət", q: "Sual", ans: "AI-ın cavab verdiyi", un: "Cavabsız qalan", live: "Canlı operator söhbəti", leads: "Əlaqə formasından müraciət", handled: "Emal olunmuş müraciət", rate: "Operatora yönəlmə faizi", top: "Ən çox verilən suallar", bal: "Balans", more: "Ətraflı: panelin Sorğular və Statistika bölməsi.", off: "Bu hesabatı panelin Sorğular səhifəsindəki düymə ilə söndürə bilərsiniz." },
  en: { subj: (b: string) => `${b}: monthly chat report`, h: "Last 30 days at a glance", conv: "Conversations", q: "Questions", ans: "Answered by AI", un: "Left unanswered", live: "Live operator chats", leads: "Contact-form requests", handled: "Requests handled", rate: "Handoff rate", top: "Most asked questions", bal: "Balance", more: "Details: Queries and Statistics in the panel.", off: "You can turn this report off with the button on the Queries page of the panel." },
  ru: { subj: (b: string) => `${b}: ежемесячный отчёт чата`, h: "Итоги за последние 30 дней", conv: "Диалоги", q: "Вопросы", ans: "Ответил ИИ", un: "Остались без ответа", live: "Чаты с оператором", leads: "Обращения из формы", handled: "Обработано обращений", rate: "Доля передачи оператору", top: "Частые вопросы", bal: "Баланс", more: "Подробнее: разделы «Запросы» и «Статистика» в панели.", off: "Отчёт можно отключить кнопкой на странице «Запросы» в панели." },
  tr: { subj: (b: string) => `${b}: aylık sohbet raporu`, h: "Son 30 günün kısa özeti", conv: "Sohbet", q: "Soru", ans: "AI'ın yanıtladığı", un: "Yanıtsız kalan", live: "Canlı operatör sohbeti", leads: "İletişim formundan başvuru", handled: "İşlenen başvuru", rate: "Yönlendirme oranı", top: "En çok sorulan sorular", bal: "Bakiye", more: "Ayrıntılar: panelde Sorgular ve İstatistik bölümü.", off: "Bu raporu panelin Sorgular sayfasındaki düğmeyle kapatabilirsin." },
} as const;

export async function buildReport(deps: Deps, t: TenantRecord): Promise<{ subject: string; text: string } | null> {
  const f = await funnel(deps, t, 30);
  if (f.questions === 0 && f.handoffs === 0) return null; // boş ay: yersiz məktub göndərmirik
  const lang = ((t.config as { profile?: { language?: string } }).profile?.language ?? "az") as keyof typeof L;
  const m = L[lang] ?? L.az;
  const [stats, billing] = (await Promise.allSettled([deps.ai.queryStats(t.tenantId, 30), deps.ai.billing(t.tenantId)])).map(ok) as [Row | null, Row | null];
  const top = ((stats?.top ?? []) as { message: string; count: number }[]).slice(0, 5).map((x, i) => `${i + 1}. ${x.message} (${x.count})`).join("\n");
  const bal = (billing as { balance?: { totalAzn?: number } } | null)?.balance?.totalAzn;
  const lines = [
    m.h, "",
    ...(f.conversations !== null ? [`${m.conv}: ${f.conversations}`] : []),
    `${m.q}: ${f.questions}`, `${m.ans}: ${f.answered}`, `${m.un}: ${f.unanswered}`,
    `${m.live}: ${f.live}`, `${m.leads}: ${f.leads}`, `${m.handled}: ${f.leadsHandled}`,
    ...(f.handoffRate !== null ? [`${m.rate}: ${f.handoffRate}%`] : []),
    ...(typeof bal === "number" ? [`${m.bal}: ${bal.toFixed(2)} AZN`] : []),
    ...(top ? ["", `${m.top}:`, top] : []),
    "", m.more, m.off,
  ];
  return { subject: m.subj(t.businessName), text: lines.join("\n") };
}

const periodOf = (d: Date) => `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;

/** Hər tenant üçün cari ayın hesabatı hələ göndərilməyibsə göndərir (ayın 1-i, əvvəlki 30 gün). Qaytarır: göndərilənlərin sayı. */
export async function sendMonthlyReports(deps: Deps, now = new Date()): Promise<number> {
  if (now.getUTCDate() !== 1) return 0;
  const period = periodOf(now);
  let sent = 0;
  for (const t of await deps.store.listTenants(5000)) {
    if (t.report?.monthly === false || t.report?.lastSent === period) continue;
    try {
      await deps.store.updateTenant(t.tenantId, { report: { ...t.report, lastSent: period } }); // əvvəl qeyd et: təkrar göndərilməsin
      const owner = await deps.store.findUserById(t.userId);
      const rep = owner ? await buildReport(deps, t) : null;
      if (owner && rep) { await deps.mailer.send(owner.email, rep.subject, rep.text); sent++; }
    } catch (e) { console.warn(`[report] ${t.tenantId}:`, e instanceof Error ? e.message : e); }
  }
  return sent;
}

/** Saatda bir yoxlayır (ayın 1-i işə düşür). Çoxlu server olsa yalnız birində işlədin (REPORTS=off digərlərində). */
export function startReportScheduler(deps: Deps): () => void {
  if (process.env.REPORTS === "off") return () => {};
  const tick = () => { sendMonthlyReports(deps).catch((e) => { console.warn("[report]", e instanceof Error ? e.message : e); void recordError(deps.store, { source: "job", message: `Aylıq hesabat: ${e instanceof Error ? e.message : String(e)}`, code: "REPORT_FAILED" }); }); };
  const first = setTimeout(tick, 60_000);
  const timer = setInterval(tick, 60 * 60_000);
  first.unref?.(); timer.unref?.();
  return () => { clearTimeout(first); clearInterval(timer); };
}
