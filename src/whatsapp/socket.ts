// Həqiqi Baileys socketi. Yalnız ilk istifadədə yüklənir (testlər və WhatsApp qoşulmayan serverlər kitabxananı yükləmir).
import makeWASocket, { Browsers, downloadMediaMessage, makeCacheableSignalKeyStore } from "@whiskeysockets/baileys";
import type { Deps } from "../deps.js";
import type { WaSocket } from "./manager.js";
import { useStoreAuthState } from "./auth.js";

// QR oxunandan dərhal sonra kitabxana yenidən qoşulur (515): yeni socket köhnə (qeydiyyatsız) açarları oxumasın deyə yazılmamış saxlamalar gözlənilir.
const saving = new Map<string, Promise<unknown>>();
export const flushWaAuth = (tenantId: string) => saving.get(tenantId)?.catch(() => {}) ?? Promise.resolve();

const quiet = { level: "silent", child() { return quiet; }, trace() {}, debug() {}, info() {}, warn() {}, error() {} };

export async function createBaileysSocket(o: { tenantId: string; deps: Deps }): Promise<WaSocket> {
  await flushWaAuth(o.tenantId);
  const { state, saveCreds } = await useStoreAuthState(o.deps.store, o.tenantId, o.deps.config.secretKey);
  const sock = makeWASocket({
    auth: { creds: state.creds, keys: makeCacheableSignalKeyStore(state.keys, quiet) },
    browser: Browsers.macOS("Desktop"),
    logger: quiet,
    markOnlineOnConnect: false, // telefonda bildirişlər kəsilməsin
    syncFullHistory: false,
    generateHighQualityLinkPreview: false,
    shouldIgnoreJid: (jid) => !/@(s\.whatsapp\.net|lid)$/.test(jid), // qrup, status, kanal: ümumiyyətlə emal olunmur
    getMessage: async () => undefined,
  });
  sock.ev.on("creds.update", () => {
    const p = (saving.get(o.tenantId) ?? Promise.resolve()).catch(() => {}).then(() => saveCreds()).catch(() => {});
    saving.set(o.tenantId, p);
    void p.finally(() => { if (saving.get(o.tenantId) === p) saving.delete(o.tenantId); });
  });
  const out = sock as unknown as WaSocket;
  // Şəkil yükləmə: ölçü həddindən böyükdürsə heç endirilmir
  out.downloadMedia = async (m) => {
    const msg = (m as any)?.message?.ephemeralMessage?.message ?? (m as any)?.message?.viewOnceMessage?.message ?? (m as any)?.message;
    const media = msg?.imageMessage ?? msg?.audioMessage;
    const len = Number(media?.fileLength?.low ?? media?.fileLength ?? 0);
    if (len > 2_000_000) return null;
    const buf = await downloadMediaMessage(m as any, "buffer", {}, { logger: quiet as any, reuploadRequest: sock.updateMediaMessage });
    return Buffer.isBuffer(buf) ? buf : null;
  };
  return out;
}
