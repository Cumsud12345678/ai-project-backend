// Canlı söhbətdə operatorun göndərdiyi fayllar: şəkil (PNG/JPEG/WebP, 2 MB) və ya PDF (4 MB).
// Baytlar live_files-da saxlanır; Telegram faylı özü yükləsin deyə müddətli imzalı link verilir (açar CHANNEL_SECRET_KEY).
import { createHmac, timingSafeEqual } from "node:crypto";
import { HttpError } from "./http.js";
import { checkBase64Image } from "./image-input.js";
import type { Config } from "./config.js";

export const LIVE_PDF_MAX_BYTES = 4_000_000;
export type OperatorFile = { b64: string; mime: "image/png" | "image/jpeg" | "image/webp" | "application/pdf"; name: string };

/** Panel faylı base64 göndərir. Tip baytlardan təyin olunur (fayl adına və brauzerin dediyinə güvənilmir). */
export function parseOperatorFile(body: unknown): OperatorFile {
  const b = (body && typeof body === "object" ? body : {}) as { data?: unknown; name?: unknown };
  const raw = typeof b.data === "string" ? b.data.replace(/^data:[a-z/+.-]+;base64,/i, "") : "";
  const name = (typeof b.name === "string" ? b.name : "").replace(/[\u0000-\u001f\u007f/\\]/g, "").trim().slice(0, 120) || "fayl";
  const img = checkBase64Image(raw);
  if (img) {
    const buf = Buffer.from(img, "base64");
    const mime = buf[0] === 0x89 ? "image/png" : buf[0] === 0xff ? "image/jpeg" : "image/webp";
    return { b64: img, mime, name };
  }
  if (raw && raw.length <= Math.ceil(LIVE_PDF_MAX_BYTES * 4 / 3) + 8 && /^[A-Za-z0-9+/]+={0,2}$/.test(raw)) {
    const buf = Buffer.from(raw, "base64");
    if (buf.length <= LIVE_PDF_MAX_BYTES && buf.subarray(0, 5).toString("latin1") === "%PDF-") return { b64: raw, mime: "application/pdf", name: /\.pdf$/i.test(name) ? name : `${name}.pdf` };
  }
  throw new HttpError(400, "Fayl şəkil (PNG, JPG, WebP, ən çox 2 MB) və ya PDF (ən çox 4 MB) olmalıdır", "BAD_FILE");
}

const sig = (secret: string, tenantId: string, fid: string, exp: number) => createHmac("sha256", secret).update(`livefile:${tenantId}:${fid}:${exp}`).digest("base64url");

/** Telegram üçün 1 saatlıq ictimai link. Açar yoxdursa null (kanalda fayl göndərilmir). */
export function signedFileUrl(config: Pick<Config, "secretKey" | "publicPortalUrl">, tenantId: string, fid: string): string | null {
  if (!config.secretKey) return null;
  const exp = Math.floor(Date.now() / 1000) + 3600;
  return `${config.publicPortalUrl}/widget/f/${encodeURIComponent(tenantId)}/${encodeURIComponent(fid)}?e=${exp}&s=${sig(config.secretKey, tenantId, fid, exp)}`;
}
export function checkFileSig(secret: string, tenantId: string, fid: string, e: unknown, s: unknown): boolean {
  const exp = Number(e);
  if (!secret || !Number.isInteger(exp) || exp < Date.now() / 1000 || typeof s !== "string") return false;
  const a = Buffer.from(sig(secret, tenantId, fid, exp)), b = Buffer.from(s);
  return a.length === b.length && timingSafeEqual(a, b);
}
