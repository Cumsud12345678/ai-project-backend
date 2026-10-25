import type { CookieOptions, RequestHandler, Response } from "express";
import type { Deps } from "./deps.js";
import { isAdmin } from "./deps.js";
import { HttpError } from "./http.js";
import { newSessionToken, sha256 } from "./security.js";
import type { User } from "./store/types.js";

export const COOKIE = "ca_session";

function readCookie(header: string | undefined, name: string): string | undefined {
  for (const part of (header ?? "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0 && part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
  }
}

export const cookieOptions = (deps: Deps): CookieOptions => ({
  httpOnly: true, sameSite: "lax", secure: deps.config.cookieSecure, path: "/",
});

export async function startSession(deps: Deps, res: Response, userId: string) {
  const token = newSessionToken();
  const maxAge = deps.config.sessionDays * 24 * 60 * 60 * 1000;
  await deps.store.createSession({ tokenHash: sha256(token), userId, expiresAt: new Date(Date.now() + maxAge) });
  res.cookie(COOKIE, token, { ...cookieOptions(deps), maxAge });
}

/** Brauzerdən gələn dəyişdirici sorğu yalnız icazəli saytdan ola bilər (CSRF-ə qarşı əlavə qat). */
export const originCheck = (deps: Deps): RequestHandler => (req, _res, next) => {
  if (["GET", "HEAD", "OPTIONS"].includes(req.method)) return next();
  const origin = req.get("origin");
  if (origin && !deps.config.allowedOrigins.includes(origin)) return next(new HttpError(403, "Bu mənbədən sorğuya icazə yoxdur"));
  next();
};

export const loadUser = (deps: Deps): RequestHandler => async (req, res, next) => {
  try {
    const token = readCookie(req.get("cookie"), COOKIE);
    if (token) {
      const session = await deps.store.findSession(sha256(token));
      const user = session ? await deps.store.findUserById(session.userId) : null;
      if (user?.verified) res.locals.user = user;
    }
    next();
  } catch (e) { next(e); }
};

export const sessionTokenHash = (cookieHeader: string | undefined) => {
  const t = readCookie(cookieHeader, COOKIE);
  return t ? sha256(t) : null;
};

export const currentUser = (res: Response): User => res.locals.user as User;
export const requireAuth: RequestHandler = (_req, res, next) => (res.locals.user ? next() : next(new HttpError(401, "Giriş lazımdır", "UNAUTHENTICATED")));
export const requireAdmin = (deps: Deps): RequestHandler => (_req, res, next) =>
  res.locals.user && isAdmin(deps.config, res.locals.user as User) ? next() : next(new HttpError(403, "Bu əməliyyat yalnız admin üçündür"));
