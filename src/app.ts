import express from "express";
import type { Deps } from "./deps.js";
import { errorHandler, notFound } from "./http.js";
import { loadUser, originCheck } from "./middleware.js";
import { adminRoutes } from "./routes/admin.js";
import { authRoutes } from "./routes/auth.js";
import { tenantRoutes } from "./routes/tenant.js";
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
  app.use((req, res, next) => (req.path === "/tenant/kb/files" ? next() : smallJson(req, res, next))); // fayl yükləmə öz limitini qoyur
  app.get("/health", (_req, res) => { res.json({ ok: true }); });

  // Müştəri saytlarından çağırılan ictimai vidjet route-ları (öz CORS/origin yoxlaması var).
  app.use(widgetRoutes(deps));

  app.use(originCheck(deps), loadUser(deps));
  app.use("/auth", authRoutes(deps));
  app.use("/tenant", tenantRoutes(deps));
  app.use("/admin", adminRoutes(deps));

  app.use(notFound);
  app.use(errorHandler);
  return app;
}
