import { Router } from "express";
import { deleteAccount } from "../account.js";
import type { Deps } from "../deps.js";
import { isAdmin } from "../deps.js";
import { HttpError } from "../http.js";
import { cookieOptions, COOKIE, currentUser, requireAuth, sessionTokenHash, startSession } from "../middleware.js";
import { dummyHash, hashCode, hashPassword, newCode, normalizeEmail, passwordProblem, safeEqualHex, verifyPassword } from "../security.js";
import { DuplicateError, type CodePurpose, type User } from "../store/types.js";

const CODE_TTL_MS = 15 * 60_000;
const RESEND_COOLDOWN_MS = 60_000;
const MAX_CODE_ATTEMPTS = 5;
const MIN = 60_000;

const TEXT: Record<CodePurpose, { subject: string; body: (code: string) => string }> = {
  verify: { subject: "Car Advisor: email təsdiq kodu", body: (c) => `Təsdiq kodun: ${c}\n\nKod 15 dəqiqə etibarlıdır. Bu hesabı sən açmamısansa, bu məktuba məhəl qoyma.` },
  reset: { subject: "Car Advisor: parol sıfırlama kodu", body: (c) => `Parol sıfırlama kodun: ${c}\n\nKod 15 dəqiqə etibarlıdır. Bunu sən istəməmisənsə, bu məktuba məhəl qoyma, parolun dəyişməyəcək.` },
};

export function authRoutes(deps: Deps) {
  const { store, mailer, limiter, config } = deps;
  const r = Router();

  const limit = (key: string, max: number, windowMs: number) => {
    if (!limiter.hit(key, max, windowMs)) throw new HttpError(429, "Çox cəhd edildi. Bir az sonra yenidən yoxla.", "RATE_LIMITED");
  };
  const me = (u: User) => ({ email: u.email, role: isAdmin(config, u) ? "admin" : "user" });

  /** Yeni kod göndərir. Son 60 saniyədə göndərilibsə göndərmir (false). */
  async function sendCode(email: string, purpose: CodePurpose): Promise<boolean> {
    const existing = await store.findCode(email, purpose);
    if (existing && Date.now() - existing.sentAt.getTime() < RESEND_COOLDOWN_MS) return false;
    const code = newCode();
    await store.saveCode({ email, purpose, codeHash: hashCode(email, purpose, code), expiresAt: new Date(Date.now() + CODE_TTL_MS), attempts: 0, sentAt: new Date() });
    try { await mailer.send(email, TEXT[purpose].subject, TEXT[purpose].body(code)); }
    catch (e) { console.error("[mail]", e); await store.deleteCode(email, purpose); throw new HttpError(502, "Email göndərilə bilmədi. Bir az sonra yenidən cəhd et.", "MAIL_FAILED"); }
    return true;
  }

  async function checkCode(email: string, purpose: CodePurpose, code: unknown) {
    const bad = new HttpError(400, "Kod yanlışdır və ya vaxtı keçib", "BAD_CODE");
    if (typeof code !== "string" || !/^\d{6}$/.test(code.trim())) throw bad;
    const rec = await store.findCode(email, purpose);
    if (!rec) throw bad;
    if (rec.attempts >= MAX_CODE_ATTEMPTS) {
      await store.deleteCode(email, purpose);
      throw new HttpError(429, "Çox yanlış cəhd oldu. Yeni kod istə.", "TOO_MANY_ATTEMPTS");
    }
    if (!safeEqualHex(rec.codeHash, hashCode(email, purpose, code.trim()))) {
      await store.bumpCodeAttempts(email, purpose);
      throw bad;
    }
    await store.deleteCode(email, purpose);
  }

  r.post("/register", async (req, res) => {
    const email = normalizeEmail(req.body?.email);
    if (!email) throw new HttpError(400, "Düzgün email yaz");
    const pw = passwordProblem(req.body?.password);
    if (pw) throw new HttpError(400, pw);
    limit(`register:${req.ip}`, 10, 60 * MIN);

    const existing = await store.findUserByEmail(email);
    if (existing?.verified) throw new HttpError(409, "Bu email ilə hesab artıq var. Daxil ol.", "EMAIL_TAKEN");
    const passwordHash = await hashPassword(req.body.password);
    if (existing) await store.updateUser(existing.id, { passwordHash }); // təsdiqlənməmiş hesab: yeni parolla davam
    else {
      try { await store.createUser({ email, passwordHash }); }
      catch (e) { if (!(e instanceof DuplicateError)) throw e; }
    }
    await sendCode(email, "verify");
    res.status(201).json({ ok: true, email });
  });

  r.post("/verify", async (req, res) => {
    const email = normalizeEmail(req.body?.email);
    if (!email) throw new HttpError(400, "Düzgün email yaz");
    limit(`verify:${email}`, 15, 15 * MIN);
    const user = await store.findUserByEmail(email);
    if (!user) throw new HttpError(400, "Kod yanlışdır və ya vaxtı keçib", "BAD_CODE");
    await checkCode(email, "verify", req.body?.code);
    await store.updateUser(user.id, { verified: true });
    await startSession(deps, res, user.id);
    res.json(me({ ...user, verified: true }));
  });

  r.post("/resend", async (req, res) => {
    const email = normalizeEmail(req.body?.email);
    if (email) {
      limit(`resend:${req.ip}`, 10, 15 * MIN);
      const user = await store.findUserByEmail(email);
      if (user && !user.verified) await sendCode(email, "verify");
    }
    res.json({ ok: true }); // hesab olub-olmadığı bildirilmir
  });

  r.post("/login", async (req, res) => {
    const email = normalizeEmail(req.body?.email);
    const password = req.body?.password;
    if (!email || typeof password !== "string" || !password || password.length > 128) throw new HttpError(400, "Email və parol lazımdır");
    limit(`login:${req.ip}:${email}`, 10, 15 * MIN);
    limit(`login:${email}`, 30, 15 * MIN);

    const user = await store.findUserByEmail(email);
    const ok = await verifyPassword(password, user?.passwordHash ?? (await dummyHash()));
    if (!user || !ok) throw new HttpError(401, "Email və ya parol yanlışdır", "BAD_CREDENTIALS");
    if (!user.verified) {
      await sendCode(email, "verify");
      throw new HttpError(403, "Email hələ təsdiqlənməyib. Sənə yeni kod göndərdik.", "EMAIL_NOT_VERIFIED");
    }
    await startSession(deps, res, user.id);
    res.json(me(user));
  });

  r.post("/logout", async (req, res) => {
    const hash = sessionTokenHash(req.get("cookie"));
    if (hash) await store.deleteSession(hash);
    res.clearCookie(COOKIE, cookieOptions(deps));
    res.json({ ok: true });
  });

  r.post("/forgot", async (req, res) => {
    const email = normalizeEmail(req.body?.email);
    if (email) {
      limit(`forgot:${req.ip}`, 10, 60 * MIN);
      const user = await store.findUserByEmail(email);
      if (user?.verified) await sendCode(email, "reset");
    }
    res.json({ ok: true });
  });

  r.post("/reset", async (req, res) => {
    const email = normalizeEmail(req.body?.email);
    if (!email) throw new HttpError(400, "Düzgün email yaz");
    const pw = passwordProblem(req.body?.password);
    if (pw) throw new HttpError(400, pw);
    limit(`reset:${email}`, 15, 15 * MIN);
    const user = await store.findUserByEmail(email);
    if (!user) throw new HttpError(400, "Kod yanlışdır və ya vaxtı keçib", "BAD_CODE");
    await checkCode(email, "reset", req.body?.code);
    await store.updateUser(user.id, { passwordHash: await hashPassword(req.body.password), verified: true });
    await store.deleteSessionsForUser(user.id); // bütün cihazlardan çıxış
    res.json({ ok: true });
  });

  // İstifadəçi öz hesabını və müştərisini silir (parolu təsdiqləməlidir). Admin hesabı bu yolla silinmir.
  r.post("/delete-account", requireAuth, async (req, res) => {
    const user = currentUser(res);
    const password = req.body?.password;
    if (typeof password !== "string" || !password || password.length > 128) throw new HttpError(400, "Silməyi təsdiqləmək üçün parolunu yaz");
    limit(`delete:${user.id}`, 5, 15 * MIN);
    if (isAdmin(config, user)) throw new HttpError(403, "Admin hesabı buradan silinmir", "CANNOT_DELETE_ADMIN");
    if (!(await verifyPassword(password, user.passwordHash))) throw new HttpError(401, "Parol yanlışdır", "BAD_CREDENTIALS");
    await deleteAccount(deps, user);
    res.clearCookie(COOKIE, cookieOptions(deps));
    res.json({ ok: true });
  });

  r.get("/me", (_req, res) => {
    if (!res.locals.user) throw new HttpError(401, "Giriş lazımdır", "UNAUTHENTICATED");
    res.json(me(currentUser(res)));
  });

  return r;
}
