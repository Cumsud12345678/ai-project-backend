// E-poçt: Resend (https://resend.com) API ilə. RESEND_API_KEY yoxdursa (yalnız inkişaf) məktub konsola yazılır.
//
// Dizayn: bütün məktublar bir şablondan keçir (rəsmi xidmət məktubları kimi): brend başlığı, ağ kart, aydın başlıq,
// 6 rəqəmli kod üçün ayrıca blok, "Ad: dəyər" sətirləri üçün cədvəl, link üçün düymə, təhlükəsizlik qeydi və altda
// hüquqi linklər. Yalnız cədvəl + inline stil işlənir (Gmail, Outlook, Apple Mail eyni göstərir), şəkil yoxdur
// (şəkillər çox vaxt bloklanır və spam balını artırır). Hər məktubun düz mətn variantı da göndərilir.
export type MailLang = "az" | "en" | "ru" | "tr";
export type MailOptions = {
  /** Gələnlər qutusunda mövzunun yanında görünən qısa mətn */
  preheader?: string;
  /** Kod, parol və giriş məktubları: altda "kodu heç kimlə paylaşma" qeydi */
  security?: boolean;
  /** Düymənin yazısı (mətndə abzasın sonunda ayrıca sətirdə olan ilk link düyməyə çevrilir) */
  action?: string;
  /** Hesabat və bildirişlər: altda "bildiriş ayarları" linki */
  manageUrl?: string;
  /** Müştərinin ziyarətçisinə gedən məktub: başlıqda bizim yox, biznesin adı */
  sender?: { name: string; url?: string };
  lang?: MailLang;
};
export type Mailer = { send(to: string, subject: string, text: string, opts?: MailOptions): Promise<void> };

export type Brand = { name: string; url?: string; supportEmail?: string };
export type MailerOptions = {
  apiKey?: string;
  /** Resend-də təsdiqlənmiş domen ünvanı: "Ad <no-reply@domen.az>" */
  from: string;
  replyTo?: string;
  brand?: Brand;
  fetchFn?: typeof fetch;
  /** Test üçün: təkrar cəhd arasındakı gözləmə (ms) */
  retryDelayMs?: number;
};

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const URL_RE = /(https?:\/\/[^\s<]+[^\s<.,;:!?)])/g;
const LONE_URL = /^https?:\/\/\S+$/;

const L: Record<MailLang, { open: string; fallback: string; security: (b: string) => string; why: string; whyVisitor: (b: string) => string; terms: string; privacy: string; manage: string; support: string; via: (b: string) => string }> = {
  az: {
    open: "Davam et", fallback: "Düymə işləmirsə, bu linki brauzerə yapışdır:",
    security: (b) => `${b} əməkdaşları heç vaxt bu kodu soruşmur. Kodu heç kimlə paylaşma.`,
    why: "Bu məktub hesabınla bağlı xidməti bildirişdir.", whyVisitor: (b) => `Bu məktub ${b} saytındakı söhbətə görə göndərilib.`,
    terms: "İstifadə şərtləri", privacy: "Məxfilik siyasəti", manage: "Bildiriş ayarları", support: "Dəstək", via: (b) => `${b} vasitəsilə göndərilib`,
  },
  en: {
    open: "Continue", fallback: "If the button doesn't work, paste this link into your browser:",
    security: (b) => `${b} staff will never ask for this code. Don't share it with anyone.`,
    why: "This is a service message about your account.", whyVisitor: (b) => `You received this because of your conversation on ${b}'s website.`,
    terms: "Terms of Service", privacy: "Privacy Policy", manage: "Notification settings", support: "Support", via: (b) => `Sent via ${b}`,
  },
  ru: {
    open: "Продолжить", fallback: "Если кнопка не работает, вставьте ссылку в браузер:",
    security: (b) => `Сотрудники ${b} никогда не спрашивают этот код. Никому его не сообщайте.`,
    why: "Это служебное письмо о вашем аккаунте.", whyVisitor: (b) => `Письмо отправлено из-за вашего чата на сайте ${b}.`,
    terms: "Условия использования", privacy: "Политика конфиденциальности", manage: "Настройки уведомлений", support: "Поддержка", via: (b) => `Отправлено через ${b}`,
  },
  tr: {
    open: "Devam et", fallback: "Düğme çalışmıyorsa bu linki tarayıcına yapıştır:",
    security: (b) => `${b} çalışanları bu kodu asla sormaz. Kodu kimseyle paylaşma.`,
    why: "Bu, hesabınla ilgili bir hizmet bildirimidir.", whyVisitor: (b) => `Bu e-posta ${b} sitesindeki sohbetiniz nedeniyle gönderildi.`,
    terms: "Kullanım şartları", privacy: "Gizlilik politikası", manage: "Bildirim ayarları", support: "Destek", via: (b) => `${b} aracılığıyla gönderildi`,
  },
};

const C = { bg: "#f4f4f5", card: "#ffffff", line: "#e4e4e7", ink: "#09090b", text: "#3f3f46", sub: "#71717a", soft: "#f4f4f5" };
const FONT = "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";
const link = (t: string) => esc(t).replace(URL_RE, `<a href="$1" style="color:${C.ink};text-decoration:underline">$1</a>`);
const para = (html: string) => `<p style="margin:0 0 16px;font-size:15px;line-height:1.65;color:${C.text}">${html}</p>`;

function button(url: string, label: string, fallback: string): string {
  const u = esc(url);
  return `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:8px 0 20px"><tr><td style="border-radius:8px;background:${C.ink}">`
    + `<a href="${u}" target="_blank" style="display:inline-block;padding:12px 22px;font:600 15px/1 ${FONT};color:#ffffff;text-decoration:none;border-radius:8px">${esc(label)}</a>`
    + `</td></tr></table>`
    + `<p style="margin:0 0 16px;font-size:12px;line-height:1.5;color:${C.sub}">${esc(fallback)}<br><a href="${u}" style="color:${C.sub};word-break:break-all">${u}</a></p>`;
}

/** "Ad: X\nƏlaqə: Y" kimi blok → iki sütunlu cədvəl */
function facts(lines: string[]): string {
  const rows = lines.map((l, i) => {
    const k = l.indexOf(":");
    const top = i ? `border-top:1px solid ${C.line};` : "";
    return `<tr><td style="${top}padding:9px 14px 9px 0;font-size:13px;color:${C.sub};vertical-align:top;white-space:nowrap">${esc(l.slice(0, k))}</td>`
      + `<td style="${top}padding:9px 0;font-size:14px;color:${C.ink};vertical-align:top;word-break:break-word">${link(l.slice(k + 1).trim())}</td></tr>`;
  }).join("");
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:4px 0 20px;border:1px solid ${C.line};border-radius:10px"><tr><td style="padding:2px 16px"><table role="presentation" width="100%" cellpadding="0" cellspacing="0">${rows}</table></td></tr></table>`;
}

/** Düz mətni məktub HTML-inə çevirir. Mətnin quruluşu: boş sətirlə ayrılmış abzaslar. */
export function renderHtml(subject: string, text: string, opts: MailOptions = {}, brand: Brand = { name: "Hazırcavab" }): string {
  const m = L[opts.lang ?? "az"] ?? L.az;
  let buttonUsed = false;
  let footNote = "";
  const blocks = text.trim().split(/\n{2,}/).map((b) => {
    const t = b.trim();
    const lines = t.split("\n");
    if (/^\d{6}$/.test(t)) {
      return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:6px 0 22px"><tr><td align="center" style="background:${C.soft};border:1px solid ${C.line};border-radius:12px;padding:18px 12px">`
        + `<span style="font:700 34px/1 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;letter-spacing:10px;color:${C.ink}">${t}</span></td></tr></table>`;
    }
    if (lines[0] === "--") { footNote = link(lines.slice(1).join("\n")).replace(/\n/g, "<br>"); return ""; }
    if (lines.length >= 2 && lines.every((l) => /^[^:\n]{1,32}:\s\S/.test(l) && !LONE_URL.test(l))) return facts(lines);
    // Abzasın son sətri tək linkdirsə: mətn + düymə (yalnız birinci link düymə olur)
    const last = lines[lines.length - 1] ?? "";
    if (!buttonUsed && LONE_URL.test(last)) {
      buttonUsed = true;
      const before = lines.slice(0, -1).join("\n");
      return (before ? para(link(before).replace(/\n/g, "<br>")) : "") + button(last, opts.action ?? m.open, m.fallback);
    }
    return para(link(t).replace(/\n/g, "<br>"));
  }).join("");

  const head = opts.sender ?? brand;
  const initial = esc((head.name.trim()[0] ?? "•").toUpperCase());
  const security = opts.security
    ? `<tr><td style="padding:0 32px 28px"><table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td style="background:${C.soft};border-radius:10px;padding:12px 14px;font-size:12px;line-height:1.55;color:${C.sub}">&#128274;&nbsp; ${esc(m.security(brand.name))}</td></tr></table></td></tr>`
    : "";
  const base = brand.url?.replace(/\/$/, "");
  const a = (href: string, label: string) => `<a href="${esc(href)}" style="color:${C.sub};text-decoration:underline">${esc(label)}</a>`;
  const links = [
    ...(opts.manageUrl ? [a(opts.manageUrl, m.manage)] : []),
    ...(base && !opts.sender ? [a(`${base}/legal/terms`, m.terms), a(`${base}/legal/privacy`, m.privacy)] : []),
    ...(brand.supportEmail && !opts.sender ? [a(`mailto:${brand.supportEmail}`, m.support)] : []),
  ].join(" &nbsp;·&nbsp; ");
  const why = opts.sender ? m.whyVisitor(opts.sender.name) : m.why;
  const pre = opts.preheader ? `<div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent;mso-hide:all">${esc(opts.preheader)}${"&#847;&zwnj;&nbsp;".repeat(40)}</div>` : "";

  return `<!doctype html><html lang="${opts.lang ?? "az"}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light"><meta name="supported-color-schemes" content="light"><meta name="x-apple-disable-message-reformatting"><title>${esc(subject)}</title></head>
<body style="margin:0;padding:0;background:${C.bg};font-family:${FONT};-webkit-font-smoothing:antialiased">${pre}
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${C.bg}"><tr><td align="center" style="padding:32px 12px">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px">
<tr><td style="padding:0 4px 18px"><table role="presentation" cellpadding="0" cellspacing="0"><tr>
<td style="width:30px;height:30px;background:${C.ink};border-radius:8px;text-align:center;vertical-align:middle;font:700 15px/30px ${FONT};color:#ffffff">${initial}</td>
<td style="padding-left:10px;font:700 16px/1 ${FONT};color:${C.ink}">${esc(head.name)}</td></tr></table></td></tr>
<tr><td style="background:${C.card};border:1px solid ${C.line};border-radius:14px">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0">
<tr><td style="padding:32px 32px 8px"><h1 style="margin:0 0 18px;font:700 22px/1.3 ${FONT};color:${C.ink};letter-spacing:-0.2px">${esc(subject)}</h1>${blocks}${footNote ? `<p style="margin:8px 0 16px;font-size:12px;line-height:1.55;color:${C.sub}">${footNote}</p>` : ""}</td></tr>
${security}</table></td></tr>
<tr><td style="padding:22px 8px 0;font-size:12px;line-height:1.6;color:${C.sub};text-align:center">
${esc(why)}${links ? `<br>${links}` : ""}<br>${opts.sender ? esc(m.via(brand.name)) : `&copy; ${new Date().getFullYear()} ${esc(brand.name)}`}
</td></tr></table></td></tr></table></body></html>`;
}

export function createMailer(o: MailerOptions): Mailer {
  const brand = o.brand ?? { name: "Hazırcavab" };
  if (!o.apiKey) {
    // İnkişaf rejimi: email göndərilmir, mətn konsola yazılır.
    return { async send(to, subject, text) { console.log(`\n[mail → ${to}] ${subject}\n${text}\n`); } };
  }
  const doFetch = o.fetchFn ?? fetch;
  const wait = o.retryDelayMs ?? 800;
  return {
    async send(to, subject, text, opts = {}) {
      // Ziyarətçiyə gedən məktubda "Kimdən" adı biznesin adı olur (ünvan eyni qalır, domen təsdiqi pozulmur)
      const addr = /<([^>]+)>/.exec(o.from)?.[1] ?? o.from;
      const from = opts.sender ? `${opts.sender.name.replace(/["<>\r\n]/g, "").slice(0, 60)} <${addr}>` : o.from;
      const body = JSON.stringify({
        from, to: [to], subject, text, html: renderHtml(subject, text, opts, brand),
        ...(o.replyTo && !opts.sender && { reply_to: o.replyTo }),
        ...(opts.manageUrl && { headers: { "List-Unsubscribe": `<${opts.manageUrl}>` } }),
      });
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
