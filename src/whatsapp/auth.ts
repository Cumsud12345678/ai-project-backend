// Baileys sessiya açarlarını bazada şifrəli saxlayan "auth state" (kitabxananın fayl əsaslı variantı istehsalat üçün yararsızdır).
import { BufferJSON, initAuthCreds, proto } from "@whiskeysockets/baileys";
import type { AuthenticationCreds, SignalDataTypeMap, SignalKeyStore } from "@whiskeysockets/baileys";
import { decryptSecret, encryptSecret } from "../secrets.js";
import type { Store } from "../store/types.js";

const enc = (v: unknown, secret: string) => encryptSecret(JSON.stringify(v, BufferJSON.replacer), secret);
const dec = (blob: string, secret: string) => JSON.parse(decryptSecret(blob, secret), BufferJSON.reviver);

export async function useStoreAuthState(store: Store, tenantId: string, secret: string) {
  const stored = (await store.getWaAuth(tenantId, ["creds"]))["creds"];
  const creds: AuthenticationCreds = stored ? dec(stored, secret) : initAuthCreds();
  const keys: SignalKeyStore = {
    async get<T extends keyof SignalDataTypeMap>(type: T, ids: string[]) {
      const names = ids.map((id) => `${type}-${id}`);
      const rows = await store.getWaAuth(tenantId, names);
      const out: { [id: string]: SignalDataTypeMap[T] } = {};
      ids.forEach((id, i) => {
        const blob = rows[names[i]!];
        if (!blob) return;
        let v = dec(blob, secret);
        if (type === "app-state-sync-key" && v) v = proto.Message.AppStateSyncKeyData.fromObject(v);
        out[id] = v;
      });
      return out;
    },
    async set(data) {
      const entries: Record<string, string | null> = {};
      for (const category of Object.keys(data) as (keyof SignalDataTypeMap)[]) {
        for (const [id, value] of Object.entries(data[category] ?? {})) entries[`${category}-${id}`] = value ? enc(value, secret) : null;
      }
      await store.setWaAuth(tenantId, entries);
    },
  };
  return { state: { creds, keys }, saveCreds: () => store.setWaAuth(tenantId, { creds: enc(creds, secret) }) };
}
