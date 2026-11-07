// Hesabatlar: seçilmiş dövr (7/30/90 gün) və əvvəlki eyni uzunluqlu dövr müqayisəsi, gündəlik bölgü, komanda performansı.
// AI rəqəmləri ai-server-in sorğu jurnalından (jurnal söndürülübsə null), canlı söhbət və CSAT portaldan, müraciətlər bilik bazasından gəlir.
// Günün sərhədi Azərbaycan vaxtı ilə (ai-server-dəki trend kimi, TREND_TZ_OFFSET_H).
import type { Deps } from "./deps.js";
import type { LiveChat, TenantRecord } from "./store/types.js";

const TZ_H = Number(process.env.TREND_TZ_OFFSET_H ?? 4);
const DAY = 86_400_000;
export const dayKey = (d: Date | string | number) => new Date(new Date(d).getTime() + TZ_H * 3_600_000).toISOString().slice(0, 10);

export type Csat = { good: number; neutral: number; bad: number; avg: number | null };
export type PeriodMetrics = {
  aiChats: number | null; questions: number | null; unanswered: number | null; resolution: number | null;
  liveNew: number; liveClosed: number; missed: number; firstResponseSec: number | null; durationSec: number | null; csat: Csat;
  leadsNew: number; leadsSolved: number; resolveSec: number | null;
  handoffs: number; up: number; down: number; clicks: number; actionsDone: number | null;
};
export type TeamRow = { name: string; chats: number; replies: number; firstResponseSec: number | null; durationSec: number | null; csat: Csat };
export type DailyRow = { day: string; questions: number | null; unanswered: number | null; live: number; leads: number; csatBad: number };
export type Report = {
  days: number; from: string; to: string; prevFrom: string; prevTo: string; generatedAt: string; logOn: boolean;
  cur: PeriodMetrics; prev: PeriodMetrics | null; daily: DailyRow[]; team: TeamRow[];
  top: { message: string; count: number }[]; topNoResults: { message: string; count: number }[];
};

type Lead = { at: string; status?: string; handled?: boolean; history?: { at: string; e: string }[]; updatedAt?: string };
const avg = (xs: number[]) => (xs.length ? Math.round(xs.reduce((a, b) => a + b, 0) / xs.length) : null);
const csatOf = (rs: number[]): Csat => ({ good: rs.filter((r) => r >= 4).length, neutral: rs.filter((r) => r === 3).length, bad: rs.filter((r) => r <= 2).length, avg: rs.length ? Math.round((rs.reduce((a, b) => a + b, 0) / rs.length) * 10) / 10 : null });
const inRange = (d: Date | string, a: number, b: number) => { const x = new Date(d).getTime(); return x >= a && x < b; };

/** Bir canlı söhbətin göstəriciləri: ilk cavab (ziyarətçinin ilk mesajından operatorun ilk cavabına), müddət (başlanğıcdan bağlanmaya) */
export function chatTimes(c: LiveChat): { firstResponseSec: number | null; durationSec: number | null; operators: string[]; answered: boolean } {
  const firstV = c.messages.find((m) => m.from === "visitor");
  const firstOp = c.messages.find((m) => m.from === "operator");
  const start = firstV ? new Date(firstV.at).getTime() : c.createdAt.getTime();
  const closedAt = c.status === "closed" ? [...c.messages].reverse().find((m) => m.from === "system" && m.text === "closed")?.at ?? c.updatedAt : null;
  return {
    firstResponseSec: firstOp ? Math.max(0, Math.round((new Date(firstOp.at).getTime() - start) / 1000)) : null,
    durationSec: closedAt ? Math.max(0, Math.round((new Date(closedAt).getTime() - c.createdAt.getTime()) / 1000)) : null,
    operators: [...new Set(c.messages.filter((m) => m.from === "operator" && m.by).map((m) => m.by!))],
    answered: Boolean(firstOp),
  };
}

function liveMetrics(chats: LiveChat[], a: number, b: number) {
  const inP = chats.filter((c) => inRange(c.createdAt, a, b));
  const times = inP.map(chatTimes);
  const closed = inP.filter((c) => c.status === "closed");
  return {
    liveNew: inP.length, liveClosed: closed.length,
    missed: closed.filter((c) => !c.messages.some((m) => m.from === "operator")).length,
    firstResponseSec: avg(times.map((x) => x.firstResponseSec).filter((x): x is number => x !== null)),
    durationSec: avg(times.map((x) => x.durationSec).filter((x): x is number => x !== null)),
    csat: csatOf(inP.filter((c) => c.csat).map((c) => c.csat!.rating)),
  };
}
function leadMetrics(leads: Lead[], a: number, b: number) {
  const solvedAt = (l: Lead) => [...(l.history ?? [])].reverse().find((h) => h.e === "status:solved")?.at ?? ((l.status === "solved" || l.handled) && l.updatedAt ? l.updatedAt : null);
  const solved = leads.map((l) => ({ l, s: solvedAt(l) })).filter((x) => x.s && inRange(x.s, a, b));
  return {
    leadsNew: leads.filter((l) => inRange(l.at, a, b)).length,
    leadsSolved: solved.length,
    resolveSec: avg(solved.map((x) => Math.max(0, Math.round((new Date(x.s!).getTime() - new Date(x.l.at).getTime()) / 1000)))),
  };
}

export async function buildReport(deps: Deps, t: TenantRecord, days: number, now = Date.now()): Promise<Report> {
  const { ai, store } = deps;
  const to = now, from = now - days * DAY, prevFrom = now - 2 * days * DAY;
  const twoN = days * 2;
  const ok = <T>(p: Promise<T>) => p.catch(() => null);
  const [s1, s2, trend, leadsR, open, closed, fbAll, fbCur, clAll, clCur, act1, act2] = await Promise.all([
    ok(ai.queryStats(t.tenantId, days)), twoN <= 90 ? ok(ai.queryStats(t.tenantId, twoN)) : Promise.resolve(null),
    ok(ai.queryTrend(t.tenantId, Math.min(twoN, 90))), ok(ai.kbLeads(t.tenantId)),
    store.listLive(t.tenantId, "open", 1000), store.listLive(t.tenantId, "closed", 3000),
    store.feedbackCounts(t.tenantId, new Date(prevFrom)).catch(() => ({ up: 0, down: 0 })), store.feedbackCounts(t.tenantId, new Date(from)).catch(() => ({ up: 0, down: 0 })),
    store.countClicks(t.tenantId, new Date(prevFrom)).catch(() => 0), store.countClicks(t.tenantId, new Date(from)).catch(() => 0),
    ok(ai.actionStats(t.tenantId, days)), twoN <= 90 ? ok(ai.actionStats(t.tenantId, twoN)) : Promise.resolve(null),
  ]) as [Record<string, unknown> | null, Record<string, unknown> | null, { enabled?: boolean; daily?: { day: string; total: number; unanswered: number }[] } | null, { items?: Lead[] } | null, LiveChat[], LiveChat[], { up: number; down: number }, { up: number; down: number }, number, number, { done?: number } | null, { done?: number } | null];
  const logOn = (s1?.enabled ?? true) !== false;
  const chats = [...open, ...closed];
  const leads = leadsR?.items ?? [];
  const tday = (trend?.daily ?? []);
  const curKeys = new Set(Array.from({ length: days }, (_, i) => dayKey(now - i * DAY)));
  const sumTrend = (keys: (k: string) => boolean, f: "total" | "unanswered") => tday.filter((d) => keys(d.day)).reduce((a, d) => a + d[f], 0);
  const hasPrevTrend = twoN <= 90;

  const period = (a: number, b: number, isCur: boolean): PeriodMetrics => {
    const lv = liveMetrics(chats, a, b), ld = leadMetrics(leads, a, b);
    const n = (k: string) => Number((s1 as Record<string, unknown> | null)?.[k] ?? 0);
    const n2 = (k: string) => Number((s2 as Record<string, unknown> | null)?.[k] ?? 0);
    const aiChats = !logOn ? null : isCur ? (typeof s1?.conversations === "number" ? s1.conversations as number : null) : s2 && typeof s2.conversations === "number" ? Math.max(0, (s2.conversations as number) - n("conversations")) : null;
    const questions = !logOn ? null : isCur ? (tday.length ? sumTrend((k) => curKeys.has(k), "total") : n("total")) : hasPrevTrend ? (tday.length ? sumTrend((k) => !curKeys.has(k), "total") : Math.max(0, n2("total") - n("total"))) : null;
    const unanswered = !logOn ? null : isCur ? (tday.length ? sumTrend((k) => curKeys.has(k), "unanswered") : n("noResults")) : hasPrevTrend ? (tday.length ? sumTrend((k) => !curKeys.has(k), "unanswered") : null) : null;
    const handoffs = lv.liveNew + ld.leadsNew;
    const fb = isCur ? fbCur : { up: Math.max(0, fbAll.up - fbCur.up), down: Math.max(0, fbAll.down - fbCur.down) };
    return {
      aiChats, questions, unanswered, resolution: aiChats ? Math.max(0, Math.round(((aiChats - handoffs) / aiChats) * 100)) : null,
      ...lv, ...ld, handoffs, up: fb.up, down: fb.down, clicks: isCur ? clCur : Math.max(0, clAll - clCur),
      actionsDone: isCur ? (typeof act1?.done === "number" ? act1.done : null) : act2 && typeof act2.done === "number" && typeof act1?.done === "number" ? Math.max(0, act2.done - act1.done) : null,
    };
  };

  // Gündəlik bölgü (yeni gün əvvəl deyil, xronoloji)
  const trendBy = new Map(tday.map((d) => [d.day, d]));
  const daily: DailyRow[] = [...curKeys].sort().map((day) => ({
    day, questions: logOn ? trendBy.get(day)?.total ?? 0 : null, unanswered: logOn ? trendBy.get(day)?.unanswered ?? 0 : null,
    live: chats.filter((c) => dayKey(c.createdAt) === day).length, leads: leads.filter((l) => dayKey(l.at) === day).length,
    csatBad: chats.filter((c) => c.csat && c.csat.rating <= 2 && dayKey(c.csat.at ?? c.createdAt) === day).length,
  }));

  // Komanda: cari dövrdəki söhbətlər, hər operator üzrə
  const byOp = new Map<string, { chats: number; replies: number; first: number[]; dur: number[]; csat: number[] }>();
  for (const c of chats.filter((x) => inRange(x.createdAt, from, to))) {
    const tm = chatTimes(c);
    const firstOp = c.messages.find((m) => m.from === "operator")?.by;
    for (const name of tm.operators) {
      const r = byOp.get(name) ?? { chats: 0, replies: 0, first: [], dur: [], csat: [] };
      r.chats++; r.replies += c.messages.filter((m) => m.from === "operator" && m.by === name).length;
      if (name === firstOp && tm.firstResponseSec !== null) r.first.push(tm.firstResponseSec);
      if (tm.durationSec !== null) r.dur.push(tm.durationSec);
      if (c.csat && (c.assignee?.name ?? firstOp) === name) r.csat.push(c.csat.rating);
      byOp.set(name, r);
    }
  }
  const team: TeamRow[] = [...byOp.entries()].map(([name, r]) => ({ name, chats: r.chats, replies: r.replies, firstResponseSec: avg(r.first), durationSec: avg(r.dur), csat: csatOf(r.csat) })).sort((a, b) => b.chats - a.chats);

  const list = (v: unknown) => (Array.isArray(v) ? v : []).slice(0, 10) as { message: string; count: number }[];
  return {
    days, from: new Date(from).toISOString(), to: new Date(to).toISOString(), prevFrom: new Date(prevFrom).toISOString(), prevTo: new Date(from).toISOString(), generatedAt: new Date(now).toISOString(), logOn,
    cur: period(from, to, true), prev: twoN <= 180 ? period(prevFrom, from, false) : null, daily, team,
    top: list(s1?.top), topNoResults: list(s1?.topNoResults),
  };
}
