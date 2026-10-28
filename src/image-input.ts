// Şəkilli sual (widget, Telegram, WhatsApp): yoxlama və limitlər. Şəkil heç yerdə saxlanmır, yalnız AI-a ötürülür.
import type { TenantRecord } from "./store/types.js";
import { sniffImage } from "./safe-image.js";

export const IMAGE_MAX_BYTES = 2_000_000;

/** Sayt sahibi panelden açıbsa (profile.imageSearch) */
export const imageEnabled = (t: TenantRecord) => (t.config as { profile?: { imageSearch?: unknown } } | undefined)?.profile?.imageSearch === true;

/** Base64 mətni yoxlayır: yalnız PNG/JPEG/WebP (baytlardan), ölçü həddi. Uğursuzdursa null. */
export function checkBase64Image(raw: unknown): string | null {
  if (typeof raw !== "string" || raw.length < 20 || raw.length > Math.ceil(IMAGE_MAX_BYTES * 4 / 3) + 8) return null;
  const b64 = raw.replace(/^data:image\/[a-z+]+;base64,/i, "");
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(b64)) return null;
  const buf = Buffer.from(b64, "base64");
  return buf.length <= IMAGE_MAX_BYTES && sniffImage(buf) ? b64 : null;
}

export const AUDIO_MAX_BYTES = 2_000_000;
export const AUDIO_MAX_SECONDS = 60;
/** Səs qeydi baytları: boş olmasın, ölçü həddini aşmasın. Tipi AI servisi baytlardan təyin edir. */
export function checkBufferAudio(buf: Buffer | null | undefined): string | null {
  if (!buf || buf.length < 16 || buf.length > AUDIO_MAX_BYTES) return null;
  return buf.toString("base64");
}

export function checkBufferImage(buf: Buffer | null | undefined): string | null {
  if (!buf || buf.length === 0 || buf.length > IMAGE_MAX_BYTES || !sniffImage(buf)) return null;
  return buf.toString("base64");
}
