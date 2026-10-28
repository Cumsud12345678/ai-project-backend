import { randomUUID } from "node:crypto";
import { DuplicateError, LIVE_MAX_MESSAGES, type CodePurpose, type Announcement, type AuditRecord, type ChannelSession, type CodeRecord, type ErrorRecord, type FeedbackRecord, type LiveChat, type Session, type Store, type TenantRecord, type User } from "./types.js";

/** Test və DB-siz sınaq üçün. Proses bitəndə məlumat itir. */
export function createMemoryStore(): Store {
  const users = new Map<string, User>();
  const sessions = new Map<string, Session>();
  const codes = new Map<string, CodeRecord>();
  const tenants = new Map<string, TenantRecord>();
  const live = new Map<string, LiveChat>();
  const feedback: FeedbackRecord[] = [];
  const errors: ErrorRecord[] = [];
  const sessionsCh = new Map<string, ChannelSession>();
  const waAuth = new Map<string, string>();
  const audit: AuditRecord[] = [];
  let announcement: Announcement | null = null;
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

    async findTenantByUser(userId) { return [...tenants.values()].find((t) => t.userId === userId) ?? null; },
    async findTenantById(tenantId) { return tenants.get(tenantId) ?? null; },
    async findTenantByTelegramHook(hook) { return [...tenants.values()].find((t) => t.telegram?.hook === hook) ?? null; },
    async findTenantByWidgetKey(key) { return [...tenants.values()].find((t) => t.widget?.key === key) ?? null; },
    async listTenants(limit) { return [...tenants.values()].slice(0, limit); },
    async createTenant(t) {
      if ([...tenants.values()].some((x) => x.userId === t.userId)) throw new DuplicateError("tenant");
      tenants.set(t.tenantId, t);
    },
    async updateTenant(tenantId, patch) {
      const t = tenants.get(tenantId);
      if (t) tenants.set(tenantId, { ...t, ...patch, updatedAt: new Date() });
    },
    async setWidgetLogo(tenantId, logo) {
      const t = tenants.get(tenantId);
      if (!t?.widget) return;
      const { logo: _old, ...rest } = t.widget;
      tenants.set(tenantId, { ...t, widget: logo ? { ...rest, logo } : rest, updatedAt: new Date() });
    },
    async touchWidget(tenantId, at) {
      const t = tenants.get(tenantId);
      if (t?.widget) tenants.set(tenantId, { ...t, widget: { ...t.widget, lastSeenAt: at } });
    },
    async deleteTenant(tenantId) {
      tenants.delete(tenantId);
      for (const [id, c] of live) if (c.tenantId === tenantId) live.delete(id);
      for (let i = feedback.length - 1; i >= 0; i--) if (feedback[i]!.tenantId === tenantId) feedback.splice(i, 1);
      for (const k of [...sessionsCh.keys()]) if (k.startsWith(`${tenantId}|`)) sessionsCh.delete(k);
      for (const k of [...waAuth.keys()]) if (k.startsWith(`${tenantId}|`)) waAuth.delete(k);
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
    async deleteLiveForTenant(tenantId) { for (const [id, c] of live) if (c.tenantId === tenantId) live.delete(id); },

    async addFeedback(f) { feedback.push(f); if (feedback.length > 5000) feedback.shift(); },
    async feedbackSince(tenantId, since, limit) {
      return feedback.filter((f) => f.tenantId === tenantId && f.at >= since).sort((a, b) => b.at.getTime() - a.at.getTime()).slice(0, limit);
    },
    async feedbackCounts(tenantId, since) {
      const mine = feedback.filter((f) => f.tenantId === tenantId && f.at >= since);
      return { up: mine.filter((f) => f.rating === 1).length, down: mine.filter((f) => f.rating === -1).length };
    },
    async getChannelSession(tenantId, channel, chatId) { return sessionsCh.get(`${tenantId}|${channel}|${chatId}`) ?? null; },
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
    async close() {},
  };
}
