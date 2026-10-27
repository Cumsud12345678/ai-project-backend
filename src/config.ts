export type Config = {
  port: number;
  mongoUri: string;
  dbName: string;
  aiServiceUrl: string;
  aiServiceToken: string;
  /** Müştəriyə göstərilən, AI servisinin açıq ünvanı (curl nümunəsi üçün). */
  publicAdvisorUrl: string;
  /** Müştəriyə göstərilən portal ünvanı: vidjet scripti buradan yüklənir (<script src=".../widget.js">). */
  publicPortalUrl: string;
  adminEmails: string[];
  allowedOrigins: string[];
  cookieSecure: boolean;
  sessionDays: number;
  /** Resend API açarı (https://resend.com/api-keys). Boşdursa email göndərilmir, konsola yazılır (yalnız inkişaf). */
  resendApiKey: string | undefined;
  mailFrom: string;
  mailReplyTo: string | undefined;
  trustProxy: number;
  isProd: boolean;
};

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const isProd = env.NODE_ENV === "production";
  const missing = ["MONGODB_URI", "AI_SERVICE_URL", "AI_SERVICE_TOKEN"].filter((k) => !env[k]);
  if (isProd && !env.RESEND_API_KEY) missing.push("RESEND_API_KEY (production-da email göndərmək üçün lazımdır)");
  if (isProd && !env.MAIL_FROM) missing.push("MAIL_FROM (Resend-də təsdiqlənmiş domen, məs. Car Advisor <no-reply@senin-saytin.az>)");
  if (missing.length) throw new Error(`Bu mühit dəyişənləri yoxdur: ${missing.join(", ")}`);

  const list = (v: string | undefined) => (v ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  const aiServiceUrl = env.AI_SERVICE_URL!.replace(/\/+$/, "");
  return {
    port: Number(env.PORT) || 4000,
    mongoUri: env.MONGODB_URI!,
    dbName: env.MONGODB_DB || "car_advisor_portal",
    aiServiceUrl,
    aiServiceToken: env.AI_SERVICE_TOKEN!,
    publicAdvisorUrl: (env.PUBLIC_ADVISOR_URL || aiServiceUrl).replace(/\/+$/, ""),
    publicPortalUrl: (env.PUBLIC_PORTAL_URL || `http://localhost:${Number(env.PORT) || 4000}`).replace(/\/+$/, ""),
    adminEmails: list(env.ADMIN_EMAILS).map((e) => e.toLowerCase()),
    allowedOrigins: list(env.ALLOWED_ORIGINS || "http://localhost:3001"),
    cookieSecure: env.COOKIE_SECURE ? env.COOKIE_SECURE === "1" : isProd,
    sessionDays: Number(env.SESSION_DAYS) || 30,
    resendApiKey: env.RESEND_API_KEY || undefined,
    mailFrom: env.MAIL_FROM || "Car Advisor <onboarding@resend.dev>",
    mailReplyTo: env.MAIL_REPLY_TO || undefined,
    trustProxy: env.TRUST_PROXY === undefined ? 1 : Number(env.TRUST_PROXY),
    isProd,
  };
}
