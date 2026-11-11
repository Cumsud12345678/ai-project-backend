// Pulsuz sınaq bir e-poçta bir dəfə verilir. Hesab silinib eyni (və ya gmail-də nöqtəli / +etiketli) e-poçtla
// yenidən açılsa, yeni müştəriyə sınaq və pulsuz məbləğ verilmir. E-poçtun özü saxlanmır, yalnız hash-i.
import { createHash } from "node:crypto";
import type { Store } from "./store/types.js";

const GMAIL = new Set(["gmail.com", "googlemail.com"]);

/** "Ali.Veli+test@GMail.com" → "aliveli@gmail.com". Digər domenlərdə yalnız +etiket atılır. */
export function canonicalEmail(email: string): string {
  const e = email.trim().toLowerCase();
  const at = e.lastIndexOf("@");
  if (at < 1) return e;
  let local = e.slice(0, at).split("+")[0]!;
  let domain = e.slice(at + 1);
  if (GMAIL.has(domain)) { local = local.replace(/\./g, ""); domain = "gmail.com"; }
  return `${local || e.slice(0, at)}@${domain}`;
}

const key = (email: string) => `trial_used:${createHash("sha256").update(canonicalEmail(email)).digest("hex")}`;

export async function trialUsed(store: Store, email: string): Promise<boolean> {
  return Boolean(await store.getSetting(key(email)));
}

export async function markTrialUsed(store: Store, email: string): Promise<void> {
  await store.setSetting(key(email), { at: new Date().toISOString() });
}
