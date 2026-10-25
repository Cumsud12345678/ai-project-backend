// Bilik bazası üçün köməkçilər (portal tərəfi).
/** Telefon və ya e-poçt: düzgündürsə təmizlənmiş mətn, yoxsa null. */
export function cleanContact(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const s = v.trim().slice(0, 120);
  if (/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(s)) return s;
  const digits = s.replace(/\D/g, "");
  return /^[+(\d][\d\s().-]{5,}$/.test(s) && digits.length >= 7 && digits.length <= 15 ? s : null;
}

export const KB_MODES = ["listings", "support", "both"] as const;
