import { createHash } from "node:crypto";
import type { Mailer } from "./mailer.js";
import type { ErrorRecord, ErrorSource, Store } from "./store/types.js";

/** Jurnala sirr düşməsin: e-poçt, uzun token/açar, Bearer və parol kimi dəyərlər silinir. */
export function redact(text: string, max = 600): string {
  return text
    .replace(/[^\s@]+@[^\s@]+\.[^\s@]+/g, "[email]")
    .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi, "$1 [gizli]")
    .replace(/\b(re|ca|cais|wk|sk)_[A-Za-z0-9_]{8,}\b/g, "[açar]")
    .replace(/\b[A-Fa-f0-9]{32,}\b/g, "[açar]")
    .replace(/((?:password|parol|token|secret|apikey|api_key)["']?\s*[:=]\s*["']?)[^\s"',}]+/gi, "$1[gizli]")
    .slice(0, max);
}

/** Eyni xətanı qruplaşdırmaq üçün: rəqəmlər və ID-lər normallaşdırılır. */
export function fingerprint(source: string, message: string, path?: string): string {
  const norm = message.toLowerCase().replace(/[0-9a-f]{8,}/g, "#").replace(/\d+/g, "#").slice(0, 160);
  const route = (path ?? "").replace(/[0-9a-f]{8,}|\d+/gi, ":id").replace(/\/widget\/[^/]+/, "/widget/:key");
  return createHash("sha1").update(`${source}|${norm}|${route}`).digest("hex").slice(0, 16);
}

export type ErrorInput = { source: ErrorSource; message: string; code?: string; status?: number; method?: string; path?: string; stack?: string; userId?: string; tenantId?: string };

/** Xətanı bazaya yazır. Heç vaxt xəta atmır: jurnal sistemin özünü yıxmamalıdır. */
export async function recordError(store: Store, e: ErrorInput): Promise<void> {
  try {
    const message = redact(e.message || "Naməlum xəta", 400);
    const path = e.path ? redact(e.path.split("?")[0]!, 200) : undefined;
    const rec: Omit<ErrorRecord, "id" | "at"> = {
      source: e.source, message, fingerprint: fingerprint(e.source, message, path),
      ...(e.code ? { code: e.code.slice(0, 60) } : {}), ...(e.status ? { status: e.status } : {}),
      ...(e.method ? { method: e.method } : {}), ...(path ? { path } : {}),
      ...(e.stack ? { stack: redact(e.stack.split("\n").slice(0, 8).join("\n"), 1200) } : {}),
      ...(e.userId ? { userId: e.userId } : {}), ...(e.tenantId ? { tenantId: e.tenantId } : {}),
    };
    await store.addError(rec);
  } catch (err) { console.error("[errorlog] yazıla bilmədi:", err instanceof Error ? err.message : err); }
}

/** Mailer-in göndərmə xətalarını jurnala yazır və olduğu kimi yenidən atır (çağıran öz davranışını saxlayır). */
export function loggedMailer(mailer: Mailer, store: Store): Mailer {
  return {
    async send(to, subject, text) {
      try { return await mailer.send(to, subject, text); }
      catch (e) {
        await recordError(store, { source: "mail", message: `E-poçt göndərilmədi: ${e instanceof Error ? e.message : String(e)}`, code: "MAIL_FAILED" });
        throw e;
      }
    },
  };
}
