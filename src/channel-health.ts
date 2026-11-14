// Kanal sağlamlığı: bot qəfil dayananda (Telegram tokeni ləğv olunub, WhatsApp telefondan ayrılıb və ya bağlantı bərpa olunmur)
// sahib bundan xəbər tutmalıdır, yoxsa müştəriləri cavabsız qalır və o bunu gec bilir.
// - Sahibə e-poçt + Telegram bildirişi (kanal üzrə gündə ən çox bir dəfə).
// - Telegram: saatlıq yoxlama (getMe). Token işləmirsə bağlantıda xəta qeyd olunur, panel onu göstərir; düzələndə silinir.
import type { Deps } from "./deps.js";
import { notifyTeam } from "./operator-notify.js";
import { decryptSecret } from "./secrets.js";
import { TelegramError } from "./telegram.js";
import type { TenantRecord } from "./store/types.js";

type Channel = "Telegram" | "WhatsApp";
const FIX: Record<Channel, string> = {
  Telegram: "Panelin \"Kanallar → Telegram\" bölməsində botun tokenini yenidən qoş (BotFather-də tokeni yeniləmisənsə, yenisini kopyala).",
  WhatsApp: "Panelin \"Kanallar → WhatsApp\" bölməsində QR kodu telefonla yenidən oxut.",
};

/** Sahibə: kanal işləmir (gündə bir dəfə) */
export async function notifyChannelDown(deps: Deps, t: TenantRecord, channel: Channel, problem: string): Promise<void> {
  if (!deps.limiter.hit(`chdown:${t.tenantId}:${channel}`, 1, 24 * 60 * 60_000)) return;
  const text = `${channel} köməkçisi işləmir: ${problem}\n\nBu müddətdə ${channel}-dan yazan müştərilərə bot cavab vermir.\n\nNə etməli: ${FIX[channel]}`;
  try {
    const owner = await deps.store.findUserById(t.userId);
    const panel = deps.config.allowedOrigins[0] ?? "";
    if (owner) await deps.mailer.send(owner.email, `${channel} bağlantısı kəsildi: ${t.businessName}`, `${text}${panel ? `\n\n${panel}/settings/channels` : ""}`, { action: "Yenidən qoş", preheader: `${channel}-da müştərilərə cavab getmir` });
  } catch (e) { console.warn("[channel-health] e-poçt getmədi:", e instanceof Error ? e.message : e); }
  await notifyTeam(deps, t, `⚠️ ${text}`, "/settings/channels");
}

/** Saatlıq: qoşulmuş Telegram botlarının tokeni hələ işləyirmi */
export async function checkTelegramBots(deps: Deps): Promise<number> {
  let broken = 0;
  for (const t of await deps.store.listTenants(5000)) {
    const l = t.telegram;
    if (!l?.enabled) continue;
    let error: string | null = null;
    try { await deps.telegram.getMe(decryptSecret(l.tokenEnc, deps.config.secretKey)); }
    catch (e) {
      // Yalnız tokenin özü etibarsızdırsa (401/404). Şəbəkə xətası müvəqqətidir: növbəti yoxlamada yenə baxılır
      if (e instanceof TelegramError && (e.status === 401 || e.status === 404)) error = "Bot tokeni etibarsızdır (BotFather-də yenilənib və ya bot silinib)";
      else continue;
    }
    if (error) {
      broken++;
      if (!l.error) await deps.store.updateTenant(t.tenantId, { telegram: { ...l, error, errorAt: new Date() } });
      await notifyChannelDown(deps, t, "Telegram", error);
    } else if (l.error) {
      const { error: _e, errorAt: _a, ...rest } = l;
      await deps.store.updateTenant(t.tenantId, { telegram: rest });
    }
  }
  return broken;
}
