import { randomUUID } from "node:crypto";
import { MongoClient, MongoServerError, ObjectId, type AnyBulkWriteOperation, type Db } from "mongodb";
import { DuplicateError, LIVE_MAX_MESSAGES, type CodePurpose, type Announcement, type AuditRecord, type ChannelSession, type CodeRecord, type ErrorRecord, type FeedbackRecord, type LiveChat, type LiveFile, type Session, type Store, type TenantRecord, type User, type UserQuery, type PartnerEntry } from "./types.js";

type UserDoc = Omit<User, "id"> & { _id: ObjectId };

const toUser = (d: UserDoc): User => ({ id: d._id.toHexString(), email: d.email, passwordHash: d.passwordHash, verified: d.verified, createdAt: d.createdAt, role: d.role === "admin" ? "admin" : "user", ...(d.tgNotify?.chatId && { tgNotify: d.tgNotify }), ...(d.totp?.secretEnc && { totp: d.totp }), ...(d.totpPending?.secretEnc && { totpPending: d.totpPending }), ...(d.partner?.code && { partner: d.partner }), ...(d.referredBy?.partnerId && { referredBy: d.referredBy }) });
const strip = <T extends { _id?: unknown }>(d: T | null): Omit<T, "_id"> | null => {
  if (!d) return null;
  const { _id, ...rest } = d;
  return rest;
};
const isDup = (e: unknown) => e instanceof MongoServerError && e.code === 11000;
/** İstifadəçinin yazdığı mətn regex-də hərfi axtarılsın (xüsusi simvollar zərərsizləşir) */
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const NO_LOGO = { "widget.logo.data": 0, "widget.avatar.data": 0 } as const;

export async function createMongoStore(uri: string, dbName: string): Promise<Store> {
  const client = new MongoClient(uri);
  await client.connect();
  const db: Db = client.db(dbName);
  const users = db.collection<UserDoc>("users");
  const sessions = db.collection<Session>("sessions");
  const codes = db.collection<CodeRecord>("codes");
  const tenants = db.collection<TenantRecord>("tenants");
  const lives = db.collection<LiveChat>("live_chats");
  const liveFiles = db.collection<LiveFile>("live_files");
  const feedbacks = db.collection<FeedbackRecord>("feedback");
  const clicksCol = db.collection<{ tenantId: string; at: Date }>("clicks");
  const errors = db.collection<ErrorRecord>("error_log");
  const channelSessions = db.collection<ChannelSession>("channel_sessions");
  const waAuth = db.collection<{ tenantId: string; name: string; value: string }>("wa_auth");
  const audits = db.collection<AuditRecord>("admin_audit");
  const settings = db.collection<{ _id: string; value: unknown }>("settings");
  const partnerEntries = db.collection<Omit<PartnerEntry, "id"> & { _id: ObjectId }>("partner_entries");
  const round2 = (n: number) => Math.round(n * 100) / 100;

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
    lives.createIndex({ tenantId: 1, "channel.type": 1, "channel.chatId": 1, status: 1 }, { sparse: true }),
    lives.createIndex({ updatedAt: 1 }, { expireAfterSeconds: 60 * 24 * 3600 }), // 60 gün sonra silinir
    liveFiles.createIndex({ id: 1 }, { unique: true }),
    liveFiles.createIndex({ tenantId: 1 }),
    liveFiles.createIndex({ at: 1 }, { expireAfterSeconds: 60 * 24 * 3600 }), // söhbətlə eyni müddət
    feedbacks.createIndex({ tenantId: 1, at: -1 }),
    feedbacks.createIndex({ at: 1 }, { expireAfterSeconds: 90 * 24 * 3600 }), // 90 gün sonra silinir
    clicksCol.createIndex({ tenantId: 1, at: -1 }),
    clicksCol.createIndex({ at: 1 }, { expireAfterSeconds: 90 * 24 * 3600 }),
    channelSessions.createIndex({ tenantId: 1, channel: 1, chatId: 1 }, { unique: true }),
    channelSessions.createIndex({ updatedAt: 1 }, { expireAfterSeconds: 14 * 24 * 3600 }), // 14 gün hərəkətsiz qalan söhbət silinir
    tenants.createIndex({ "telegram.hook": 1 }, { unique: true, partialFilterExpression: { "telegram.hook": { $type: "string" } } }),
    waAuth.createIndex({ tenantId: 1, name: 1 }, { unique: true }),
    errors.createIndex({ at: -1 }),
    errors.createIndex({ at: 1 }, { expireAfterSeconds: 30 * 24 * 3600 }), // 30 gün sonra silinir
    errors.createIndex({ fingerprint: 1 }),
    audits.createIndex({ at: -1 }),
    users.createIndex({ createdAt: -1 }),
    users.createIndex({ "partner.code": 1 }, { unique: true, partialFilterExpression: { "partner.code": { $type: "string" } } }),
    users.createIndex({ "referredBy.partnerId": 1 }, { partialFilterExpression: { "referredBy.partnerId": { $type: "string" } } }),
    partnerEntries.createIndex({ sourceRef: 1 }, { unique: true, partialFilterExpression: { sourceRef: { $type: "string" } } }),
    partnerEntries.createIndex({ partnerId: 1, at: -1 }),
    errors.createIndex({ tenantId: 1, at: -1 }),
    audits.createIndex({ at: 1 }, { expireAfterSeconds: 365 * 24 * 3600 }),
    tenants.createIndex({ "widget.key": 1 }, { unique: true, partialFilterExpression: { "widget.key": { $type: "string" } } }),
  ]);

  const oid = (id: string) => (ObjectId.isValid(id) ? new ObjectId(id) : null);
  const userFilter = (q: UserQuery): Record<string, unknown> => {
    const and: Record<string, unknown>[] = [];
    if (q.ids) and.push({ _id: { $in: q.ids.map(oid).filter(Boolean) } });
    if (q.search) and.push({ $or: [{ email: new RegExp(escapeRe(q.search.text), "i") }, { _id: { $in: q.search.ids.map(oid).filter(Boolean) } }] });
    if (q.verified !== undefined) and.push({ verified: q.verified });
    if (q.admins) and.push({ $or: [{ role: "admin" }, { email: { $in: q.admins } }] });
    if (q.since) and.push({ createdAt: { $gte: q.since } });
    return and.length ? { $and: and } : {};
  };

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

    async findTenantByMember(userId) { return strip(await tenants.findOne({ "team.userId": userId })) as TenantRecord | null; },
    async findTenantByTeamEmail(email) { return strip(await tenants.findOne({ "team.email": email })) as TenantRecord | null; },
    async listChannelSessions(tenantId, limit) { return (await channelSessions.find({ tenantId }).sort({ updatedAt: -1 }).limit(limit).toArray()).map((d) => strip(d) as ChannelSession); },
    async findTenantByUser(userId) { return strip(await tenants.findOne({ userId })) as TenantRecord | null; },
    async findTenantById(tenantId) { return strip(await tenants.findOne({ tenantId })) as TenantRecord | null; },
    async findTenantByTelegramHook(hook) { return strip(await tenants.findOne({ "telegram.hook": hook })) as TenantRecord | null; },
    async findTenantByWidgetKey(key) { return strip(await tenants.findOne({ "widget.key": key })) as TenantRecord | null; },
    // Siyahılarda loqonun baytları oxunmur (hər biri onlarla KB): yalnız tək hesab oxunanda gəlir. Bu nəticədən widget-i bazaya geri yazmayın.
    async listTenants(limit) { return (await tenants.find().project({ "widget.logo.data": 0, "widget.avatar.data": 0 }).limit(limit).toArray()).map((d) => strip(d) as TenantRecord); },
    async createTenant(t) {
      try { await tenants.insertOne({ ...t }); } catch (e) { throw isDup(e) ? new DuplicateError("tenant") : e; }
    },
    async updateTenant(tenantId, patch) { await tenants.updateOne({ tenantId }, { $set: { ...patch, updatedAt: new Date() } }); },
    async setWidgetLogo(tenantId, logo, kind = "logo") {
      const f = `widget.${kind}`;
      await tenants.updateOne({ tenantId, widget: { $exists: true } }, logo ? { $set: { [f]: logo, updatedAt: new Date() } } : { $unset: { [f]: "" }, $set: { updatedAt: new Date() } });
    },
    async setAutomationRun(tenantId, id, run, lastDay) {
      const set: Record<string, unknown> = {};
      if (run) set["automations.$[a].lastRun"] = run;
      if (lastDay) set["automations.$[a].lastDay"] = lastDay;
      if (!Object.keys(set).length) return;
      await tenants.updateOne({ tenantId }, { $set: set, ...(run && { $inc: { "automations.$[a].runs": 1 } }) }, { arrayFilters: [{ "a.id": id }] });
    },
    async incCampaignStat(tenantId, id, field) { await tenants.updateOne({ tenantId }, { $inc: { [`campaignStats.${id}.${field}`]: 1 } }); },
    async touchWidget(tenantId, at) { await tenants.updateOne({ tenantId, widget: { $exists: true } }, { $set: { "widget.lastSeenAt": at } }); },
    async deleteTenant(tenantId) {
      await tenants.deleteOne({ tenantId });
      await Promise.all([lives.deleteMany({ tenantId }), liveFiles.deleteMany({ tenantId }), feedbacks.deleteMany({ tenantId }), channelSessions.deleteMany({ tenantId }), waAuth.deleteMany({ tenantId })]);
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
    async findLiveByChannel(tenantId, type, chatId) {
      return strip(await lives.findOne({ tenantId, status: "open", "channel.type": type, "channel.chatId": chatId }, { sort: { updatedAt: -1 } })) as LiveChat | null;
    },
    async listLive(tenantId, status, limit) {
      return (await lives.find({ tenantId, status }).sort({ updatedAt: -1 }).limit(limit).toArray()).map((d) => strip(d) as LiveChat);
    },
    async deleteLive(tenantId, id) {
      const r = await lives.deleteOne({ tenantId, id });
      await liveFiles.deleteMany({ tenantId, chatId: id });
      return r.deletedCount > 0;
    },
    async deleteLiveForTenant(tenantId) { await Promise.all([lives.deleteMany({ tenantId }), liveFiles.deleteMany({ tenantId })]); },
    async addLiveFile(f) { await liveFiles.insertOne({ ...f }); },
    async getLiveFile(tenantId, id) { return strip(await liveFiles.findOne({ tenantId, id })) as LiveFile | null; },

    async addFeedback(f) { await feedbacks.insertOne({ ...f }); },
    async feedbackSince(tenantId, since, limit) {
      return (await feedbacks.find({ tenantId, at: { $gte: since } }).sort({ at: -1 }).limit(limit).toArray()).map((d) => strip(d) as FeedbackRecord);
    },
    async feedbackCounts(tenantId, since) {
      const rows = await feedbacks.aggregate<{ _id: number; n: number }>([{ $match: { tenantId, at: { $gte: since } } }, { $group: { _id: "$rating", n: { $sum: 1 } } }]).toArray();
      return { up: rows.find((r) => r._id === 1)?.n ?? 0, down: rows.find((r) => r._id === -1)?.n ?? 0 };
    },
    async addClick(tenantId, at) { await clicksCol.insertOne({ tenantId, at }); },
    async countClicks(tenantId, since) { return clicksCol.countDocuments({ tenantId, at: { $gte: since } }); },
    async getChannelSession(tenantId, channel, chatId) { return strip(await channelSessions.findOne({ tenantId, channel, chatId })) as ChannelSession | null; },
    async saveChannelSession(s) { await channelSessions.replaceOne({ tenantId: s.tenantId, channel: s.channel, chatId: s.chatId }, { ...s }, { upsert: true }); },
    async deleteChannelSessions(tenantId, channel) { await channelSessions.deleteMany(channel ? { tenantId, channel } : { tenantId }); },
    async getWaAuth(tenantId, names) {
      const out: Record<string, string> = {};
      if (!names.length) return out;
      for (const d of await waAuth.find({ tenantId, name: { $in: names } }).toArray()) out[d.name] = d.value;
      return out;
    },
    async setWaAuth(tenantId, entries) {
      const ops: AnyBulkWriteOperation<{ tenantId: string; name: string; value: string }>[] = [];
      for (const [name, value] of Object.entries(entries)) {
        if (value === null) ops.push({ deleteOne: { filter: { tenantId, name } } });
        else ops.push({ updateOne: { filter: { tenantId, name }, update: { $set: { value } }, upsert: true } });
      }
      if (ops.length) await waAuth.bulkWrite(ops, { ordered: false });
    },
    async deleteWaAuth(tenantId) { await waAuth.deleteMany({ tenantId }); },
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
    async findUserByPartnerCode(code) { const d = await users.findOne({ "partner.code": code.toUpperCase() }); return d ? toUser(d) : null; },
    async listPartners() { return (await users.find({ "partner.code": { $type: "string" } }).sort({ "partner.since": -1 }).limit(1000).toArray()).map(toUser); },
    async listReferred(partnerId) {
      const f = partnerId ? { "referredBy.partnerId": partnerId } : { "referredBy.partnerId": { $type: "string" } };
      return (await users.find(f).sort({ "referredBy.at": -1 }).limit(20_000).toArray()).map(toUser);
    },
    async addPartnerEntry(e) {
      try { await partnerEntries.insertOne({ _id: new ObjectId(), ...e }); return true; }
      catch (err) { if (isDup(err)) return false; throw err; }
    },
    async listPartnerEntries(partnerId, limit) {
      return (await partnerEntries.find({ partnerId }).sort({ at: -1 }).limit(limit).toArray()).map(({ _id, ...rest }) => ({ id: _id.toHexString(), ...rest }));
    },
    async partnerTotals(partnerIds) {
      const match = partnerIds ? { partnerId: { $in: partnerIds } } : {};
      const rows = await partnerEntries.aggregate<{ _id: { p: string; k: string }; s: number }>([{ $match: match }, { $group: { _id: { p: "$partnerId", k: "$kind" }, s: { $sum: "$amountAzn" } } }]).toArray();
      const out: Record<string, { earned: number; adjust: number; paidOut: number; balance: number }> = {};
      for (const r of rows) {
        const t = (out[r._id.p] ??= { earned: 0, adjust: 0, paidOut: 0, balance: 0 });
        if (r._id.k === "commission") t.earned += r.s; else if (r._id.k === "payout") t.paidOut -= r.s; else t.adjust += r.s;
        t.balance += r.s;
      }
      for (const t of Object.values(out)) { t.earned = round2(t.earned); t.adjust = round2(t.adjust); t.paidOut = round2(t.paidOut); t.balance = round2(t.balance); }
      return out;
    },
    async partnerTotalsByCustomer(partnerId) {
      const rows = await partnerEntries.aggregate<{ _id: string; base: number; earned: number }>([{ $match: { partnerId, kind: "commission" } }, { $group: { _id: "$customerId", base: { $sum: "$baseAzn" }, earned: { $sum: "$amountAzn" } } }]).toArray();
      return Object.fromEntries(rows.map((r) => [r._id, { base: round2(r.base), earned: round2(r.earned) }]));
    },
    async getSetting(key) { const d = await settings.findOne({ _id: key }); return (d?.value as never) ?? null; },
    async setSetting(key, value) {
      if (value === null || value === undefined) await settings.deleteOne({ _id: key });
      else await settings.updateOne({ _id: key }, { $set: { value } }, { upsert: true });
    },
    async pageUsers(q) {
      const f = userFilter(q);
      const [items, total] = await Promise.all([users.find(f).sort({ createdAt: -1 }).skip(q.skip).limit(q.limit).toArray(), users.countDocuments(f)]);
      return { items: items.map(toUser), total };
    },
    async countUsers(q = {}) { return users.countDocuments(userFilter(q)); },
    async signupsByDay(since) {
      const rows = await users.aggregate<{ _id: string; n: number }>([{ $match: { createdAt: { $gte: since } } }, { $group: { _id: { $dateToString: { format: "%Y-%m-%d", date: "$createdAt" } }, n: { $sum: 1 } } }]).toArray();
      return rows.map((r) => ({ date: r._id, users: r.n }));
    },
    async findUsersByIds(ids) {
      const oids = ids.map(oid).filter((x): x is ObjectId => Boolean(x));
      return oids.length ? (await users.find({ _id: { $in: oids } }).toArray()).map(toUser) : [];
    },
    async listAdmins(ownerEmails) { return (await users.find({ $or: [{ role: "admin" }, { email: { $in: ownerEmails } }] }).limit(200).toArray()).map(toUser); },
    async findTenantsByIds(tenantIds) { return tenantIds.length ? (await tenants.find({ tenantId: { $in: tenantIds } }).project(NO_LOGO).toArray()).map((d) => strip(d) as TenantRecord) : []; },
    async findTenantsByUserIds(userIds) { return userIds.length ? (await tenants.find({ userId: { $in: userIds } }).project(NO_LOGO).toArray()).map((d) => strip(d) as TenantRecord) : []; },
    async tenantUserIds({ text, suspended, tenantIds }) {
      const f: Record<string, unknown> = {};
      if (text) { const re = new RegExp(escapeRe(text), "i"); f.$or = [{ businessName: re }, { domain: re }, { tenantId: text }]; }
      if (suspended) f.suspended = { $type: "object" };
      if (tenantIds) f.tenantId = { $in: tenantIds };
      return (await tenants.find(f).project<{ userId: string }>({ userId: 1, _id: 0 }).limit(50_000).toArray()).map((d) => d.userId);
    },
    async searchTenants(text, limit) {
      const exact = await tenants.findOne({ tenantId: text }, { projection: NO_LOGO });
      if (exact) return [strip(exact) as TenantRecord];
      const re = new RegExp(escapeRe(text), "i");
      return (await tenants.find({ $or: [{ businessName: re }, { domain: re }] }).project(NO_LOGO).limit(limit).toArray()).map((d) => strip(d) as TenantRecord);
    },
    async tenantStats(activeSince) {
      const [total, suspended, widgetActive, modes] = await Promise.all([
        tenants.countDocuments({}), tenants.countDocuments({ suspended: { $type: "object" } }), tenants.countDocuments({ "widget.lastSeenAt": { $gte: activeSince } }),
        tenants.aggregate<{ _id: unknown; n: number }>([{ $group: { _id: "$config.profile.mode", n: { $sum: 1 } } }]).toArray(),
      ]);
      const m: Record<string, number> = {};
      for (const r of modes) { const k = r._id === "support" || r._id === "both" ? r._id : "listings"; m[k] = (m[k] ?? 0) + r.n; }
      return { total, suspended, widgetActive, modes: m };
    },
    async listChannelTenants() {
      return (await tenants.find({ $or: [{ telegram: { $type: "object" } }, { whatsapp: { $type: "object" } }] }).project(NO_LOGO).limit(20_000).toArray()).map((d) => strip(d) as TenantRecord);
    },
    async lastChannelActivity() {
      const rows = await channelSessions.aggregate<{ _id: { t: string; c: ChannelSession["channel"] }; at: Date }>([{ $group: { _id: { t: "$tenantId", c: "$channel" }, at: { $max: "$updatedAt" } } }]).toArray();
      return rows.map((r) => ({ tenantId: r._id.t, channel: r._id.c, at: r.at }));
    },
    async countErrorsByTenant(since, source) {
      const match: Record<string, unknown> = { at: { $gte: since }, tenantId: { $type: "string" } };
      if (source) match.source = source;
      const rows = await errors.aggregate<{ _id: string; n: number }>([{ $match: match }, { $group: { _id: "$tenantId", n: { $sum: 1 } } }]).toArray();
      return Object.fromEntries(rows.map((r) => [r._id, r.n]));
    },
    async queryAudit({ actor, action, text, before, limit }) {
      const f: Record<string, unknown> = {};
      if (actor) f.actor = new RegExp(escapeRe(actor), "i");
      if (action) f.action = new RegExp(`^${escapeRe(action)}`);
      if (text) { const re = new RegExp(escapeRe(text), "i"); f.$or = [{ target: re }, { detail: re }, { action: re }]; }
      if (before) f.at = { $lt: before };
      return (await audits.find(f).sort({ at: -1 }).limit(limit).toArray()).map((d) => strip(d) as AuditRecord);
    },
    async close() { await client.close(); },
  };
}
