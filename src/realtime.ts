// Canlı söhbət üçün WebSocket: yalnız siqnal ("yeni mesaj var", "yazır..."). Mesajlar HTTP ilə oxunur/yazılır (src/widget.ts, src/routes/tenant.ts).
//  - Ziyarətçi: {t:"auth", role:"visitor", key, id, token}: widget açarı + Origin + söhbət tokeni yoxlanır (HTTP ilə eyni qaydalar).
//  - Operator: {t:"auth", role:"operator", ticket}: panel əvvəlcə giriş edilmiş sessiya ilə qısa ömürlü bilet alır (POST /tenant/live/ws-ticket).
//  Soket yalnız auth mesajından sonra hadisə alır; 5 saniyədə auth olmasa bağlanır.
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, Server } from "node:http";
import { WebSocketServer, type WebSocket } from "ws";
import type { Deps } from "./deps.js";
import { hub } from "./hub.js";
import { WIDGET_KEY_RE, originAllowed, sameToken } from "./widget.js";

const MAX_PAYLOAD = 2048;
const AUTH_TIMEOUT_MS = 5_000;
const PING_MS = 25_000;
const OPERATOR_LIFETIME_MS = 60 * 60_000; // saatda bir yenidən qoşulur: bitmiş sessiya ilə soket açıq qalmasın
const MAX_PER_IP = 30;
const MAX_VISITOR_SOCKETS_PER_CHAT = 3;
const MAX_OPERATOR_SOCKETS_PER_TENANT = 30;
const TICKET_TTL_MS = 60_000;

// ---- operator bileti: "userId|bitmə vaxtı" + HMAC (server tərəfdə heç nə saxlanmır, çox serverdə də işləyir)
const ticketKey = (deps: Deps) => createHash("sha256").update(`ws-ticket:${deps.config.aiServiceToken}`).digest();
const mac = (deps: Deps, payload: string) => createHmac("sha256", ticketKey(deps)).update(payload).digest();

export function makeTicket(deps: Deps, userId: string): string {
  const payload = `${userId}|${Date.now() + TICKET_TTL_MS}`;
  return `${Buffer.from(payload).toString("base64url")}.${mac(deps, payload).toString("base64url")}`;
}
export function readTicket(deps: Deps, ticket: unknown): string | null {
  if (typeof ticket !== "string" || ticket.length > 300) return null;
  const [p, m] = ticket.split(".");
  if (!p || !m) return null;
  const payload = Buffer.from(p, "base64url").toString();
  const given = Buffer.from(m, "base64url"), want = mac(deps, payload);
  if (given.length !== want.length || !timingSafeEqual(given, want)) return null;
  const [userId, exp] = payload.split("|");
  return userId && Number(exp) > Date.now() ? userId : null;
}
/** Panelə verilən ünvan: portalın açıq ünvanı (http→ws, https→wss) + /ws */
export const wsUrlOf = (publicPortalUrl: string) => `${publicPortalUrl.replace(/^http/i, "ws")}/ws`;

function ipOf(req: IncomingMessage, trust: number): string {
  const xff = String(req.headers["x-forwarded-for"] ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  if (trust > 0 && xff.length) return xff[Math.max(0, xff.length - trust)]!;
  return req.socket.remoteAddress ?? "unknown";
}

type Meta = { alive: boolean; authing: boolean; msgs: number[]; typingAt: number; verified: Set<string>; cleanup?: () => void };

export function attachRealtime(server: Server, deps: Deps) {
  const { store, config } = deps;
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_PAYLOAD });
  const perIp = new Map<string, number>();
  const meta = new WeakMap<WebSocket, Meta>();

  server.on("upgrade", (req, socket, head) => {
    if (new URL(req.url ?? "/", "http://x").pathname !== "/ws") { socket.destroy(); return; }
    const ip = ipOf(req, config.trustProxy);
    if ((perIp.get(ip) ?? 0) >= MAX_PER_IP) { socket.write("HTTP/1.1 429 Too Many Requests\r\nConnection: close\r\n\r\n"); socket.destroy(); return; }
    wss.handleUpgrade(req, socket, head, (ws) => onConnection(ws, req, ip));
  });

  function onConnection(ws: WebSocket, req: IncomingMessage, ip: string) {
    perIp.set(ip, (perIp.get(ip) ?? 0) + 1);
    const m: Meta = { alive: true, authing: false, msgs: [], typingAt: 0, verified: new Set() };
    meta.set(ws, m);
    const authTimer = setTimeout(() => ws.close(4401, "auth"), AUTH_TIMEOUT_MS);
    let role: "visitor" | "operator" | null = null;
    let chatId = "", tenantId = "";

    ws.on("pong", () => { m.alive = true; });
    ws.on("error", () => { /* close hadisəsi təmizləyir */ });
    ws.on("close", () => {
      clearTimeout(authTimer);
      m.cleanup?.();
      if (role === "visitor") hub.removeVisitor(chatId, ws);
      if (role === "operator") hub.removeOperator(tenantId, ws);
      const n = (perIp.get(ip) ?? 1) - 1;
      if (n <= 0) perIp.delete(ip); else perIp.set(ip, n);
    });

    ws.on("message", async (raw) => {
      try {
        const now = Date.now();
        m.msgs = m.msgs.filter((t) => now - t < 10_000);
        if (m.msgs.push(now) > 20) return void ws.close(4429, "rate");
        let msg: Record<string, unknown>;
        try { msg = JSON.parse(raw.toString()); } catch { return; }
        if (!msg || typeof msg !== "object") return;

        if (!role) {
          if (m.authing || msg.t !== "auth") return;
          m.authing = true;
          const origin = req.headers.origin;
          if (msg.role === "visitor") {
            const key = String(msg.key ?? "");
            const tenant = WIDGET_KEY_RE.test(key) ? await store.findTenantByWidgetKey(key) : null;
            if (!tenant?.widget?.enabled || !tenant.widget.live?.enabled || !originAllowed(origin, tenant)) return void ws.close(4403, "forbidden");
            const chat = typeof msg.id === "string" && msg.id.length <= 60 ? await store.getLive(tenant.tenantId, msg.id) : null;
            if (!chat || !sameToken(msg.token, chat.tokenHash)) return void ws.close(4404, "not found");
            const existing = hub.visitorSockets(chat.id);
            if (existing.size >= MAX_VISITOR_SOCKETS_PER_CHAT) { const oldest = existing.values().next().value as WebSocket | undefined; oldest?.close(4409, "replaced"); }
            role = "visitor"; chatId = chat.id; tenantId = tenant.tenantId;
            hub.addVisitor(chatId, ws);
          } else if (msg.role === "operator") {
            if (origin && !config.allowedOrigins.includes(origin)) return void ws.close(4403, "forbidden");
            const userId = readTicket(deps, msg.ticket);
            const user = userId ? await store.findUserById(userId) : null;
            const tenant = user?.verified ? await store.findTenantByUser(user.id) : null;
            if (!tenant) return void ws.close(4403, "forbidden");
            if (hub.operatorCount(tenant.tenantId) >= MAX_OPERATOR_SOCKETS_PER_TENANT) return void ws.close(4409, "too many");
            role = "operator"; tenantId = tenant.tenantId;
            hub.addOperator(tenantId, ws);
            const life = setTimeout(() => ws.close(4408, "renew"), OPERATOR_LIFETIME_MS);
            m.cleanup = () => clearTimeout(life);
          } else return void ws.close(4400, "bad role");
          clearTimeout(authTimer);
          return void hub.send(ws, { t: "ready" });
        }

        // auth-dan sonra yalnız "yazır..." qəbul edilir (2 saniyədə bir)
        if (msg.t !== "typing" || now - m.typingAt < 2_000) return;
        m.typingAt = now;
        if (role === "visitor") hub.toOperators(tenantId, { t: "typing", id: chatId });
        else {
          const id = typeof msg.id === "string" && msg.id.length <= 60 ? msg.id : "";
          if (!id) return;
          if (!m.verified.has(id)) { if (!(await store.getLive(tenantId, id))) return; m.verified.add(id); }
          hub.toChat(id, { t: "typing" });
        }
      } catch (e) { console.warn("[ws]", e instanceof Error ? e.message : e); }
    });
  }

  // Ölü bağlantıları təmizləyir və proxy/CDN-in boş bağlantını kəsməsinin qarşısını alır
  const beat = setInterval(() => {
    for (const ws of wss.clients) {
      const m = meta.get(ws);
      if (m && !m.alive) { ws.terminate(); continue; }
      if (m) m.alive = false;
      try { ws.ping(); } catch { /* bağlanır */ }
    }
  }, PING_MS);
  beat.unref();
  server.on("close", () => { clearInterval(beat); for (const ws of wss.clients) ws.terminate(); wss.close(); });
  return wss;
}
