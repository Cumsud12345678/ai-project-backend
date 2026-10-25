import { randomUUID } from "node:crypto";
import { DuplicateError, type CodePurpose, type CodeRecord, type Session, type Store, type TenantRecord, type User } from "./types.js";

/** Test və DB-siz sınaq üçün. Proses bitəndə məlumat itir. */
export function createMemoryStore(): Store {
  const users = new Map<string, User>();
  const sessions = new Map<string, Session>();
  const codes = new Map<string, CodeRecord>();
  const tenants = new Map<string, TenantRecord>();
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
    async touchWidget(tenantId, at) {
      const t = tenants.get(tenantId);
      if (t?.widget) tenants.set(tenantId, { ...t, widget: { ...t.widget, lastSeenAt: at } });
    },
    async deleteTenant(tenantId) { tenants.delete(tenantId); },
    async close() {},
  };
}
