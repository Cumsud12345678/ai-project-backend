import { randomUUID } from "node:crypto";
import { MongoClient, MongoServerError, ObjectId, type Db } from "mongodb";
import { DuplicateError, LIVE_MAX_MESSAGES, type CodePurpose, type Announcement, type AuditRecord, type CodeRecord, type ErrorRecord, type FeedbackRecord, type LiveChat, type Session, type Store, type TenantRecord, type User } from "./types.js";

type UserDoc = Omit<User, "id"> & { _id: ObjectId };

const toUser = (d: UserDoc): User => ({ id: d._id.toHexString(), email: d.email, passwordHash: d.passwordHash, verified: d.verified, createdAt: d.createdAt, role: d.role === "admin" ? "admin" : "user" });
const strip = <T extends { _id?: unknown }>(d: T | null): Omit<T, "_id"> | null => {
  if (!d) return null;
  const { _id, ...rest } = d;
  return rest;
};
const isDup = (e: unknown) => e instanceof MongoServerError && e.code === 11000;

export async function createMongoStore(uri: string, dbName: string): Promise<Store> {
  const client = new MongoClient(uri);
  await client.connect();
  const db: Db = client.db(dbName);
  const users = db.collection<UserDoc>("users");
  const sessions = db.collection<Session>("sessions");
  const codes = db.collection<CodeRecord>("codes");
  const tenants = db.collection<TenantRecord>("tenants");
  const lives = db.collection<LiveChat>("live_chats");
  const feedbacks = db.collection<FeedbackRecord>("feedback");
  const errors = db.collection<ErrorRecord>("error_log");
  const audits = db.collection<AuditRecord>("admin_audit");
  const settings = db.collection<{ _id: string; value: unknown }>("settings");

  await Promise.all([
    users.createIndex({ email: 1 }, { unique: true }),
    sessions.createIndex({ tokenHash: 1 }, { unique: true }),
    sessions.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 }),
    sessions.createIndex({ userId: 1 }),
    codes.createIndex({ email: 1, purpose: 1 }, { unique: true }),
    codes.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 }),
    tenants.createIndex({ userId: 1 }, { unique: true }),
    tenants.createIndex({ tenantId: 1 }, { unique: true }),
    lives.createIndex({ id: 1 }, { unique: true }),
    lives.createIndex({ tenantId: 1, status: 1, updatedAt: -1 }),
    lives.createIndex({ updatedAt: 1 }, { expireAfterSeconds: 60 * 24 * 3600 }), // 60 gün sonra silinir
    feedbacks.createIndex({ tenantId: 1, at: -1 }),
    feedbacks.createIndex({ at: 1 }, { expireAfterSeconds: 90 * 24 * 3600 }), // 90 gün sonra silinir
    errors.createIndex({ at: -1 }),
    errors.createIndex({ at: 1 }, { expireAfterSeconds: 30 * 24 * 3600 }), // 30 gün sonra silinir
    errors.createIndex({ fingerprint: 1 }),
    audits.createIndex({ at: -1 }),
    audits.createIndex({ at: 1 }, { expireAfterSeconds: 365 * 24 * 3600 }),
    tenants.createIndex({ "widget.key": 1 }, { unique: true, partialFilterExpression: { "widget.key": { $type: "string" } } }),
  ]);

  const oid = (id: string) => (ObjectId.isValid(id) ? new ObjectId(id) : null);

  return {
    async findUserByEmail(email) { const d = await users.findOne({ email }); return d ? toUser(d) : null; },
    async findUserById(id) {
      const _id = oid(id);
      const d = _id ? await users.findOne({ _id }) : null;
      return d ? toUser(d) : null;
    },
    async createUser({ email, passwordHash }) {
      const doc: UserDoc = { _id: new ObjectId(), email, passwordHash, verified: false, createdAt: new Date(), role: "user" };
      try { await users.insertOne(doc); } catch (e) { throw isDup(e) ? new DuplicateError("email") : e; }
      return toUser(doc);
    },
    async deleteUser(id) { const _id = oid(id); if (_id) await users.deleteOne({ _id }); },
    async updateUser(id, patch) { const _id = oid(id); if (_id) await users.updateOne({ _id }, { $set: patch }); },
    async listUsers(limit) { return (await users.find().sort({ createdAt: -1 }).limit(limit).toArray()).map(toUser); },

    async createSession(s) { await sessions.insertOne({ ...s }); },
    async findSession(tokenHash) { return strip(await sessions.findOne({ tokenHash })) as Session | null; },
    async deleteSession(tokenHash) { await sessions.deleteOne({ tokenHash }); },
    async deleteSessionsForUser(userId) { await sessions.deleteMany({ userId }); },

    async saveCode(c) { await codes.replaceOne({ email: c.email, purpose: c.purpose }, c, { upsert: true }); },
    async findCode(email, purpose) { return strip(await codes.findOne({ email, purpose })) as CodeRecord | null; },
    async bumpCodeAttempts(email, purpose) { await codes.updateOne({ email, purpose }, { $inc: { attempts: 1 } }); },
    async deleteCode(email, purpose: CodePurpose) { await codes.deleteOne({ email, purpose }); },
    async deleteCodesForEmail(email) { await codes.deleteMany({ email }); },

    async findTenantByUser(userId) { return strip(await tenants.findOne({ userId })) as TenantRecord | null; },
    async findTenantById(tenantId) { return strip(await tenants.findOne({ tenantId })) as TenantRecord | null; },
    async findTenantByWidgetKey(key) { return strip(await tenants.findOne({ "widget.key": key })) as TenantRecord | null; },
    async listTenants(limit) { return (await tenants.find().limit(limit).toArray()).map((d) => strip(d) as TenantRecord); },
    async createTenant(t) {
      try { await tenants.insertOne({ ...t }); } catch (e) { throw isDup(e) ? new DuplicateError("tenant") : e; }
    },
    async updateTenant(tenantId, patch) { await tenants.updateOne({ tenantId }, { $set: { ...patch, updatedAt: new Date() } }); },
    async touchWidget(tenantId, at) { await tenants.updateOne({ tenantId, widget: { $exists: true } }, { $set: { "widget.lastSeenAt": at } }); },
    async deleteTenant(tenantId) {
      await tenants.deleteOne({ tenantId });
      await Promise.all([lives.deleteMany({ tenantId }), feedbacks.deleteMany({ tenantId })]);
    },

    async createLive(c) { await lives.insertOne({ ...c }); },
    async getLive(tenantId, id) { return strip(await lives.findOne({ tenantId, id })) as LiveChat | null; },
    async pushLive(tenantId, id, msg, patch = {}) {
      const filter = msg ? { tenantId, id, [`messages.${LIVE_MAX_MESSAGES - 1}`]: { $exists: false } } : { tenantId, id };
      const update = { $set: { ...patch, updatedAt: new Date() }, ...(msg ? { $push: { messages: msg } } : {}) };
      const hit = await lives.findOneAndUpdate(filter, update, { returnDocument: "after" });
      if (hit) return strip(hit) as LiveChat;
      // Mesaj limiti doludursa mesaj əlavə edilmir, amma sahələr yenilənir
      const only = await lives.findOneAndUpdate({ tenantId, id }, { $set: { ...patch, updatedAt: new Date() } }, { returnDocument: "after" });
      return only ? (strip(only) as LiveChat) : null;
    },
    async patchLive(tenantId, id, patch) { await lives.updateOne({ tenantId, id }, { $set: patch }); },
    async listLive(tenantId, status, limit) {
      return (await lives.find({ tenantId, status }).sort({ updatedAt: -1 }).limit(limit).toArray()).map((d) => strip(d) as LiveChat);
    },
    async deleteLiveForTenant(tenantId) { await lives.deleteMany({ tenantId }); },

    async addFeedback(f) { await feedbacks.insertOne({ ...f }); },
    async feedbackSince(tenantId, since, limit) {
      return (await feedbacks.find({ tenantId, at: { $gte: since } }).sort({ at: -1 }).limit(limit).toArray()).map((d) => strip(d) as FeedbackRecord);
    },
    async feedbackCounts(tenantId, since) {
      const rows = await feedbacks.aggregate<{ _id: number; n: number }>([{ $match: { tenantId, at: { $gte: since } } }, { $group: { _id: "$rating", n: { $sum: 1 } } }]).toArray();
      return { up: rows.find((r) => r._id === 1)?.n ?? 0, down: rows.find((r) => r._id === -1)?.n ?? 0 };
    },
    async addError(e) { await errors.insertOne({ ...e, id: randomUUID(), at: e.at ?? new Date() }); },
    async listErrors({ since, source, limit }) {
      const q: Record<string, unknown> = {};
      if (since) q.at = { $gte: since };
      if (source) q.source = source;
      return (await errors.find(q).sort({ at: -1 }).limit(limit).toArray()).map((d) => strip(d) as ErrorRecord);
    },
    async countErrors(since) { return errors.countDocuments({ at: { $gte: since } }); },
    async deleteErrors({ id, fingerprint }) {
      const or = [id ? { id } : null, fingerprint ? { fingerprint } : null].filter(Boolean) as object[];
      if (!or.length) return 0;
      return (await errors.deleteMany({ $or: or })).deletedCount;
    },
    async clearErrors() { return (await errors.deleteMany({})).deletedCount; },
    async addAudit(a) { await audits.insertOne({ ...a, id: randomUUID(), at: new Date() }); },
    async listAudit(limit) { return (await audits.find({}).sort({ at: -1 }).limit(limit).toArray()).map((d) => strip(d) as AuditRecord); },
    async getAnnouncement() { const d = await settings.findOne({ _id: "announcement" }); return (d?.value as Announcement | undefined) ?? null; },
    async setAnnouncement(a) {
      if (a) await settings.updateOne({ _id: "announcement" }, { $set: { value: a } }, { upsert: true });
      else await settings.deleteOne({ _id: "announcement" });
    },
    async close() { await client.close(); },
  };
}
