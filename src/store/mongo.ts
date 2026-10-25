import { MongoClient, MongoServerError, ObjectId, type Db } from "mongodb";
import { DuplicateError, type CodePurpose, type CodeRecord, type Session, type Store, type TenantRecord, type User } from "./types.js";

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

  await Promise.all([
    users.createIndex({ email: 1 }, { unique: true }),
    sessions.createIndex({ tokenHash: 1 }, { unique: true }),
    sessions.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 }),
    sessions.createIndex({ userId: 1 }),
    codes.createIndex({ email: 1, purpose: 1 }, { unique: true }),
    codes.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 }),
    tenants.createIndex({ userId: 1 }, { unique: true }),
    tenants.createIndex({ tenantId: 1 }, { unique: true }),
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
    async deleteTenant(tenantId) { await tenants.deleteOne({ tenantId }); },
    async close() { await client.close(); },
  };
}
