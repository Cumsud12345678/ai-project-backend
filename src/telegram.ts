// Telegram Bot API müştərisi. Token URL-də gedir, ona görə xəta mətnlərinə və jurnala heç vaxt URL yazılmır.
export class TelegramError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

export type TelegramBot = { id: number; username: string };
export type TelegramApi = {
  getMe(token: string): Promise<TelegramBot>;
  setWebhook(token: string, o: { url: string; secret: string }): Promise<void>;
  deleteWebhook(token: string): Promise<void>;
  sendMessage(token: string, chatId: string, text: string): Promise<void>;
  sendPhoto(token: string, chatId: string, url: string, caption: string): Promise<void>;
  sendChatAction(token: string, chatId: string): Promise<void>;
};

export function createTelegramApi(fetchFn: typeof fetch = fetch): TelegramApi {
  async function call<T>(token: string, method: string, body?: object): Promise<T> {
    let res: Response;
    try {
      res = await fetchFn(`https://api.telegram.org/bot${token}/${method}`, {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body ?? {}), signal: AbortSignal.timeout(15_000),
      });
    } catch { throw new TelegramError(0, "Telegram-a qoşulmaq olmur"); }
    const data = (await res.json().catch(() => ({}))) as { ok?: boolean; result?: T; description?: string };
    if (!res.ok || !data.ok) throw new TelegramError(res.status, String(data.description ?? `Telegram xətası ${res.status}`).slice(0, 200));
    return data.result as T;
  }
  return {
    async getMe(token) { const r = await call<{ id: number; username?: string }>(token, "getMe"); return { id: r.id, username: r.username ?? "" }; },
    async setWebhook(token, { url, secret }) { await call(token, "setWebhook", { url, secret_token: secret, allowed_updates: ["message"], drop_pending_updates: true }); },
    async deleteWebhook(token) { await call(token, "deleteWebhook", { drop_pending_updates: true }); },
    async sendMessage(token, chatId, text) { await call(token, "sendMessage", { chat_id: chatId, text: text.slice(0, 4000) }); },
    async sendPhoto(token, chatId, url, caption) { await call(token, "sendPhoto", { chat_id: chatId, photo: url, caption: caption.slice(0, 1000) }); },
    async sendChatAction(token, chatId) { await call(token, "sendChatAction", { chat_id: chatId, action: "typing" }); },
  };
}
