// Ziyarətçi məlumatı (brauzer bildirir) və bloklama. IP və brauzer barmaq izi saxlanmır.
import type { BlockEntry, LiveChat, TenantRecord, VisitorInfo } from "./store/types.js";

const validTz = (tz: string) => { try { new Intl.DateTimeFormat("en-US", { timeZone: tz }); return true; } catch { return false; } };

/** Vidjetin göndərdiyi: tz, first (ilk ziyarət, ms), visits (ziyarət sayı). Səhv dəyərlər atılır. */
export function parseVisitorInfo(b: Record<string, unknown> | undefined): VisitorInfo {
  const o = b ?? {};
  const tz = typeof o.tz === "string" && o.tz.length <= 60 && /^[A-Za-z_]+(\/[A-Za-z0-9_+-]+){0,2}$/.test(o.tz) && validTz(o.tz) ? o.tz : undefined;
  const first = Number.isInteger(o.first) && (o.first as number) > 1_500_000_000_000 && (o.first as number) <= Date.now() + 60_000 ? (o.first as number) : undefined;
  const visits = Number.isInteger(o.visits) && (o.visits as number) >= 1 && (o.visits as number) <= 100_000 ? (o.visits as number) : undefined;
  return { ...(tz && { tz }), ...(first && { first }), ...(visits && { visits }) };
}

/** Söhbətin blok açarı: kanal söhbəti → kanal ID-si, sayt söhbəti → ziyarətçinin pid-i */
export function blockKeyOfChat(chat: Pick<LiveChat, "channel" | "visitor">): string | null {
  if (chat.channel) return `${chat.channel.type === "telegram" ? "tg" : "wa"}:${chat.channel.chatId}`;
  return chat.visitor?.pid ? `v:${chat.visitor.pid}` : null;
}
export const isBlocked = (t: Pick<TenantRecord, "blocked">, key: string | null | undefined): boolean => Boolean(key && t.blocked?.some((b) => b.key === key));
export const MAX_BLOCKS = 500;
export const addBlock = (list: BlockEntry[] | undefined, e: BlockEntry): BlockEntry[] => [e, ...(list ?? []).filter((b) => b.key !== e.key)].slice(0, MAX_BLOCKS);
