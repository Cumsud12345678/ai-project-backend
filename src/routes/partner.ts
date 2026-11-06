// Partnyorun öz səhifəsi: kodu, linki, balansı, gətirdiyi müştərilər və hərəkətlər. Pul çıxarmaq hələlik yoxdur.
import { Router } from "express";
import type { Deps } from "../deps.js";
import { HttpError } from "../http.js";
import { currentUser, requireAuth } from "../middleware.js";
import { getPartnerSettings, partnerCustomers, publicPartner, syncThrottled } from "../partners.js";

export function partnerRoutes(deps: Deps) {
  const r = Router();
  r.use(requireAuth);

  r.get("/", async (_req, res) => {
    const me = currentUser(res);
    if (!me.partner) throw new HttpError(403, "Partnyor deyilsən", "NOT_PARTNER");
    await syncThrottled(deps, me.id);
    const [settings, totals, customers, entries] = await Promise.all([
      getPartnerSettings(deps), deps.store.partnerTotals([me.id]), partnerCustomers(deps, me.id, { revealEmail: false }), deps.store.listPartnerEntries(me.id, 100),
    ]);
    const origin = deps.config.allowedOrigins[0] ?? "";
    res.json({
      partner: publicPartner(me.partner),
      link: `${origin}/r/${me.partner.code}`,
      settings: { months: settings.months, bonusPct: settings.bonusPct, bonusCapAzn: settings.bonusCapAzn },
      totals: totals[me.id] ?? { earned: 0, adjust: 0, paidOut: 0, balance: 0 },
      customers,
      entries: entries.map((e) => ({ id: e.id, kind: e.kind, amountAzn: e.amountAzn, at: e.at, baseAzn: e.baseAzn ?? null, rate: e.rate ?? null, note: e.note ?? "" })),
    });
  });

  return r;
}
