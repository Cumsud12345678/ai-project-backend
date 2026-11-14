// WhatsApp saatlıq tavanı: nömrə qadağan olunmasın deyə bot saatda müəyyən sayda mesajı emal edir.
// Tavan plana görədir (böyük biznes daha çox yazışır). Dolanda bot susur, amma səssiz yox: canlı operator işləyirsə
// söhbət operator qutusuna düşür (channel-chat), sahibə isə saatda bir dəfə e-poçt və Telegram bildirişi gedir.
import type { Deps } from "../deps.js";
import { loadEntitlements } from "../plans.js";
import { notifyTeam } from "../operator-notify.js";
import type { TenantRecord } from "../store/types.js";

const BY_PLAN: Record<string, number> = { start: 300, business: 600, pro: 1500 };
const DEFAULT = 300;

/** Saatlıq tavan: WA_HOURLY_CAP mühit dəyişəni hamı üçün üstələyir */
export async function waHourlyCap(deps: Pick<Deps, "ai">, tenantId: string): Promise<number> {
  const env = Number(process.env.WA_HOURLY_CAP);
  if (Number.isFinite(env) && env > 0) return Math.round(env);
  const e = await loadEntitlements(deps, tenantId);
  return (e.plan && BY_PLAN[e.plan]) || DEFAULT;
}

/** true: bu mesaj emal oluna bilər. false: tavan dolub (sahibə saatda bir dəfə xəbər verilir). */
export async function waCapOk(deps: Deps, t: TenantRecord): Promise<boolean> {
  const cap = await waHourlyCap(deps, t.tenantId);
  if (deps.limiter.hit(`wa:cap:${t.tenantId}`, cap, 60 * 60_000)) return true;
  if (deps.limiter.hit(`wa:capwarn:${t.tenantId}`, 1, 60 * 60_000)) void warnOwner(deps, t, cap);
  return false;
}

async function warnOwner(deps: Deps, t: TenantRecord, cap: number) {
  const text = `⚠️ WhatsApp: son bir saatda ${cap} mesaj limitinə çatıldı (${t.businessName}). Nömrənin bloklanmaması üçün köməkçi bir saata qədər yeni mesajlara cavab vermir. Canlı söhbət açıqdırsa, yeni yazanlar panelin "Canlı söhbət" qutusuna düşür, operator oradan cavab verə bilər. Açıq deyilsə, mesajlar telefonundakı WhatsApp-da görünür, təcili olanlara özün cavab ver. Bu tez-tez olursa, daha böyük plana keç.`;
  try {
    const owner = await deps.store.findUserById(t.userId);
    if (owner) await deps.mailer.send(owner.email, `WhatsApp saatlıq limiti doldu: ${t.businessName}`, text, { preheader: "Köməkçi bir saata qədər yeni mesajlara cavab vermir" });
  } catch (e) { console.warn("[whatsapp] limit bildirişi getmədi:", e instanceof Error ? e.message : e); }
  await notifyTeam(deps, t, text, "/settings/channels");
  console.warn(`[whatsapp] ${t.tenantId}: saatlıq tavan (${cap}) doldu`);
}
