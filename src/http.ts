import type { ErrorRequestHandler, RequestHandler } from "express";
import { AiError } from "./ai.js";

export class HttpError extends Error {
  constructor(public status: number, message: string, public code?: string) { super(message); }
}

export const notFound: RequestHandler = (_req, res) => { res.status(404).json({ error: "Tapılmadı" }); };

export const errorHandler: ErrorRequestHandler = (err, _req, res, _next) => {
  if (err instanceof HttpError) return void res.status(err.status).json({ error: err.message, code: err.code });
  if (err instanceof AiError) {
    // Müştəriyə aid xətalar (konfiqurasiya, limit) olduğu kimi göstərilir; servis səviyyəli xətalar gizlədilir.
    if ([400, 402, 404, 409, 422, 429, 503].includes(err.status)) return void res.status(err.status).json({ error: err.message, code: err.code, debug: err.body?.debug });
    console.error(`[ai] ${err.status} ${err.code ?? ""} ${err.message}`);
    return void res.status(502).json({ error: err.code === "AI_UNREACHABLE" ? err.message : "AI servisi ilə əlaqədə problem var", code: err.code ?? "AI_ERROR" });
  }
  if ((err as { type?: string }).type === "entity.parse.failed") return void res.status(400).json({ error: "JSON düzgün deyil" });
  if ((err as { type?: string }).type === "entity.too.large") return void res.status(413).json({ error: "Fayl çox böyükdür" });
  console.error(err);
  res.status(500).json({ error: "Xəta baş verdi" });
};
