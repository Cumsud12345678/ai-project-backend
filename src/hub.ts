// Canlı söhbət üçün real vaxt "poçtalyonu": hansı soket kimə aiddir və hadisəni kimə göndərmək.
// Soketlər yalnız SİQNAL daşıyır ("yeni mesaj var", "yazır..."). Mesajların özü həmişə HTTP ilə (token və limit yoxlamaları ilə) oxunur,
// buna görə soket qırılsa belə polling ehtiyatda işləyir və heç nə itmir.
// Bir server prosesi üçün işləyir. Çox server olsa, başqa serverə bağlı soket siqnalı almır və polling (45 san) ilə çatır; tam həll üçün Redis pub/sub lazımdır.
import type { WebSocket } from "ws";

export type HubEvent = Record<string, unknown>;

function send(ws: WebSocket, ev: HubEvent) {
  if (ws.readyState !== 1) return;
  try { ws.send(JSON.stringify(ev)); } catch { /* soket artıq bağlanır */ }
}

function createHub() {
  const visitors = new Map<string, Set<WebSocket>>();   // chatId -> ziyarətçi soketləri
  const operators = new Map<string, Set<WebSocket>>();  // tenantId -> operator soketləri
  const add = (m: Map<string, Set<WebSocket>>, k: string, ws: WebSocket) => { (m.get(k) ?? m.set(k, new Set()).get(k)!).add(ws); };
  const del = (m: Map<string, Set<WebSocket>>, k: string, ws: WebSocket) => { const s = m.get(k); if (s) { s.delete(ws); if (!s.size) m.delete(k); } };
  return {
    addVisitor: (chatId: string, ws: WebSocket) => add(visitors, chatId, ws),
    addOperator: (tenantId: string, ws: WebSocket) => add(operators, tenantId, ws),
    removeVisitor: (chatId: string, ws: WebSocket) => del(visitors, chatId, ws),
    removeOperator: (tenantId: string, ws: WebSocket) => del(operators, tenantId, ws),
    visitorSockets: (chatId: string) => visitors.get(chatId) ?? new Set<WebSocket>(),
    operatorCount: (tenantId: string) => operators.get(tenantId)?.size ?? 0,
    toChat: (chatId: string, ev: HubEvent) => { for (const ws of visitors.get(chatId) ?? []) send(ws, ev); },
    toOperators: (tenantId: string, ev: HubEvent) => { for (const ws of operators.get(tenantId) ?? []) send(ws, ev); },
    send,
  };
}

export const hub = createHub();
