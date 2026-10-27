// Panel: /tenant/channels/whatsapp (QR ilə qoşmaq, söndürmək, ayırmaq)
import { Router } from "express";
import type { Deps } from "../deps.js";
import { HttpError } from "../http.js";
import { currentUser, requireAuth } from "../middleware.js";

export function whatsappPanelRoutes(deps: Deps) {
  const { store, config, whatsapp, limiter } = deps;
  const r = Router();
  r.use(requireAuth);
  const tenantOf = async (res: Parameters<typeof currentUser>[0]) => {
    const t = await store.findTenantByUser(currentUser(res).id);
    if (!t) throw new HttpError(404, "Əvvəlcə qurulumu tamamla", "NO_TENANT");
    return t;
  };

  r.get("/whatsapp", async (_req, res) => { res.json(whatsapp.view(await tenantOf(res), config.secretKey)); });

  r.post("/whatsapp/connect", async (req, res) => {
    const t = await tenantOf(res);
    if (!config.secretKey) throw new HttpError(503, "Serverdə CHANNEL_SECRET_KEY təyin edilməyib: WhatsApp sessiyasını şifrələmək mümkün deyil", "NO_SECRET_KEY");
    if ((req.body as { ack?: unknown } | undefined)?.ack !== true) throw new HttpError(400, "Davam etmək üçün riskləri qəbul etməlisən", "NEED_ACK");
    if (!limiter.hit(`wa:connect:${t.tenantId}`, 6, 10 * 60_000)) throw new HttpError(429, "Çox tez-tez cəhd edirsən, bir az gözlə", "RATE");
    try { await whatsapp.connect(deps, t.tenantId, new Date()); }
    catch (e) {
      if (e instanceof Error && e.message === "WA_FULL") throw new HttpError(503, "WhatsApp qoşulmaları hazırda doludur, sonra yenidən yoxla", "WA_FULL");
      throw e;
    }
    res.json(whatsapp.view(t, config.secretKey));
  });

  r.patch("/whatsapp", async (req, res) => {
    const t = await tenantOf(res);
    if (!t.whatsapp) throw new HttpError(404, "WhatsApp qoşulmayıb", "NOT_CONNECTED");
    const b = (req.body ?? {}) as { enabled?: unknown; pauseOnOwnReply?: unknown };
    const next = { ...t.whatsapp };
    if (b.enabled !== undefined) { if (typeof b.enabled !== "boolean") throw new HttpError(400, "enabled true və ya false olmalıdır"); next.enabled = b.enabled; }
    if (b.pauseOnOwnReply !== undefined) { if (typeof b.pauseOnOwnReply !== "boolean") throw new HttpError(400, "pauseOnOwnReply true və ya false olmalıdır"); next.pauseOnOwnReply = b.pauseOnOwnReply; }
    await store.updateTenant(t.tenantId, { whatsapp: next });
    res.json(whatsapp.view({ ...t, whatsapp: next }, config.secretKey));
  });

  r.delete("/whatsapp", async (_req, res) => {
    const t = await tenantOf(res);
    await whatsapp.disconnect(deps, t.tenantId);
    res.json({ ok: true });
  });
  return r;
}
