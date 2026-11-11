// "Qurulumu bizə həvalə et" (pulsuz qurulum xidməti): API-si, texniki biliyi olmayan biznes sahibi məhsul/xidmət, qiymət,
// satış ssenarisi və tez-tez verilən sualları formaya yazır. Adminə dərhal xəbər gedir. Admin sorğunu yoxlayıb bir kliklə
// həmin istifadəçi üçün dəstək botu yaradır: məlumat bilik bazasına düşür, satış ssenarisi təlimat olur, sahibə "hazırdır" e-poçtu gedir.
import { Router } from "express";
import { sendAlert } from "./alerts.js";
import type { Deps } from "./deps.js";
import { HttpError } from "./http.js";
import { currentUser, requireAuth } from "./middleware.js";
import { memberTenant } from "./team.js";
import { createTenantFor } from "./tenant-create.js";
import type { SetupRequest, SetupRequestStatus, User } from "./store/types.js";

export const SETUP_CHANNELS = ["site", "telegram", "whatsapp"] as const;
export const SETUP_STATUSES: SetupRequestStatus[] = ["new", "in_progress", "done"];
const CTRL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;
const txt = (v: unknown, max: number) => (typeof v === "string" ? v.replace(CTRL, " ").replace(/\r\n/g, "\n").trim().slice(0, max) : "");

/** "https://www.Shop.az/path" → "shop.az"; düzgün deyilsə "" */
export function siteHost(v: string): string {
  const raw = v.trim().toLowerCase();
  if (!raw) return "";
  try {
    const h = new URL(/^[a-z][a-z0-9+.-]*:\/\//.test(raw) ? raw : `https://${raw}`).hostname.replace(/^www\./, "");
    return /^[a-z0-9.-]+\.[a-z]{2,}$/.test(h) ? h : "";
  } catch { return ""; }
}

/** Formanı yoxlayır; səhv varsa HttpError */
export function parseSetupForm(body: unknown) {
  const b = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
  const businessName = txt(b.businessName, 120), website = txt(b.website, 200), phone = txt(b.phone, 40);
  const description = txt(b.description, 6000), salesScript = txt(b.salesScript, 3000), faq = txt(b.faq, 6000);
  if (businessName.length < 2) throw new HttpError(400, "Biznesin adını yaz");
  if (website && !siteHost(website)) throw new HttpError(400, "Sayt ünvanı düzgün deyil (məs. magaza.az). Sayt yoxdursa boş burax.");
  const digits = phone.replace(/\D/g, "");
  if (digits.length < 7 || digits.length > 15) throw new HttpError(400, "Sizinlə əlaqə üçün telefon nömrəsi yaz");
  if (description.length < 50) throw new HttpError(400, "Biznes, məhsul/xidmət və qiymətlər haqqında ən azı 50 simvol yaz: AI bununla öyrənəcək");
  const channels = [...new Set((Array.isArray(b.channels) ? b.channels : []).filter((c): c is (typeof SETUP_CHANNELS)[number] => (SETUP_CHANNELS as readonly string[]).includes(c as string)))];
  return { businessName, website, phone, description, salesScript, faq, channels };
}

const view = (r: SetupRequest) => ({
  businessName: r.businessName, website: r.website, phone: r.phone, description: r.description, salesScript: r.salesScript, faq: r.faq, channels: r.channels,
  status: r.status, createdAt: r.createdAt, updatedAt: r.updatedAt, ...(r.doneAt && { doneAt: r.doneAt }), ...(r.adminNote && { adminNote: r.adminNote }),
});
export const adminView = (r: SetupRequest) => ({ ...view(r), userId: r.userId, email: r.email, ...(r.tenantId && { tenantId: r.tenantId }), ...(r.doneBy && { doneBy: r.doneBy }) });

/** Panel: /setup-request (giriş etmiş istifadəçi; komanda üzvü yox) */
export function setupRequestRoutes(deps: Deps) {
  const { store, limiter, mailer, config } = deps;
  const r = Router();
  r.use(requireAuth);
  const notOperator = async (user: User) => {
    if (!(await store.findTenantByUser(user.id)) && (await memberTenant(store, user))) throw new HttpError(403, "Komanda üzvü qurulum sorğusu göndərə bilməz", "IS_OPERATOR");
  };

  r.get("/", async (_req, res) => {
    const x = await store.getSetupRequest(currentUser(res).id);
    res.json({ request: x ? view(x) : null });
  });

  r.post("/", async (req, res) => {
    const user = currentUser(res);
    await notOperator(user);
    const form = parseSetupForm(req.body); // forma xətaları limitə sayılmır: düzəldib yenidən göndərmək olsun
    if (!limiter.hit(`setupreq:${user.id}`, 20, 60 * 60_000)) throw new HttpError(429, "Çox tez-tez göndərirsən, bir az gözlə", "RATE_LIMITED");
    const cur = await store.getSetupRequest(user.id);
    if (cur && cur.status !== "new" && cur.status !== "done") throw new HttpError(409, "Sorğun artıq üzərində işlənir. Dəyişiklik üçün bizə yaz.", "IN_PROGRESS");
    const now = new Date();
    // Bitmiş sorğudan sonra yenisi: məsələn məlumat dəyişib, yenidən qurmaq lazımdır
    const fresh = !cur || cur.status === "done";
    const next: SetupRequest = { ...(fresh ? {} : cur), userId: user.id, email: user.email, ...form, status: "new", createdAt: fresh ? now : cur!.createdAt, updatedAt: now };
    if (fresh) { delete next.doneAt; delete next.doneBy; delete next.adminNote; }
    await store.saveSetupRequest(next);
    if (fresh) {
      const panel = config.allowedOrigins[0] ?? "";
      void sendAlert(deps, "setup", user.id, `🛠 Yeni qurulum sorğusu: ${form.businessName}`,
        `${user.email} pulsuz qurulum istəyir.\n\nBiznes: ${form.businessName}\nSayt: ${form.website || "yoxdur"}\nTelefon: ${form.phone}\nKanallar: ${form.channels.join(", ") || "-"}\n\n${form.description.slice(0, 500)}${form.description.length > 500 ? "…" : ""}\n\nAdmin panel: ${panel}/admin/setup`);
      void mailer.send(user.email, "Qurulum sorğun qəbul olundu",
        `Salam!\n\n${form.businessName} üçün qurulum sorğunu aldıq. Komandamız AI köməkçini sənin məlumatlarınla öyrədib hazırlayacaq və hazır olanda sənə e-poçt göndərəcək. Lazım olsa ${form.phone} nömrəsi ilə əlaqə saxlayacağıq.\n\nSorğunu panelin "Quraşdırma" səhifəsində görə və dəyişə bilərsən.`,
        { preheader: "Komandamız AI köməkçini sənin üçün quracaq" }).catch(() => {});
    }
    res.status(fresh ? 201 : 200).json({ request: view(next) });
  });

  r.delete("/", async (_req, res) => {
    const user = currentUser(res);
    const cur = await store.getSetupRequest(user.id);
    if (cur?.status === "in_progress") throw new HttpError(409, "Sorğun artıq üzərində işlənir. Ləğv etmək üçün bizə yaz.", "IN_PROGRESS");
    if (cur) await store.deleteSetupRequest(user.id);
    res.json({ ok: true });
  });
  return r;
}

/**
 * Admin: sorğudan bot qurur. Müştərinin hesabı yoxdursa dəstək rejimində yaradılır (məlumat bilik bazasına, satış ssenarisi
 * təlimata). Hesab varsa yalnız bilik bazasına mətn əlavə olunur (mövcud ayarlara toxunulmur). Sahibə "hazırdır" e-poçtu gedir.
 */
export async function buildFromRequest(deps: Deps, userId: string, by: string): Promise<{ request: SetupRequest; created: boolean; kb: number; warnings: string[] }> {
  const { store, ai, mailer, config } = deps;
  const req = await store.getSetupRequest(userId);
  if (!req) throw new HttpError(404, "Sorğu tapılmadı");
  const user = await store.findUserById(userId);
  if (!user) throw new HttpError(404, "İstifadəçi artıq yoxdur");
  let tenant = await store.findTenantByUser(user.id);
  if (!tenant && (await memberTenant(store, user))) throw new HttpError(409, "Bu istifadəçi başqa hesabın operatorudur", "IS_OPERATOR");
  const host = siteHost(req.website);
  let created = false;
  if (!tenant) {
    const company: Record<string, string> = { phone: req.phone.slice(0, 40), ...(host && { website: `https://${host}`.slice(0, 120) }) };
    const cfg = {
      businessName: req.businessName, domain: host || "sayt-yoxdur",
      profile: { mode: "support", language: "az", company, ...(req.salesScript && { extraInstructions: `Satış ssenarisi (sahibin qaydası, ona əməl et):\n${req.salesScript}`.slice(0, 1000) }) },
    };
    await createTenantFor(deps, user, cfg);
    tenant = await store.findTenantByUser(user.id);
    if (!tenant) throw new HttpError(500, "Müştəri yaradıldı, amma oxuna bilmədi");
    created = true;
  }
  // Bilik bazası: hər hissə ayrıca mənbə (sahib sonra ayrıca redaktə/silə bilsin). Biri alınmasa digərləri davam edir.
  const parts: [string, string][] = [["Biznes, məhsul və xidmətlər", req.description]];
  if (req.faq) parts.push(["Tez-tez verilən suallar", req.faq]);
  if (req.salesScript.length > 900 || !created) parts.push(["Satış ssenarisi", req.salesScript]);
  const warnings: string[] = [];
  let kb = 0;
  for (const [title, text] of parts) {
    if (text.trim().length < 20) continue;
    try { await ai.kbAddText(tenant.tenantId, title, text); kb++; }
    catch (e) { warnings.push(`${title}: ${e instanceof Error ? e.message : String(e)}`); }
  }
  const now = new Date();
  const done: SetupRequest = { ...req, status: "done", tenantId: tenant.tenantId, doneBy: by.slice(0, 80), doneAt: now, updatedAt: now };
  await store.saveSetupRequest(done);
  const panel = config.allowedOrigins[0] ?? "";
  void mailer.send(user.email, `AI köməkçin hazırdır: ${req.businessName}`,
    `Salam!\n\n${req.businessName} üçün AI köməkçini qurduq: göndərdiyin məlumat bilik bazasına əlavə olundu${created ? ", satış ssenarin təlimat kimi yazıldı" : ""}.\n\nİndi:\n1. Panelə daxil ol və "Sınaq söhbəti"ndə bir neçə sual ver.\n2. Cavab səhvdirsə "Bilik bazası"nda düzəlt.\n3. Saytına vidjeti qoy və ya Telegram/WhatsApp-ı qoş.\n\n${panel}/playground`,
    { action: "Sınaq söhbətini aç", preheader: "Göndərdiyin məlumatla öyrədildi, sınaya bilərsən" }).catch(() => {});
  return { request: done, created, kb, warnings };
}
