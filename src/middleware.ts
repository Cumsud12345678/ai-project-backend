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

const adminMaxAgeMs = (deps: Deps) => (deps.config.adminSessionHours ?? 12) * 60 * 60 * 1000;

/** Yeni sessiya. Admin üçün ömür qısadır (ADMIN_SESSION_HOURS), adi istifadəçi üçün SESSION_DAYS. */
export async function startSession(deps: Deps, res: Response, user: User) {
  const token = newSessionToken();
  const maxAge = isAdmin(deps.config, user) ? adminMaxAgeMs(deps) : deps.config.sessionDays * 24 * 60 * 60 * 1000;
  await deps.store.createSession({ tokenHash: sha256(token), userId: user.id, expiresAt: new Date(Date.now() + maxAge), createdAt: new Date() });
  res.cookie(COOKIE, token, { ...cookieOptions(deps), maxAge });
}

/** Admin iki addımlı girişi quraşdırmalıdırmı (ADMIN_2FA=required və hələ yoxdur)? */
export const needsTwoFactorSetup = (deps: Deps, user: User) => deps.config.adminTwoFactor === "required" && isAdmin(deps.config, user) && !user.totp;

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
      const hash = sha256(token);
      const session = await deps.store.findSession(hash);
      const live = session && session.expiresAt.getTime() > Date.now() ? session : null;
      const user = live ? await deps.store.findUserById(live.userId) : null;
      // Admin sessiyası qısa ömürlüdür: istifadəçi sonradan admin olubsa və ya sessiya köhnədirsə (createdAt yoxdur) etibarsızdır
      if (user && isAdmin(deps.config, user) && (!live!.createdAt || Date.now() - new Date(live!.createdAt).getTime() > adminMaxAgeMs(deps))) {
        await deps.store.deleteSession(hash);
      } else if (user?.verified) res.locals.user = user;
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
export const requireAdmin = (deps: Deps): RequestHandler => (_req, res, next) => {
  const user = res.locals.user as User | undefined;
  if (!user || !isAdmin(deps.config, user)) return next(new HttpError(403, "Bu əməliyyat yalnız admin üçündür"));
  if (needsTwoFactorSetup(deps, user)) return next(new HttpError(403, "Admin panelə girmək üçün əvvəlcə iki addımlı girişi quraşdır", "TWO_FACTOR_SETUP_REQUIRED"));
  next();
};
