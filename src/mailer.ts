// E-poçt: Resend (https://resend.com) API ilə. RESEND_API_KEY yoxdursa (yalnız inkişaf) məktub konsola yazılır.
export type Mailer = { send(to: string, subject: string, text: string): Promise<void> };

export type MailerOptions = {
  apiKey?: string;
  /** Resend-də təsdiqlənmiş domen ünvanı: "Ad <no-reply@domen.az>" */
  from: string;
  replyTo?: string;
  fetchFn?: typeof fetch;
  /** Test üçün: təkrar cəhd arasındakı gözləmə (ms) */
  retryDelayMs?: number;
};

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** Düz mətni sadə, təhlükəsiz HTML məktuba çevirir: abzaslar, ayrıca sətirdəki 6 rəqəmli kod, linklər. */
export function renderHtml(subject: string, text: string): string {
  const link = (t: string) => esc(t).replace(/(https?:\/\/[^\s<]+[^\s<.,;:!?)])/g, '<a href="$1" style="color:#0b6bcb">$1</a>');
  const blocks = text.trim().split(/\n{2,}/).map((b) => {
    const t = b.trim();
    if (/^\d{6}$/.test(t)) return `<p style="margin:20px 0;text-align:center"><span style="display:inline-block;font:700 30px/1 ui-monospace,Menlo,Consolas,monospace;letter-spacing:8px;padding:14px 20px;background:#f3f5f8;border-radius:10px;color:#111">${t}</span></p>`;
    if (/^--$/.test(t.split("\n")[0] ?? "")) return `<p style="margin:24px 0 0;color:#6b7280;font-size:12px;line-height:1.5">${link(t.replace(/^--\n?/, "")).replace(/\n/g, "<br>")}</p>`;
    return `<p style="margin:0 0 14px;font-size:15px;line-height:1.6;color:#1f2937">${link(t).replace(/\n/g, "<br>")}</p>`;
  }).join("");
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(subject)}</title></head>
<body style="margin:0;padding:24px 12px;background:#f3f5f8;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;background:#fff;border-radius:14px;border:1px solid #e5e7eb">
<tr><td style="padding:22px 28px 6px;font-size:15px;font-weight:700;color:#111">Car Advisor</td></tr>
<tr><td style="padding:6px 28px 28px"><h1 style="margin:8px 0 16px;font-size:20px;line-height:1.3;color:#111">${esc(subject)}</h1>${blocks}</td></tr>
</table></td></tr></table></body></html>`;
}

export function createMailer(o: MailerOptions): Mailer {
  if (!o.apiKey) {
    // İnkişaf rejimi: email göndərilmir, mətn konsola yazılır.
    return { async send(to, subject, text) { console.log(`\n[mail → ${to}] ${subject}\n${text}\n`); } };
  }
  const doFetch = o.fetchFn ?? fetch;
  const wait = o.retryDelayMs ?? 800;
  return {
    async send(to, subject, text) {
      const body = JSON.stringify({ from: o.from, to: [to], subject, text, html: renderHtml(subject, text), ...(o.replyTo && { reply_to: o.replyTo }) });
      let last = "Resend cavab vermədi";
      for (let attempt = 0; attempt < 3; attempt++) {
        if (attempt) await new Promise((r) => setTimeout(r, wait * attempt));
        let res: Response;
        try {
          res = await doFetch("https://api.resend.com/emails", {
            method: "POST", body, signal: AbortSignal.timeout(10_000),
            headers: { authorization: `Bearer ${o.apiKey}`, "content-type": "application/json" },
          });
        } catch (e) { last = `Resend-ə qoşulmaq alınmadı (${e instanceof Error ? e.name : "xəta"})`; continue; }
        if (res.ok) return;
        const data = (await res.json().catch(() => ({}))) as { message?: string; name?: string };
        last = `Resend ${res.status}: ${String(data.message ?? data.name ?? "xəta").slice(0, 200)}`;
        if (res.status !== 429 && res.status < 500) break; // 4xx (yanlış açar, təsdiqlənməmiş domen və s.) təkrarla düzəlmir
      }
      throw new Error(last); // açar mətnə düşmür
    },
  };
}
