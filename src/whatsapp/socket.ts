// Həqiqi Baileys socketi. Yalnız ilk istifadədə yüklənir (testlər və WhatsApp qoşulmayan serverlər kitabxananı yükləmir).
import makeWASocket, { Browsers, makeCacheableSignalKeyStore } from "@whiskeysockets/baileys";
import type { Deps } from "../deps.js";
import type { WaSocket } from "./manager.js";
import { useStoreAuthState } from "./auth.js";

const quiet = { level: "silent", child() { return quiet; }, trace() {}, debug() {}, info() {}, warn() {}, error() {} };

export async function createBaileysSocket(o: { tenantId: string; deps: Deps }): Promise<WaSocket> {
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
  sock.ev.on("creds.update", () => { void saveCreds().catch(() => {}); });
  return sock as unknown as WaSocket;
}
