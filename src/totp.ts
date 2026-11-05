// İki addımlı giriş: TOTP (RFC 6238, 30 saniyə, 6 rəqəm, SHA-1). Google Authenticator, Authy, 1Password və s. ilə işləyir.
// Xarici kitabxana yoxdur: yalnız node:crypto.
import { createHmac, randomBytes } from "node:crypto";
import { sha256, safeEqualHex } from "./security.js";

const B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
const STEP_SEC = 30;

export function base32Encode(buf: Buffer): string {
  let bits = 0, value = 0, out = "";
  for (const byte of buf) {
    value = (value << 8) | byte; bits += 8;
    while (bits >= 5) { out += B32[(value >>> (bits - 5)) & 31]; bits -= 5; }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(s: string): Buffer {
  const clean = s.toUpperCase().replace(/[\s=-]/g, "");
  let bits = 0, value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    const i = B32.indexOf(ch);
    if (i < 0) throw new Error("Base32 sirri yanlışdır");
    value = (value << 5) | i; bits += 5;
    if (bits >= 8) { out.push((value >>> (bits - 8)) & 255); bits -= 8; }
  }
  return Buffer.from(out);
}

/** 160 bitlik təsadüfi sirr (base32). */
export const newTotpSecret = () => base32Encode(randomBytes(20));

export const stepOf = (ms = Date.now()) => Math.floor(ms / 1000 / STEP_SEC);

export function totpAt(secret: string, step: number): string {
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(step));
  const h = createHmac("sha1", base32Decode(secret)).update(msg).digest();
  const off = h[h.length - 1]! & 15;
  const bin = ((h[off]! & 127) << 24) | (h[off + 1]! << 16) | (h[off + 2]! << 8) | h[off + 3]!;
  return String(bin % 1_000_000).padStart(6, "0");
}

/**
 * Kodu yoxlayır: telefonun saatı bir az fərqli ola bilər, ona görə əvvəlki/sonrakı addım da qəbul olunur.
 * Qaytarır: uyğun gələn addım (təkrar istifadəyə qarşı saxlanmalıdır) və ya null. `afterStep`-dən köhnə kod qəbul olunmur.
 */
export function verifyTotp(secret: string, code: unknown, { now = Date.now(), afterStep = -1 }: { now?: number; afterStep?: number } = {}): number | null {
  if (typeof code !== "string") return null;
  const c = code.replace(/\s/g, "");
  if (!/^\d{6}$/.test(c)) return null;
  const cur = stepOf(now);
  for (const s of [cur - 1, cur, cur + 1]) {
    if (s <= afterStep) continue;
    if (safeEqualHex(sha256(totpAt(secret, s)), sha256(c))) return s;
  }
  return null;
}

export const otpauthUri = (secret: string, account: string, issuer: string) =>
  `otpauth://totp/${encodeURIComponent(`${issuer}:${account}`)}?secret=${secret}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=${STEP_SEC}`;

// Ehtiyat kodlar: telefon itəndə bir dəfəlik giriş. "xxxx-xxxx" formatında, yalnız hash saxlanır.
const BACKUP_ALPHABET = "abcdefghjkmnpqrstuvwxyz23456789";
export function newBackupCodes(n = 8): string[] {
  return Array.from({ length: n }, () => {
    const b = randomBytes(8);
    const s = [...b].map((x) => BACKUP_ALPHABET[x % BACKUP_ALPHABET.length]).join("");
    return `${s.slice(0, 4)}-${s.slice(4, 8)}`;
  });
}
export const normalizeBackup = (code: string) => code.toLowerCase().replace(/[^a-z0-9]/g, "");
export const hashBackup = (userId: string, code: string) => sha256(`backup|${userId}|${normalizeBackup(code)}`);
export const looksLikeBackup = (code: unknown): code is string => typeof code === "string" && /^[a-z0-9]{8}$/.test(normalizeBackup(code));
