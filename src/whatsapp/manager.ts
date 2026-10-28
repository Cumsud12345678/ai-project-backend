// WhatsApp kanalı (QR ilə, qeyri-rəsmi WhatsApp Web protokolu). Hər müştəri üçün prosesdə bir socket saxlanır.
// DİQQƏT: yalnız TƏK proses işləməlidir: eyni nömrəyə ikinci qoşulma birincini "connection replaced" ilə düşürür.
import { randomBytes } from "node:crypto";
import QRCode from "qrcode";
import { MAX_TEXT, clip, dedupe, handleChat } from "../channel-chat.js";
import type { Deps } from "../deps.js";
import { recordError } from "../errorlog.js";
import { fetchImage } from "../safe-image.js";
import type { TenantRecord, WhatsAppLink } from "../store/types.js";

/** Kitabxanadan asılı olmayan minimal socket interfeysi (testlərdə saxta socket verilir). */
export type WaSocket = {
  ev: { on(event: string, fn: (arg: any) => void): unknown };
  user?: { id?: string } | undefined;
  sendMessage(jid: string, content: { text: string } | { image: Buffer; caption: string }, opts?: { messageId?: string }): Promise<unknown>;
  sendPresenceUpdate(type: "composing" | "paused", jid?: string): Promise<unknown>;
  readMessages(keys: unknown[]): Promise<unknown>;
  /** Gələn şəkilli mesajın baytlarını yükləyir (yoxdursa şəkil qəbul edilmir) */
  downloadMedia?(message: unknown): Promise<Buffer | null>;
  logout(): Promise<unknown>;
  end(err?: Error): void;
};
export type WaFactory = (o: { tenantId: string; deps: Deps }) => Promise<WaSocket>;
export type WaState = "off" | "connecting" | "qr" | "open" | "error" | "replaced";
export type WaView = { connected: boolean; enabled: boolean; phone: string | null; connectedAt: Date | null; state: WaState; qr: string | null; error: string | null; pauseOnOwnReply: boolean; keyReady: boolean };

const LOGGED_OUT = 401, CONN_REPLACED = 440, RESTART_REQUIRED = 515;
const PAUSE_MS = 12 * 60 * 60_000;
const STALE_MSG_MS = 2 * 60_000; // oflayn qalanda yığılmış köhnə mesajlara cavab verilmir
const MAX_SOCKETS = 100;
const MAX_RECONNECTS = 8;
const PRIVATE_JID = /@(s\.whatsapp\.net|lid)$/;
const MEDIA_KEYS = ["imageMessage", "audioMessage", "videoMessage", "documentMessage", "ptvMessage"];

type Entry = {
  tenantId: string; deps: Deps; sock: WaSocket | null; state: WaState; qr: string | null; error: string | null;
  closing: boolean; reconnects: number; ackAt: Date; sentIds: Set<string>; pauses: Map<string, number>; timer?: NodeJS.Timeout;
};

const sleep = (ms: number) => new Promise<void>((r) => (ms > 0 ? setTimeout(r, ms) : r()));
const userPart = (jid: string) => jid.split("@")[0]!.split(":")[0]!;

/** Gələn mesajın mətni; mətn deyilsə null, mediadırsa "" (istifadəçiyə "yalnız yazı" deyilir), digər texniki mesajlarda undefined. */
export function extractText(message: Record<string, any> | null | undefined): string | undefined {
  if (!message) return undefined;
  const m = message.ephemeralMessage?.message ?? message.viewOnceMessage?.message ?? message;
  const t = m.conversation ?? m.extendedTextMessage?.text;
  if (typeof t === "string") return t;
  if (MEDIA_KEYS.some((k) => m[k])) return "";
  return undefined;
}

/** Mesajda şəkil varsa onun obyektini (başlıq: caption), yoxdursa null qaytarır */
export function imageOf(message: Record<string, any> | null | undefined): { caption?: string; fileLength?: unknown } | null {
  if (!message) return null;
  const m = message.ephemeralMessage?.message ?? message.viewOnceMessage?.message ?? message;
  return m.imageMessage && typeof m.imageMessage === "object" ? m.imageMessage : null;
}

/** Mesajda səs (səsli qeyd və ya audio fayl) varsa onun obyektini (seconds: müddət), yoxdursa null qaytarır */
export function audioOf(message: Record<string, any> | null | undefined): { seconds?: unknown } | null {
  if (!message) return null;
  const m = message.ephemeralMessage?.message ?? message.viewOnceMessage?.message ?? message;
  return m.audioMessage && typeof m.audioMessage === "object" ? m.audioMessage : null;
}

export type WhatsAppManager = ReturnType<typeof createWhatsAppManager>;

export function createWhatsAppManager(opts: { factory?: WaFactory; /** cavabdan əvvəl "yazır..." gözləməsi (ms) */ delay?: (text: string) => number; reconnectMs?: (attempt: number) => number; /** ardıcıl mesajları birləşdirmək üçün sakitlik gözləməsi (ms), 0 = söndürülüb */ batchMs?: number } = {}) {
  const batchMs = opts.batchMs ?? 4000;
  const BATCH_MAX_MS = 12_000;
  const batches = new Map<string, { texts: string[]; first: number; timer: NodeJS.Timeout }>();
  const entries = new Map<string, Entry>();
  const delay = opts.delay ?? ((t: string) => Math.min(6000, 1500 + t.length * 15 + Math.random() * 1500));
  const reconnectMs = opts.reconnectMs ?? ((n: number) => Math.min(60_000, 2000 * 2 ** n));
  const factory: WaFactory = opts.factory ?? (async (o) => (await import("./socket.js")).createBaileysSocket(o));

  const fail = (e: Entry, code: string, message: string) => {
    void recordError(e.deps.store, { source: "channel", message: `WhatsApp: ${message}`, tenantId: e.tenantId, code });
  };

  async function wipe(e: Entry, logout: boolean) {
    e.closing = true;
    clearTimeout(e.timer);
    const sock = e.sock;
    e.sock = null;
    if (sock) { try { if (logout) await sock.logout(); } catch { /* telefon artıq ayrılıb ola bilər */ } try { sock.end(undefined); } catch { /* artıq bağlıdır */ } }
    entries.delete(e.tenantId);
  }

  async function link(e: Entry): Promise<WhatsAppLink | null> {
    return (await e.deps.store.findTenantById(e.tenantId))?.whatsapp ?? null;
  }

  async function onOpen(e: Entry) {
    const { store } = e.deps;
    const phone = userPart(e.sock?.user?.id ?? "");
    e.state = "open"; e.qr = null; e.error = null; e.reconnects = 0;
    const t = await store.findTenantById(e.tenantId);
    if (!t) { await wipe(e, true); await store.deleteWaAuth(e.tenantId); return; }
    if (phone && (await store.listTenants(5000)).some((x) => x.tenantId !== e.tenantId && x.whatsapp?.phone === phone)) {
      await wipe(e, true); await store.deleteWaAuth(e.tenantId);
      const stub = { state: "error" as const, error: "Bu nömrə artıq başqa hesaba qoşulub" };
      entries.set(e.tenantId, { ...e, ...stub, sock: null });
      return;
    }
    if (!t.whatsapp || t.whatsapp.phone !== phone) {
      await store.updateTenant(e.tenantId, { whatsapp: { enabled: true, phone, connectedAt: new Date(), ackAt: e.ackAt, pauseOnOwnReply: t.whatsapp?.pauseOnOwnReply ?? true } });
    }
  }

  async function onClose(e: Entry, update: { lastDisconnect?: { error?: { output?: { statusCode?: number }; message?: string } } }) {
    if (e.closing) return;
    const code = update.lastDisconnect?.error?.output?.statusCode;
    console.warn(`[whatsapp] ${e.tenantId}: bağlantı bağlandı (kod ${code ?? "?"}, ${update.lastDisconnect?.error?.message ?? ""})`);
    e.sock = null;
    if (code === LOGGED_OUT) { // istifadəçi telefondan "Əlaqəli cihazlar"dan çıxardı və ya WhatsApp sessiyanı ləğv etdi
      await e.deps.store.deleteWaAuth(e.tenantId);
      await e.deps.store.updateTenant(e.tenantId, { whatsapp: null });
      await e.deps.store.deleteChannelSessions(e.tenantId, "whatsapp");
      entries.delete(e.tenantId);
      return;
    }
    if (code === CONN_REPLACED) { e.state = "replaced"; e.error = "Bu nömrə başqa yerdə açılıb (ikinci server və ya cihaz). Yenidən qoş."; fail(e, "WA_REPLACED", "bağlantı başqa yerdə açıldığı üçün düşdü"); return; }
    if (code === RESTART_REQUIRED) { await start(e); return; } // QR oxunandan sonra kitabxana yenidən qoşulmağı tələb edir
    if (e.reconnects >= MAX_RECONNECTS) { e.state = "error"; e.error = "WhatsApp ilə bağlantı bərpa olunmadı"; fail(e, "WA_GIVEUP", `${MAX_RECONNECTS} cəhddən sonra bağlantı bərpa olunmadı (${code ?? "?"})`); return; }
    e.state = "connecting";
    e.timer = setTimeout(() => { void start(e).catch((err) => { e.state = "error"; e.error = "Qoşulmaq alınmadı"; fail(e, "WA_START", err instanceof Error ? err.message : String(err)); }); }, reconnectMs(e.reconnects++));
    e.timer.unref?.();
  }

  // WA_DEBUG=1: hər gələn mesajın niyə cavablandırıldığı və ya buraxıldığı konsola yazılır (səbəb axtarmaq üçün)
  const dbg = (e: Entry, jid: string, why: string) => { if (process.env.WA_DEBUG) console.log(`[whatsapp:debug] ${e.tenantId} ${jid}: ${why}`); };

  async function onMessage(e: Entry, m: Record<string, any>) {
    const { deps } = e;
    const jid = String(m?.key?.remoteJid ?? "");
    if (!PRIVATE_JID.test(jid) || !m.key?.id) return dbg(e, jid, "şəxsi söhbət deyil (qrup/status/kanal)"); // qruplar, status, kanallar: cavab verilmir
    const t = await deps.store.findTenantById(e.tenantId);
    const wl = t?.whatsapp;
    if (!t || !wl) return dbg(e, jid, "tenant/WhatsApp qeydi yoxdur");
    if (m.key.fromMe) {
      dbg(e, jid, "özümüzdən gedən mesaj");
      // Sahib özü telefondan yazdı (botun göndərdiyi deyil) → bu söhbətdə bot bir müddət susur
      if (wl.pauseOnOwnReply && !e.sentIds.has(m.key.id) && extractText(m.message) !== undefined) e.pauses.set(jid, Date.now() + PAUSE_MS);
      return;
    }
    if (!wl.enabled) return dbg(e, jid, "köməkçi söndürülüb");
    const img = imageOf(m.message);
    const aud = audioOf(m.message);
    const text = img ? (typeof img.caption === "string" ? img.caption : "") : extractText(m.message);
    if (text === undefined) return dbg(e, jid, `mətn deyil (${Object.keys(m.message ?? {}).join(",") || "boş"})`);
    const ts = Number(m.messageTimestamp?.low ?? m.messageTimestamp ?? 0) * 1000;
    if (ts && Date.now() - ts > STALE_MSG_MS) return dbg(e, jid, "köhnə mesaj");
    if (dedupe(`wa:${e.tenantId}:${m.key.id}`)) return dbg(e, jid, "təkrar mesaj");
    const until = e.pauses.get(jid);
    if (until && until > Date.now()) return dbg(e, jid, "sahib yazdığı üçün susdurulub");
    if (until) e.pauses.delete(jid);
    // Nömrənin qadağan olunmaması üçün sərt tavan: müştəri başına saatda 150 cavab
    if (!deps.limiter.hit(`wa:cap:${e.tenantId}`, 150, 60 * 60_000)) return dbg(e, jid, "saatlıq tavan");
    const sock = e.sock;
    if (!sock) return dbg(e, jid, "socket yoxdur");
    dbg(e, jid, "emal olunur");
    void sock.readMessages([m.key]).catch(() => {});
    const key = `${e.tenantId}|${jid}`;
    const run = (txt: string, withImage = false, audio?: { seconds?: number }) => { const sk = e.sock ?? sock; return runChat(e, sk, jid, m, txt, withImage, audio); };
    if (aud) {
      // Səsli mesaj dərhal işlənir (mətnə çevrilir); gözləyən mətnlər səsin mətninə qatılır
      const pend = batches.get(key);
      if (pend) { clearTimeout(pend.timer); batches.delete(key); }
      const secs = Number(aud.seconds);
      return run((pend?.texts ?? []).join("\n").slice(0, MAX_TEXT), false, { ...(Number.isFinite(secs) && secs > 0 && { seconds: secs }) });
    }
    if (img) {
      // Şəkil dərhal cavablanır; gözləyən mətnlər başlığa qatılır
      const pend = batches.get(key);
      if (pend) { clearTimeout(pend.timer); batches.delete(key); }
      return run([...(pend?.texts ?? []), text].filter(Boolean).join("\n").slice(0, MAX_TEXT), true);
    }
    if (batchMs <= 0) return run(text);
    // Eyni adam dalbadal bir neçə mesaj yazsa, sakitlik olanda hamısı BİR sual kimi cavablanır
    const cur = batches.get(key);
    const entry = cur ?? { texts: [], first: Date.now(), timer: undefined as unknown as NodeJS.Timeout };
    entry.texts.push(text);
    clearTimeout(entry.timer);
    const wait = Math.max(0, Math.min(batchMs, BATCH_MAX_MS - (Date.now() - entry.first)));
    entry.timer = setTimeout(() => {
      batches.delete(key);
      void run(entry.texts.join("\n").slice(0, MAX_TEXT)).catch((err) => fail(e, "WA_MESSAGE", err instanceof Error ? err.message : String(err)));
    }, wait);
    batches.set(key, entry);
  }

  async function runChat(e: Entry, sock: WaSocket, jid: string, m: Record<string, any>, text: string, withImage = false, audio?: { seconds?: number }) {
    const { deps } = e;
    const t = await deps.store.findTenantById(e.tenantId);
    if (!t?.whatsapp?.enabled) return;
    await handleChat(deps, t, {
      channel: "whatsapp", label: "WhatsApp", chatId: userPart(jid), ref: jid, text, senderName: clip(m.pushName, 60),
      typing: () => sock.sendPresenceUpdate("composing", jid),
      ...(audio && { audio: { ...(audio.seconds && { seconds: audio.seconds }), load: async () => (sock.downloadMedia ? sock.downloadMedia(m) : null) } }),
      ...(withImage && { image: { load: async () => (sock.downloadMedia ? sock.downloadMedia(m) : null) } }),
      send: async (reply) => {
        await sleep(delay(reply));
        const id = `3EB0${randomBytes(16).toString("hex").toUpperCase()}`;
        e.sentIds.add(id);
        if (e.sentIds.size > 500) e.sentIds.delete(e.sentIds.values().next().value as string);
        await (e.sock ?? sock).sendMessage(jid, { text: reply }, { messageId: id });
      },
      photo: async (url, caption) => {
        const img = await (deps.imageFetcher ?? fetchImage)(url);
        if (!img) throw new Error("şəkil yüklənmədi");
        await sleep(delay(caption));
        const id = `3EB0${randomBytes(16).toString("hex").toUpperCase()}`;
        e.sentIds.add(id);
        await (e.sock ?? sock).sendMessage(jid, { image: img.data, caption }, { messageId: id });
      },
    });
  }

  async function start(e: Entry) {
    e.closing = false;
    const sock = await factory({ tenantId: e.tenantId, deps: e.deps });
    e.sock = sock;
    sock.ev.on("connection.update", (u: { qr?: string; connection?: string; lastDisconnect?: any }) => {
      if (e.sock !== sock) return; // köhnə socketdən gələn hadisə
      void (async () => {
        try {
          if (u.qr) { e.qr = await QRCode.toDataURL(u.qr, { margin: 3, scale: 5, errorCorrectionLevel: "M" }); if (e.state !== "open") e.state = "qr"; }
          if (u.connection === "open") await onOpen(e);
          else if (u.connection === "close") await onClose(e, u);
        } catch (err) { fail(e, "WA_EVENT", err instanceof Error ? err.message : String(err)); }
      })();
    });
    sock.ev.on("messages.upsert", (up: { messages?: Record<string, any>[]; type?: string }) => {
      if (e.sock !== sock) return;
      if (process.env.WA_DEBUG) console.log(`[whatsapp:debug] ${e.tenantId}: messages.upsert type=${up.type} sayı=${up.messages?.length ?? 0}`);
      for (const m of up.messages ?? []) {
        void onMessage(e, m).catch((err) => fail(e, "WA_MESSAGE", err instanceof Error ? err.message : String(err)));
      }
    });
  }

  async function begin(deps: Deps, tenantId: string, ackAt: Date) {
    const e: Entry = { tenantId, deps, sock: null, state: "connecting", qr: null, error: null, closing: false, reconnects: 0, ackAt, sentIds: new Set(), pauses: new Map() };
    entries.set(tenantId, e);
    try { await start(e); }
    catch (err) { entries.delete(tenantId); throw err; }
    return e;
  }

  const view = (t: TenantRecord, secretKey: string): WaView => {
    const e = entries.get(t.tenantId);
    const l = t.whatsapp;
    return {
      connected: Boolean(l), enabled: Boolean(l?.enabled), phone: l?.phone ?? null, connectedAt: l?.connectedAt ?? null,
      state: e?.state ?? "off", qr: e?.state === "qr" ? e.qr : null, error: e?.error ?? null, pauseOnOwnReply: l?.pauseOnOwnReply ?? true, keyReady: Boolean(secretKey),
    };
  };

  return {
    view,
    isActive: (tenantId: string) => entries.has(tenantId),
    size: () => entries.size,
    /** Yeni QR sessiyası: köhnə açarlar silinir. Artıq açıq sessiya varsa toxunulmur. */
    async connect(deps: Deps, tenantId: string, ackAt: Date) {
      const cur = entries.get(tenantId);
      if (cur && (cur.state === "open" || cur.state === "qr" || cur.state === "connecting")) return;
      if (cur) await wipe(cur, false);
      if (entries.size >= MAX_SOCKETS) throw new Error("WA_FULL");
      await deps.store.deleteWaAuth(tenantId);
      await begin(deps, tenantId, ackAt);
    },
    /** Serverin açılışında əvvəl qoşulmuş nömrələri bərpa edir (CPU və WhatsApp üçün mərhələli). */
    async restoreAll(deps: Deps, gapMs = 1500) {
      if (!deps.config.secretKey) return 0;
      let n = 0;
      for (const t of await deps.store.listTenants(5000)) {
        if (!t.whatsapp || entries.has(t.tenantId)) continue;
        try { await begin(deps, t.tenantId, t.whatsapp.ackAt); n++; }
        catch (err) { void recordError(deps.store, { source: "channel", message: `WhatsApp bərpa olunmadı: ${err instanceof Error ? err.message : err}`, tenantId: t.tenantId, code: "WA_RESTORE" }); }
        await sleep(gapMs);
      }
      return n;
    },
    /** Söndürür: logout=true telefondakı "Əlaqəli cihazlar"dan da çıxarır və açarları silir. */
    async disconnect(deps: Deps, tenantId: string) {
      const e = entries.get(tenantId);
      if (e) await wipe(e, true);
      await deps.store.deleteWaAuth(tenantId);
      await deps.store.deleteChannelSessions(tenantId, "whatsapp");
      await deps.store.updateTenant(tenantId, { whatsapp: null });
    },
    /** Proses bağlananda socketlər qapadılır (logout olmadan: sessiya qalır). */
    async shutdown() { for (const e of [...entries.values()]) await wipe(e, false); },
    /** Operator panelindən yazılan mesajı nömrəyə göndərir (bot öz mesajını "sahib yazdı" saymasın deyə sentIds-ə yazılır). */
    async sendText(tenantId: string, jid: string, text: string) {
      const e = entries.get(tenantId);
      if (!e?.sock || e.state !== "open" || !PRIVATE_JID.test(jid)) throw new Error("WA_NOT_CONNECTED");
      const id = `3EB0${randomBytes(16).toString("hex").toUpperCase()}`;
      e.sentIds.add(id);
      await e.sock.sendMessage(jid, { text }, { messageId: id });
    },
    link,
  };
}
