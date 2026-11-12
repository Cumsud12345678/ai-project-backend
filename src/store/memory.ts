import { randomUUID } from "node:crypto";
import { DuplicateError, LIVE_MAX_MESSAGES, type CodePurpose, type Announcement, type AuditRecord, type ChannelSession, type CodeRecord, type ErrorRecord, type FeedbackRecord, type LiveChat, type LiveFile, type Session, type Store, type TenantRecord, type User, type UserQuery, type PartnerEntry, type SetupRequest, type Reminder } from "./types.js";

/** Test və DB-siz sınaq üçün. Proses bitəndə məlumat itir. */
export function createMemoryStore(): Store {
  const users = new Map<string, User>();
  const sessions = new Map<string, Session>();
  const codes = new Map<string, CodeRecord>();
  const tenants = new Map<string, TenantRecord>();
  const live = new Map<string, LiveChat>();
  const liveFiles = new Map<string, LiveFile>();
  const clicks: { tenantId: string; at: Date }[] = [];
  const feedback: FeedbackRecord[] = [];
  const errors: ErrorRecord[] = [];
  const sessionsCh = new Map<string, ChannelSession>();
  const reminders = new Map<string, Reminder>();
  const waAuth = new Map<string, string>();
  const audit: AuditRecord[] = [];
  let announcement: Announcement | null = null;
  const settings = new Map<string, unknown>();
  const setupRequests = new Map<string, SetupRequest>();
  const partnerEntries: PartnerEntry[] = [];
  const round2 = (n: number) => Math.round(n * 100) / 100;
  const userMatch = (u: User, q: UserQuery) =>
    (!q.ids || q.ids.includes(u.id)) &&
    (!q.search || u.email.toLowerCase().includes(q.search.text.toLowerCase()) || q.search.ids.includes(u.id)) &&
    (q.verified === undefined || u.verified === q.verified) &&
    (!q.admins || u.role === "admin" || q.admins.includes(u.email)) &&
    (!q.since || u.createdAt >= q.since);
  const byNewest = (a: User, b: User) => b.createdAt.getTime() - a.createdAt.getTime();
  const tenantText = (t: TenantRecord, text: string) => t.tenantId === text || t.businessName.toLowerCase().includes(text.toLowerCase()) || t.domain.toLowerCase().includes(text.toLowerCase());
  const ck = (email: string, purpose: CodePurpose) => `${email}|${purpose}`;

  return {
    async findUserByEmail(email) { return [...users.values()].find((u) => u.email === email) ?? null; },
    async findUserById(id) { return users.get(id) ?? null; },
    async createUser({ email, passwordHash }) {
      if ([...users.values()].some((u) => u.email === email)) throw new DuplicateError("email");
      const user: User = { id: randomUUID(), email, passwordHash, verified: false, createdAt: new Date(), role: "user" };
      users.set(user.id, user);
      return user;
    },
    async deleteUser(id) { users.delete(id); },
    async updateUser(id, patch) { const u = users.get(id); if (u) users.set(id, { ...u, ...patch }); },
    async listUsers(limit) { return [...users.values()].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime()).slice(0, limit); },

    async createSession(s) { sessions.set(s.tokenHash, s); },
    async findSession(h) {
      const s = sessions.get(h);
      if (s && s.expiresAt.getTime() <= Date.now()) { sessions.delete(h); return null; }
      return s ?? null;
    },
    async deleteSession(h) { sessions.delete(h); },
    async deleteSessionsForUser(userId) { for (const [h, s] of sessions) if (s.userId === userId) sessions.delete(h); },

    async saveCode(c) { codes.set(ck(c.email, c.purpose), c); },
    async findCode(email, purpose) {
      const c = codes.get(ck(email, purpose));
      if (c && c.expiresAt.getTime() <= Date.now()) { codes.delete(ck(email, purpose)); return null; }
      return c ?? null;
    },
    async bumpCodeAttempts(email, purpose) { const c = codes.get(ck(email, purpose)); if (c) c.attempts += 1; },
    async deleteCode(email, purpose) { codes.delete(ck(email, purpose)); },
    async deleteCodesForEmail(email) { for (const [k, c] of codes) if (c.email === email) codes.delete(k); },

    async findTenantByMember(userId) { return [...tenants.values()].find((t) => t.team?.some((m) => m.userId === userId)) ?? null; },
    async findTenantByTeamEmail(email) { return [...tenants.values()].find((t) => t.team?.some((m) => m.email === email)) ?? null; },
    async listChannelSessions(tenantId, limit) { return [...sessionsCh.values()].filter((s) => s.tenantId === tenantId).sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()).slice(0, limit); },
    async findTenantByUser(userId) { return [...tenants.values()].find((t) => t.userId === userId) ?? null; },
    async findTenantById(tenantId) { return tenants.get(tenantId) ?? null; },
    async findTenantByTelegramHook(hook) { return [...tenants.values()].find((t) => t.telegram?.hook === hook) ?? null; },
    async findTenantByWidgetKey(key) { return [...tenants.values()].find((t) => t.widget?.key === key) ?? null; },
    async listTenants(limit) { return [...tenants.values()].slice(0, limit); },
    async createTenant(t) {
      if ([...tenants.values()].some((x) => x.userId === t.userId)) throw new DuplicateError("tenant");
      tenants.set(t.tenantId, t);
    },
    async patchWidget(tenantId, fields) {
      const t = tenants.get(tenantId);
      if (!t?.widget) return;
      const w = { ...t.widget } as Record<string, unknown>;
      for (const [k, v] of Object.entries(fields)) { if (k === "logo" || k === "avatar") continue; if (v === undefined) delete w[k]; else w[k] = structuredClone(v); }
      tenants.set(tenantId, { ...t, widget: w as unknown as TenantRecord["widget"], updatedAt: new Date() });
    },
    async updateTenant(tenantId, patch) {
      const t = tenants.get(tenantId);
      if (t) tenants.set(tenantId, { ...t, ...patch, updatedAt: new Date() });
    },
    async addReminder(r) { reminders.set(r.id, { ...r }); },
    async dueReminders(now, limit) { return [...reminders.values()].filter((r) => r.at <= now).sort((a, b) => a.at.getTime() - b.at.getTime()).slice(0, limit).map((r) => ({ ...r })); },
    async deleteReminder(id) { reminders.delete(id); },
    async deleteRemindersByRef(tenantId, ref) { for (const [k, r] of reminders) if (r.tenantId === tenantId && r.ref === ref) reminders.delete(k); },
    async setOpProfile(tenantId, userId, profile) {
      const t = tenants.get(tenantId);
      if (!t) return;
      const rest = { ...(t.opProfiles ?? {}) };
      delete rest[userId];
      tenants.set(tenantId, { ...t, opProfiles: profile ? { ...rest, [userId]: profile } : rest, updatedAt: new Date() });
    },
    async setWidgetLogo(tenantId, logo, kind = "logo") {
      const t = tenants.get(tenantId);
      if (!t?.widget) return;
      const rest = { ...t.widget };
      delete rest[kind];
      tenants.set(tenantId, { ...t, widget: logo ? { ...rest, [kind]: logo } : rest, updatedAt: new Date() });
    },
    async setAutomationRun(tenantId, id, run, lastDay) {
      const t = tenants.get(tenantId);
      if (!t?.automations) return;
      tenants.set(tenantId, { ...t, automations: t.automations.map((a) => (a.id !== id ? a : { ...a, ...(run && { lastRun: run, runs: (a.runs ?? 0) + 1 }), ...(lastDay && { lastDay }) })) });
    },
    async incCampaignStat(tenantId, id, field) {
      const t = tenants.get(tenantId);
      if (!t) return;
      const all = { ...(t.campaignStats ?? {}) }, cur = { shown: 0, clicked: 0, chats: 0, ...all[id] };
      cur[field] += 1; all[id] = cur;
      tenants.set(tenantId, { ...t, campaignStats: all });
    },
    async touchWidget(tenantId, at) {
      const t = tenants.get(tenantId);
      if (t?.widget) tenants.set(tenantId, { ...t, widget: { ...t.widget, lastSeenAt: at } });
    },
    async deleteTenant(tenantId) {
      tenants.delete(tenantId);
      for (const [id, c] of live) if (c.tenantId === tenantId) live.delete(id);
      for (const [id, f] of liveFiles) if (f.tenantId === tenantId) liveFiles.delete(id);
      for (let i = feedback.length - 1; i >= 0; i--) if (feedback[i]!.tenantId === tenantId) feedback.splice(i, 1);
      for (const k of [...sessionsCh.keys()]) if (k.startsWith(`${tenantId}|`)) sessionsCh.delete(k);
      for (const k of [...waAuth.keys()]) if (k.startsWith(`${tenantId}|`)) waAuth.delete(k);
      for (const [k, r] of reminders) if (r.tenantId === tenantId) reminders.delete(k);
    },

    async createLive(c) { live.set(c.id, c); },
    async getLive(tenantId, id) { const c = live.get(id); return c && c.tenantId === tenantId ? c : null; },
    async pushLive(tenantId, id, msg, patch = {}) {
      const c = live.get(id);
      if (!c || c.tenantId !== tenantId) return null;
      const next: LiveChat = { ...c, ...patch, updatedAt: new Date(), messages: msg && c.messages.length < LIVE_MAX_MESSAGES ? [...c.messages, msg] : c.messages };
      live.set(id, next);
      return next;
    },
    async patchLive(tenantId, id, patch) { const c = live.get(id); if (c && c.tenantId === tenantId) live.set(id, { ...c, ...patch }); },
    async findLiveByChannel(tenantId, type, chatId) {
      return [...live.values()].filter((c) => c.tenantId === tenantId && c.status === "open" && c.channel?.type === type && c.channel.chatId === chatId).sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime())[0] ?? null;
    },
    async listLive(tenantId, status, limit) {
      return [...live.values()].filter((c) => c.tenantId === tenantId && c.status === status).sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime()).slice(0, limit);
    },
    async deleteLive(tenantId, id) {
      const c = live.get(id);
      if (!c || c.tenantId !== tenantId) return false;
      live.delete(id);
      for (const [fid, f] of liveFiles) if (f.tenantId === tenantId && f.chatId === id) liveFiles.delete(fid);
      return true;
    },
    async deleteLiveForTenant(tenantId) { for (const [id, c] of live) if (c.tenantId === tenantId) live.delete(id); for (const [id, f] of liveFiles) if (f.tenantId === tenantId) liveFiles.delete(id); },
    async addLiveFile(f) { liveFiles.set(f.id, { ...f }); },
    async getLiveFile(tenantId, id) { const f = liveFiles.get(id); return f && f.tenantId === tenantId ? { ...f } : null; },

    async addFeedback(f) { feedback.push(f); if (feedback.length > 5000) feedback.shift(); },
    async feedbackSince(tenantId, since, limit) {
      return feedback.filter((f) => f.tenantId === tenantId && f.at >= since).sort((a, b) => b.at.getTime() - a.at.getTime()).slice(0, limit);
    },
    async feedbackCounts(tenantId, since) {
      const mine = feedback.filter((f) => f.tenantId === tenantId && f.at >= since);
      return { up: mine.filter((f) => f.rating === 1).length, down: mine.filter((f) => f.rating === -1).length };
    },
    async addClick(tenantId, at) { clicks.push({ tenantId, at }); if (clicks.length > 20000) clicks.shift(); },
    async countClicks(tenantId, since) { return clicks.filter((c) => c.tenantId === tenantId && c.at >= since).length; },
    async getChannelSession(tenantId, channel, chatId) { return sessionsCh.get(`${tenantId}|${channel}|${chatId}`) ?? null; },
    async getSetupRequest(userId) { const r = setupRequests.get(userId); return r ? structuredClone(r) : null; },
    async saveSetupRequest(r) { setupRequests.set(r.userId, structuredClone(r)); },
    async deleteSetupRequest(userId) { setupRequests.delete(userId); },
    async listSetupRequests({ status, limit }) { return [...setupRequests.values()].filter((r) => !status || r.status === status).sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime()).slice(0, limit).map((r) => structuredClone(r)); },
    async listIdleChannelSessions(from, to, limit) {
      return [...sessionsCh.values()].filter((s) => { const at = new Date(s.updatedAt).getTime(); return at >= from.getTime() && at <= to.getTime(); })
        .sort((a, b) => new Date(a.updatedAt).getTime() - new Date(b.updatedAt).getTime()).slice(0, limit);
    },
    async saveChannelSession(s) { sessionsCh.set(`${s.tenantId}|${s.channel}|${s.chatId}`, s); },
    async deleteChannelSessions(tenantId, channel) { for (const k of [...sessionsCh.keys()]) if (k.startsWith(channel ? `${tenantId}|${channel}|` : `${tenantId}|`)) sessionsCh.delete(k); },
    async getWaAuth(tenantId, names) { const out: Record<string, string> = {}; for (const n of names) { const v = waAuth.get(`${tenantId}|${n}`); if (v !== undefined) out[n] = v; } return out; },
    async setWaAuth(tenantId, entries) { for (const [n, v] of Object.entries(entries)) { if (v === null) waAuth.delete(`${tenantId}|${n}`); else waAuth.set(`${tenantId}|${n}`, v); } },
    async deleteWaAuth(tenantId) { for (const k of [...waAuth.keys()]) if (k.startsWith(`${tenantId}|`)) waAuth.delete(k); },
    async addError(e) { errors.push({ ...e, id: randomUUID(), at: e.at ?? new Date() }); if (errors.length > 2000) errors.shift(); },
    async listErrors({ since, source, limit }) {
      return errors.filter((e) => (!since || e.at >= since) && (!source || e.source === source)).sort((a, b) => b.at.getTime() - a.at.getTime()).slice(0, limit);
    },
    async countErrors(since) { return errors.filter((e) => e.at >= since).length; },
    async deleteErrors({ id, fingerprint }) {
      const before = errors.length;
      for (let i = errors.length - 1; i >= 0; i--) if ((id && errors[i]!.id === id) || (fingerprint && errors[i]!.fingerprint === fingerprint)) errors.splice(i, 1);
      return before - errors.length;
    },
    async clearErrors() { const n = errors.length; errors.length = 0; return n; },
    async addAudit(a) { audit.push({ ...a, id: randomUUID(), at: new Date() }); if (audit.length > 2000) audit.shift(); },
    async listAudit(limit) { return audit.slice(-limit).reverse(); },
    async getAnnouncement() { return announcement; },
    async setAnnouncement(a) { announcement = a; },
    async findUserByPartnerCode(code) { return [...users.values()].find((u) => u.partner?.code === code.toUpperCase()) ?? null; },
    async listPartners() { return [...users.values()].filter((u) => u.partner?.code); },
    async listReferred(partnerId) { return [...users.values()].filter((u) => u.referredBy && (!partnerId || u.referredBy.partnerId === partnerId)); },
    async addPartnerEntry(e) {
      if (e.sourceRef && partnerEntries.some((x) => x.sourceRef === e.sourceRef)) return false;
      partnerEntries.push({ id: randomUUID(), ...e });
      return true;
    },
    async listPartnerEntries(partnerId, limit) { return partnerEntries.filter((x) => x.partnerId === partnerId).sort((a, b) => b.at.getTime() - a.at.getTime()).slice(0, limit); },
    async partnerTotals(partnerIds) {
      const out: Record<string, { earned: number; adjust: number; paidOut: number; balance: number }> = {};
      for (const e of partnerEntries) {
        if (partnerIds && !partnerIds.includes(e.partnerId)) continue;
        const t = (out[e.partnerId] ??= { earned: 0, adjust: 0, paidOut: 0, balance: 0 });
        if (e.kind === "commission") t.earned += e.amountAzn; else if (e.kind === "payout") t.paidOut -= e.amountAzn; else t.adjust += e.amountAzn;
        t.balance += e.amountAzn;
      }
      for (const t of Object.values(out)) { t.earned = round2(t.earned); t.adjust = round2(t.adjust); t.paidOut = round2(t.paidOut); t.balance = round2(t.balance); }
      return out;
    },
    async partnerTotalsByCustomer(partnerId) {
      const out: Record<string, { base: number; earned: number }> = {};
      for (const e of partnerEntries) {
        if (e.partnerId !== partnerId || e.kind !== "commission" || !e.customerId) continue;
        const t = (out[e.customerId] ??= { base: 0, earned: 0 });
        t.base = round2(t.base + (e.baseAzn ?? 0)); t.earned = round2(t.earned + e.amountAzn);
      }
      return out;
    },
    async getSetting(key) { return (structuredClone(settings.get(key)) as never) ?? null; },
    async setSetting(key, value) { if (value === null || value === undefined) settings.delete(key); else settings.set(key, structuredClone(value)); },
    async pageUsers(q) { const all = [...users.values()].filter((u) => userMatch(u, q)).sort(byNewest); return { items: all.slice(q.skip, q.skip + q.limit), total: all.length }; },
    async countUsers(q = {}) { return [...users.values()].filter((u) => userMatch(u, q)).length; },
    async signupsByDay(since) {
      const m = new Map<string, number>();
      for (const u of users.values()) if (u.createdAt >= since) { const k = u.createdAt.toISOString().slice(0, 10); m.set(k, (m.get(k) ?? 0) + 1); }
      return [...m].map(([date, n]) => ({ date, users: n }));
    },
    async findUsersByIds(ids) { return ids.map((id) => users.get(id)).filter((u): u is User => Boolean(u)); },
    async listAdmins(ownerEmails) { return [...users.values()].filter((u) => u.role === "admin" || ownerEmails.includes(u.email)); },
    async findTenantsByIds(ids) { return [...tenants.values()].filter((t) => ids.includes(t.tenantId)); },
    async findTenantsByUserIds(ids) { return [...tenants.values()].filter((t) => ids.includes(t.userId)); },
    async tenantUserIds({ text, suspended, tenantIds }) {
      return [...tenants.values()].filter((t) => (!text || tenantText(t, text)) && (!suspended || Boolean(t.suspended)) && (!tenantIds || tenantIds.includes(t.tenantId))).map((t) => t.userId);
    },
    async searchTenants(text, limit) {
      const exact = tenants.get(text);
      return exact ? [exact] : [...tenants.values()].filter((t) => tenantText(t, text)).slice(0, limit);
    },
    async tenantStats(activeSince) {
      const all = [...tenants.values()];
      const modes: Record<string, number> = {};
      for (const t of all) { const m = (t.config as { profile?: { mode?: string } })?.profile?.mode; const k = m === "support" || m === "both" ? m : "listings"; modes[k] = (modes[k] ?? 0) + 1; }
      return { total: all.length, suspended: all.filter((t) => t.suspended).length, widgetActive: all.filter((t) => t.widget?.lastSeenAt && new Date(t.widget.lastSeenAt) >= activeSince).length, modes };
    },
    async listChannelTenants() { return [...tenants.values()].filter((t) => t.telegram || t.whatsapp); },
    async lastChannelActivity() {
      const m = new Map<string, { tenantId: string; channel: ChannelSession["channel"]; at: Date }>();
      for (const s of sessionsCh.values()) {
        const k = `${s.tenantId}|${s.channel}`, at = new Date(s.updatedAt);
        if (!m.has(k) || m.get(k)!.at < at) m.set(k, { tenantId: s.tenantId, channel: s.channel, at });
      }
      return [...m.values()];
    },
    async countErrorsByTenant(since, source) {
      const out: Record<string, number> = {};
      for (const e of errors) if (e.tenantId && e.at >= since && (!source || e.source === source)) out[e.tenantId] = (out[e.tenantId] ?? 0) + 1;
      return out;
    },
    async queryAudit({ actor, action, text, before, limit }) {
      const lc = (s?: string) => (s ?? "").toLowerCase();
      return audit.filter((a) => (!actor || lc(a.actor).includes(lc(actor))) && (!action || a.action.startsWith(action)) && (!text || [a.target, a.detail, a.action].some((v) => lc(v).includes(lc(text)))) && (!before || a.at < before))
        .slice().reverse().slice(0, limit);
    },
    async close() {},
  };
}
