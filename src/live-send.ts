// Operatorun canlı söhbətə mesajı: paneldən və ya Telegram bildiriş botundan (bildirişə "Reply") eyni yol.
// Kanal (Telegram/WhatsApp) söhbətində əvvəlcə müştəriyə çatdırılır: alınmasa mesaj yazılmır, operator xətanı görür.
import { deliverToChannel, signText } from "./channel-live.js";
import type { Deps } from "./deps.js";
import { HttpError } from "./http.js";
import { hub } from "./hub.js";
import { mailVisitorReply } from "./live.js";
import type { LiveChat, TenantRecord } from "./store/types.js";
import { nameOf } from "./team.js";

export async function sendOperatorMessage(deps: Deps, t: TenantRecord, user: { id: string; email: string }, chat: LiveChat, text: string): Promise<number> {
  if (!text || text.length > 1000) throw new HttpError(400, "Mesaj 1-1000 simvol olmalıdır");
  if (chat.status === "closed") throw new HttpError(409, "Söhbət bağlanıb", "LIVE_CLOSED");
  if (chat.channel) {
    try { await deliverToChannel(deps, t, chat, signText(t, chat, user.id, text)); }
    catch { throw new HttpError(502, chat.channel.type === "telegram" ? "Mesaj Telegram-a göndərilə bilmədi" : "Mesaj WhatsApp-a göndərilə bilmədi", "CHANNEL_SEND_FAILED"); }
  }
  const who = nameOf(user);
  const next = await deps.store.pushLive(t.tenantId, chat.id, { from: "operator", text, at: new Date(), by: who, uid: user.id }, { operatorSeenAt: new Date(), aiDraft: null, ...(!chat.assignee && { assignee: { userId: user.id, name: who } }) });
  void mailVisitorReply(deps, t, chat, text); // yalnız ziyarətçi çatdan ayrılıbsa və e-poçt yazıbsa
  const total = next?.messages.length ?? chat.messages.length;
  hub.toChat(chat.id, { t: "new", total });                                   // ziyarətçi dərhal oxuyur
  hub.toOperators(t.tenantId, { t: "live", id: chat.id, kind: "message" });   // operatorun digər tabları və komanda yenilənir
  return total;
}
