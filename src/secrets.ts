// Bazada saxlanan üçüncü tərəf sirləri (məs. Telegram bot tokeni) üçün şifrələmə: AES-256-GCM, açar CHANNEL_SECRET_KEY-dən.
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

const keyOf = (secret: string) => createHash("sha256").update(secret).digest();

/** "v1.<iv>.<tag>.<şifrəli mətn>" (base64url). Hər dəfə təsadüfi iv: eyni mətn fərqli görünür. */
export function encryptSecret(plain: string, secret: string): string {
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", keyOf(secret), iv);
  const ct = Buffer.concat([c.update(plain, "utf8"), c.final()]);
  return ["v1", iv.toString("base64url"), c.getAuthTag().toString("base64url"), ct.toString("base64url")].join(".");
}

/** Açar səhv və ya məlumat dəyişdirilibsə xəta atır. */
export function decryptSecret(blob: string, secret: string): string {
  const [v, iv, tag, ct] = blob.split(".");
  if (v !== "v1" || !iv || !tag || !ct) throw new Error("Şifrəli məlumatın formatı yanlışdır");
  const d = createDecipheriv("aes-256-gcm", keyOf(secret), Buffer.from(iv, "base64url"));
  d.setAuthTag(Buffer.from(tag, "base64url"));
  return Buffer.concat([d.update(Buffer.from(ct, "base64url")), d.final()]).toString("utf8");
}
