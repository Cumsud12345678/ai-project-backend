import express from "express";
import type { Deps } from "./deps.js";
import { createErrorHandler, notFound } from "./http.js";
import { loadUser, originCheck } from "./middleware.js";
import { adminRoutes } from "./routes/admin.js";
import { authRoutes } from "./routes/auth.js";
import { tenantRoutes } from "./routes/tenant.js";
import { recordError } from "./errorlog.js";
import { telegramPanelRoutes, telegramWebhook } from "./telegram-channel.js";
import { whatsappPanelRoutes } from "./whatsapp/routes.js";
import { widgetRoutes } from "./widget.js";

export function createApp(deps: Deps) {
  const app = express();
  app.disable("x-powered-by");
  app.set("trust proxy", deps.config.trustProxy);
  app.use((_req, res, next) => {
    res.set({ "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" });
    next();
  });
  const smallJson = express.json({ limit: "200kb" });
  const imageJson = express.json({ limit: "3.5mb" }); // şəkilli sual (base64) yalnız vidjet çatında
  const feedJson = express.json({ limit: "7mb" }); // CSV/JSON/XML faylı gövdədə mətn kimi gəlir (AI servisi 5 MB-a qədər qəbul edir)
  app.use((req, res, next) => (req.path === "/tenant/kb/files" ? next() : /^\/widget\/[^/]+\/chat$/.test(req.path) ? imageJson(req, res, next) : /^\/tenant(\/(feed\/preview|feed\/refresh|config\/test|config))?$/.test(req.path) ? feedJson(req, res, next) : smallJson(req, res, next))); // fayl yükləmə öz limitini qoyur
  app.get("/health", (_req, res) => { res.json({ ok: true }); });

  // Müştəri saytlarından çağırılan ictimai vidjet route-ları (öz CORS/origin yoxlaması var).
  app.use(widgetRoutes(deps));
  app.use(telegramWebhook(deps)); // Telegram-ın webhook-u: öz gizli başlığı ilə qorunur, cookie/origin tələb etmir

  app.use(originCheck(deps), loadUser(deps));
  app.use("/auth", authRoutes(deps));

  // Panelin brauzerində baş verən xəta (JS xətası, render xətası). Giriş tələb etmir, amma IP üzrə limitlidir.
  app.post("/client-errors", async (req, res) => {
    if (!deps.limiter.hit(`cerr:${req.ip}`, 20, 10 * 60_000)) return void res.status(204).end();
    const b = (req.body ?? {}) as { message?: unknown; stack?: unknown; page?: unknown };
    if (typeof b.message === "string" && b.message.trim()) {
      await recordError(deps.store, {
        source: "client", message: b.message.slice(0, 400), stack: typeof b.stack === "string" ? b.stack : undefined,
        path: typeof b.page === "string" ? b.page.slice(0, 200) : undefined, userId: (res.locals.user as { id?: string } | undefined)?.id, code: "CLIENT",
      });
    }
    res.status(204).end();
  });
  // Bütün giriş etmiş istifadəçilərə göstərilən elan (admin təyin edir)
  app.get("/announcement", async (_req, res) => {
    if (!res.locals.user) return void res.json({ announcement: null });
    const a = await deps.store.getAnnouncement();
    res.json({ announcement: a?.active ? { text: a.text, level: a.level } : null });
  });
  app.use("/tenant/channels", telegramPanelRoutes(deps), whatsappPanelRoutes(deps));
  app.use("/tenant", tenantRoutes(deps));
  app.use("/admin", adminRoutes(deps));

  app.use(notFound);
  app.use(createErrorHandler(deps));
  return app;
}
