import type { ErrorRequestHandler, RequestHandler } from "express";
import { AiError } from "./ai.js";
import type { Deps } from "./deps.js";
import { recordError } from "./errorlog.js";

export class HttpError extends Error {
  constructor(public status: number, message: string, public code?: string) { super(message); }
}

export const notFound: RequestHandler = (_req, res) => { res.status(404).json({ error: "Tapılmadı" }); };

/** Gözlənilməz xətalar (500, AI servisi 5xx) admin üçün xəta jurnalına da yazılır. İstifadəçi xətaları (4xx) yazılmır. */
export const createErrorHandler = (deps: Deps): ErrorRequestHandler => (err, req, res, _next) => {
  const ctx = { method: req.method, path: req.originalUrl, userId: (res.locals.user as { id?: string } | undefined)?.id };
  const source = req.path.startsWith("/widget") ? "widget" as const : "api" as const;
  if (err instanceof HttpError) return void res.status(err.status).json({ error: err.message, code: err.code });
  if (err instanceof AiError) {
    if (err.status >= 500 || err.status === 429) void recordError(deps.store, { ...ctx, source: "ai", message: `AI servisi: ${err.message}`, code: err.code, status: err.status });
    // Müştəriyə aid xətalar (konfiqurasiya, limit) olduğu kimi göstərilir; servis səviyyəli xətalar gizlədilir.
    if ([400, 402, 404, 409, 422, 429, 503].includes(err.status)) return void res.status(err.status).json({ error: err.message, code: err.code, debug: err.body?.debug });
    console.error(`[ai] ${err.status} ${err.code ?? ""} ${err.message}`);
    return void res.status(502).json({ error: err.code === "AI_UNREACHABLE" ? err.message : "AI servisi ilə əlaqədə problem var", code: err.code ?? "AI_ERROR" });
  }
  const type = (err as { type?: string }).type;
  if (type === "entity.parse.failed") return void res.status(400).json({ error: "JSON düzgün deyil" });
  if (type === "entity.too.large") return void res.status(413).json({ error: "Fayl çox böyükdür" });
  console.error(err);
  void recordError(deps.store, { ...ctx, source, message: err instanceof Error ? err.message : String(err), stack: err instanceof Error ? err.stack : undefined, status: 500, code: "UNHANDLED" });
  res.status(500).json({ error: "Xəta baş verdi" });
};
