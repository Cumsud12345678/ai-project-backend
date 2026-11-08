import { Router } from "express";
import { deleteAccount } from "../account.js";
import type { Deps } from "../deps.js";
import { isAdmin } from "../deps.js";
import { HttpError } from "../http.js";
import QRCode from "qrcode";
import { cookieOptions, COOKIE, currentUser, needsTwoFactorSetup, requireAuth, sessionTokenHash, startSession } from "../middleware.js";
import { decryptSecret, encryptSecret } from "../secrets.js";
import { dummyHash, hashCode, hashPassword, newCode, newSessionToken, normalizeEmail, passwordProblem, safeEqualHex, verifyPassword } from "../security.js";
import { hashBackup, looksLikeBackup, newBackupCodes, newTotpSecret, otpauthUri, verifyTotp } from "../totp.js";
import { attachOnSignup, getPartnerSettings, normalizeCode, validCode } from "../partners.js";
import { DuplicateError, type CodePurpose, type User } from "../store/types.js";

const CODE_TTL_MS = 15 * 60_000;
const RESEND_COOLDOWN_MS = 60_000;
const MAX_CODE_ATTEMPTS = 5;
const MIN = 60_000;

const TWO_FA_TTL_MS = 5 * 60_000;

// Kod ayrıca abzasdadır: məktubda böyük, oxunaqlı blok kimi görünür (mailer.ts → renderHtml)
const TEXT: Record<Exclude<CodePurpose, "2fa">, { subject: string; preheader: (code: string) => string; body: (code: string) => string }> = {
  verify: {
    subject: "E-poçtunu təsdiqlə",
    preheader: (c) => `Təsdiq kodun: ${c}. 15 dəqiqə etibarlıdır.`,
    body: (c) => `Qeydiyyatı tamamlamaq üçün bu kodu təsdiq səhifəsinə yaz:\n\n${c}\n\nKod 15 dəqiqə etibarlıdır.\n\nBu hesabı sən açmamısansa, bu məktuba məhəl qoyma: e-poçtun təsdiqlənməsə hesab aktiv olmayacaq.`,
  },
  reset: {
    subject: "Parolu sıfırla",
    preheader: (c) => `Sıfırlama kodun: ${c}. 15 dəqiqə etibarlıdır.`,
    body: (c) => `Hesabının parolunu yeniləmək üçün bu kodu daxil et:\n\n${c}\n\nKod 15 dəqiqə etibarlıdır.\n\nBunu sən istəməmisənsə, bu məktuba məhəl qoyma: parolun dəyişməyəcək.`,
  },
};

export function authRoutes(deps: Deps) {
  const { store, mailer, limiter, config } = deps;
  const r = Router();

  const limit = (key: string, max: number, windowMs: number) => {
    if (!limiter.hit(key, max, windowMs)) throw new HttpError(429, "Çox cəhd edildi. Bir az sonra yenidən yoxla.", "RATE_LIMITED");
  };
  const me = (u: User) => ({
    email: u.email, role: isAdmin(config, u) ? "admin" : "user",
    twoFactor: { enabled: Boolean(u.totp), required: config.adminTwoFactor === "required" && isAdmin(config, u), setupNeeded: needsTwoFactorSetup(deps, u), backupLeft: u.totp?.backupHashes.length ?? 0 },
    partner: u.partner ? { code: u.partner.code, active: u.partner.active } : null,
  });

  /**
   * İki addımlı kodu yoxlayır: 6 rəqəmli TOTP və ya bir dəfəlik ehtiyat kod. Uğurlu olanda istifadə olunan kodu "yandırır"
   * (TOTP addımı yadda saxlanır, ehtiyat kod silinir). Səhvdirsə false.
   */
  async function useSecondFactor(user: User, code: unknown): Promise<boolean> {
    if (!user.totp || !config.secretKey) return false;
    const secret = decryptSecret(user.totp.secretEnc, config.secretKey);
    const step = verifyTotp(secret, code, { afterStep: user.totp.lastStep ?? -1 });
    if (step !== null) { await store.updateUser(user.id, { totp: { ...user.totp, lastStep: step } }); return true; }
    if (looksLikeBackup(code)) {
      const h = hashBackup(user.id, code);
      if (user.totp.backupHashes.includes(h)) { await store.updateUser(user.id, { totp: { ...user.totp, backupHashes: user.totp.backupHashes.filter((x) => x !== h) } }); return true; }
    }
    return false;
  }

  /** Yeni kod göndərir. Son 60 saniyədə göndərilibsə göndərmir (false). */
  async function sendCode(email: string, purpose: Exclude<CodePurpose, "2fa">): Promise<boolean> {
    const existing = await store.findCode(email, purpose);
    if (existing && Date.now() - existing.sentAt.getTime() < RESEND_COOLDOWN_MS) return false;
    const code = newCode();
    await store.saveCode({ email, purpose, codeHash: hashCode(email, purpose, code), expiresAt: new Date(Date.now() + CODE_TTL_MS), attempts: 0, sentAt: new Date() });
    try { await mailer.send(email, TEXT[purpose].subject, TEXT[purpose].body(code), { security: true, preheader: TEXT[purpose].preheader(code) }); }
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
    // Partnyor kodu: istifadəçi özü yazıbsa (code) səhv kod xəta verir; linkdən gəlibsə (link) səssizcə keçilir
    const refSource = req.body?.refSource === "link" ? "link" : "code";
    const refCode = normalizeCode(req.body?.ref);
    if (refCode && refSource === "code") {
      const p = validCode(refCode) ? await store.findUserByPartnerCode(refCode) : null;
      if (!p?.partner?.active || p.email === email) throw new HttpError(400, "Promo kod tapılmadı", "BAD_REF_CODE");
    }
    const passwordHash = await hashPassword(req.body.password);
    if (existing) await store.updateUser(existing.id, { passwordHash }); // təsdiqlənməmiş hesab: yeni parolla davam
    else {
      try { await store.createUser({ email, passwordHash }); }
      catch (e) { if (!(e instanceof DuplicateError)) throw e; }
    }
    if (refCode) { const u = await store.findUserByEmail(email); if (u) await attachOnSignup(deps, u, refCode, refSource); }
    await sendCode(email, "verify");
    res.status(201).json({ ok: true, email });
  });

  // Qeydiyyat formasında promo kodu yoxlamaq üçün (partnyor haqqında məlumat qaytarmır)
  r.get("/ref/:code", async (req, res) => {
    limit(`refcheck:${req.ip}`, 30, 10 * MIN);
    const code = normalizeCode(req.params.code);
    const p = validCode(code) ? await store.findUserByPartnerCode(code) : null;
    const s = await getPartnerSettings(deps);
    res.json({ valid: Boolean(p?.partner?.active), code, bonusPct: s.bonusPct, bonusCapAzn: s.bonusCapAzn });
  });

  r.post("/verify", async (req, res) => {
    const email = normalizeEmail(req.body?.email);
    if (!email) throw new HttpError(400, "Düzgün email yaz");
    limit(`verify:${email}`, 15, 15 * MIN);
    const user = await store.findUserByEmail(email);
    if (!user) throw new HttpError(400, "Kod yanlışdır və ya vaxtı keçib", "BAD_CODE");
    await checkCode(email, "verify", req.body?.code);
    await store.updateUser(user.id, { verified: true });
    if (user.totp) throw new HttpError(400, "Email artıq təsdiqlənib. Daxil ol.", "ALREADY_VERIFIED"); // iki addımlı girişi bu yolla keçmək olmaz
    await startSession(deps, res, user);
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
    if (user.totp) {
      // Parol düzgündür, amma sessiya hələ açılmır: qısa ömürlü bilet qaytarılır, ikinci addım /auth/2fa/login-dədir
      const ticket = newSessionToken();
      await store.saveCode({ email, purpose: "2fa", codeHash: hashCode(email, "2fa", ticket), expiresAt: new Date(Date.now() + TWO_FA_TTL_MS), attempts: 0, sentAt: new Date() });
      return void res.json({ twoFactor: true, ticket });
    }
    await startSession(deps, res, user);
    res.json(me(user));
  });

  // Girişin ikinci addımı: parol yoxlanandan sonra verilən bilet + authenticator kodu (və ya ehtiyat kod)
  r.post("/2fa/login", async (req, res) => {
    const email = normalizeEmail(req.body?.email);
    const ticket = req.body?.ticket;
    const bad = new HttpError(400, "Kod yanlışdır və ya vaxtı keçib", "BAD_CODE");
    if (!email || typeof ticket !== "string" || !/^[a-f0-9]{64}$/.test(ticket)) throw bad;
    limit(`2fa:${email}`, 10, 15 * MIN);
    const rec = await store.findCode(email, "2fa");
    if (!rec || rec.expiresAt.getTime() <= Date.now() || !safeEqualHex(rec.codeHash, hashCode(email, "2fa", ticket))) throw new HttpError(401, "Giriş vaxtı keçib, yenidən daxil ol", "TICKET_EXPIRED");
    if (rec.attempts >= MAX_CODE_ATTEMPTS) { await store.deleteCode(email, "2fa"); throw new HttpError(429, "Çox yanlış cəhd oldu. Yenidən daxil ol.", "TOO_MANY_ATTEMPTS"); }
    const user = await store.findUserByEmail(email);
    if (!user?.totp) throw bad;
    if (!(await useSecondFactor(user, req.body?.code))) { await store.bumpCodeAttempts(email, "2fa"); throw bad; }
    await store.deleteCode(email, "2fa");
    const fresh = (await store.findUserById(user.id)) ?? user;
    await startSession(deps, res, fresh);
    res.json(me(fresh));
  });

  // ---- İki addımlı girişin quraşdırılması (istənilən istifadəçi; admin üçün ADMIN_2FA=required olanda məcburi) ----
  const needKey = () => { if (!config.secretKey) throw new HttpError(503, "Serverdə CHANNEL_SECRET_KEY təyin olunmayıb: iki addımlı giriş qurula bilməz", "NO_SECRET_KEY"); };

  r.post("/2fa/setup", requireAuth, async (req, res) => {
    needKey();
    const user = currentUser(res);
    limit(`2fa:setup:${user.id}`, 10, 15 * MIN);
    if (user.totp) throw new HttpError(409, "İki addımlı giriş artıq aktivdir", "TWO_FACTOR_ON");
    const password = req.body?.password;
    if (typeof password !== "string" || !password || password.length > 128 || !(await verifyPassword(password, user.passwordHash))) throw new HttpError(401, "Parol yanlışdır", "BAD_CREDENTIALS");
    const secret = newTotpSecret();
    await store.updateUser(user.id, { totpPending: { secretEnc: encryptSecret(secret, config.secretKey), at: new Date() } });
    const uri = otpauthUri(secret, user.email, config.brandName);
    res.json({ secret, uri, qr: await QRCode.toDataURL(uri, { margin: 2, scale: 6, errorCorrectionLevel: "M" }) });
  });

  r.post("/2fa/enable", requireAuth, async (req, res) => {
    needKey();
    const user = currentUser(res);
    limit(`2fa:enable:${user.id}`, 10, 15 * MIN);
    if (user.totp) throw new HttpError(409, "İki addımlı giriş artıq aktivdir", "TWO_FACTOR_ON");
    const p = user.totpPending;
    if (!p || Date.now() - new Date(p.at).getTime() > 30 * MIN) throw new HttpError(400, "Quraşdırmanı yenidən başla", "SETUP_EXPIRED");
    const step = verifyTotp(decryptSecret(p.secretEnc, config.secretKey), req.body?.code);
    if (step === null) throw new HttpError(400, "Kod yanlışdır. Telefonun saatının düzgün olduğunu yoxla.", "BAD_CODE");
    const backup = newBackupCodes();
    await store.updateUser(user.id, { totp: { secretEnc: p.secretEnc, enabledAt: new Date(), backupHashes: backup.map((c) => hashBackup(user.id, c)), lastStep: step }, totpPending: null });
    // Başqa cihazlardakı köhnə sessiyalar bağlanır, bu cihazda yeni sessiya açılır
    await store.deleteSessionsForUser(user.id);
    const fresh = (await store.findUserById(user.id))!;
    await startSession(deps, res, fresh);
    res.json({ ok: true, backupCodes: backup, me: me(fresh) });
  });

  r.post("/2fa/disable", requireAuth, async (req, res) => {
    const user = currentUser(res);
    limit(`2fa:disable:${user.id}`, 10, 15 * MIN);
    if (!user.totp) return void res.json({ ok: true });
    if (config.adminTwoFactor === "required" && isAdmin(config, user)) throw new HttpError(403, "Admin hesabı üçün iki addımlı giriş məcburidir", "TWO_FACTOR_REQUIRED");
    const password = req.body?.password;
    if (typeof password !== "string" || !(await verifyPassword(password, user.passwordHash))) throw new HttpError(401, "Parol yanlışdır", "BAD_CREDENTIALS");
    if (!(await useSecondFactor(user, req.body?.code))) throw new HttpError(400, "Kod yanlışdır", "BAD_CODE");
    await store.updateUser(user.id, { totp: null, totpPending: null });
    res.json({ ok: true });
  });

  r.post("/2fa/backup-codes", requireAuth, async (req, res) => {
    const user = currentUser(res);
    limit(`2fa:backup:${user.id}`, 10, 15 * MIN);
    if (!user.totp) throw new HttpError(400, "İki addımlı giriş aktiv deyil", "TWO_FACTOR_OFF");
    if (!(await useSecondFactor(user, req.body?.code))) throw new HttpError(400, "Kod yanlışdır", "BAD_CODE");
    const fresh = (await store.findUserById(user.id))!;
    const backup = newBackupCodes();
    await store.updateUser(user.id, { totp: { ...fresh.totp!, backupHashes: backup.map((c) => hashBackup(user.id, c)) } });
    res.json({ backupCodes: backup });
  });

  // Bütün cihazlardan çıxış: bu cihaz istisna olmaqla (yeni sessiya açılır)
  r.post("/sessions/revoke-others", requireAuth, async (_req, res) => {
    const user = currentUser(res);
    limit(`sessions:${user.id}`, 10, 15 * MIN);
    await store.deleteSessionsForUser(user.id);
    await startSession(deps, res, user);
    res.json({ ok: true });
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
