import { createHash, randomBytes, randomInt, scrypt, timingSafeEqual, type ScryptOptions } from "node:crypto";

const N = 32768, R = 8, P = 1, KEYLEN = 64;
const scryptAsync = (pw: string, salt: Buffer, opts: ScryptOptions) =>
  new Promise<Buffer>((res, rej) => scrypt(pw, salt, KEYLEN, opts, (e, k) => (e ? rej(e) : res(k))));
const opts: ScryptOptions = { N, r: R, p: P, maxmem: 128 * N * R * 2 };

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await scryptAsync(password, salt, opts);
  return `scrypt$${N}$${R}$${P}$${salt.toString("hex")}$${key.toString("hex")}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [alg, n, r, p, saltHex, keyHex] = stored.split("$");
  if (alg !== "scrypt" || !saltHex || !keyHex) return false;
  const expected = Buffer.from(keyHex, "hex");
  const key = await scryptAsync(password, Buffer.from(saltHex, "hex"), { N: Number(n), r: Number(r), p: Number(p), maxmem: 128 * Number(n) * Number(r) * 2 });
  return key.length === expected.length && timingSafeEqual(key, expected);
}

// Mövcud olmayan hesab üçün də eyni vaxt sərf olunsun deyə.
let dummy: Promise<string> | undefined;
export const dummyHash = () => (dummy ??= hashPassword("dummy-password-for-timing"));

export const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");
export const newSessionToken = () => randomBytes(32).toString("hex");
export const newCode = () => String(randomInt(0, 1_000_000)).padStart(6, "0");
export const hashCode = (email: string, purpose: string, code: string) => sha256(`${email}|${purpose}|${code}`);
export function safeEqualHex(a: string, b: string): boolean {
  const x = Buffer.from(a), y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
export const normalizeEmail = (v: unknown): string | null => {
  if (typeof v !== "string") return null;
  const e = v.trim().toLowerCase();
  return e.length <= 254 && EMAIL_RE.test(e) ? e : null;
};
export const passwordProblem = (v: unknown): string | null =>
  typeof v !== "string" || v.length < 8 ? "Parol ən azı 8 simvol olmalıdır" : v.length > 128 ? "Parol ən çox 128 simvol ola bilər" : null;

/** Sadə yaddaşda sorğu limiti (bir proses). Çox serverdə Redis kimi paylaşılan yerə köçür. */
export function createLimiter() {
  const hits = new Map<string, { count: number; resetAt: number }>();
  return {
    /** true: icazə var. */
    hit(key: string, max: number, windowMs: number): boolean {
      const now = Date.now();
      if (hits.size > 5000) for (const [k, v] of hits) if (v.resetAt <= now) hits.delete(k);
      const cur = hits.get(key);
      if (!cur || cur.resetAt <= now) { hits.set(key, { count: 1, resetAt: now + windowMs }); return true; }
      cur.count += 1;
      return cur.count <= max;
    },
  };
}
export type Limiter = ReturnType<typeof createLimiter>;
