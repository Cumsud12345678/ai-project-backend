/*!
 * Car Advisor çat vidjeti
 * Quraşdırma (saytın </body> teqindən əvvəl):
 *   <script src="https://PORTAL/widget.js" data-key="wk_..." defer></script>
 * İstəyə bağlı (hamısı piksellə, yalnız rəqəm). Ekran 3 pilləyə bölünür:
 *   lg  kompüter  (eni >= 1024)        planşet: md (768..1023)        telefon: sm (< 768)
 *   data-position="left"                düymə solda (defolt: sağda)
 *   data-side / data-bottom             lg: yan və aşağı kənardan məsafə (defolt 20)
 *   data-side-md / data-bottom-md       md: yazılmasa lg dəyəri
 *   data-side-sm / data-bottom-sm       sm: yazılmasa md dəyəri (köhnə adlar: data-side-mobile / data-bottom-mobile)
 *   data-bp-md="768" data-bp-lg="1024"  pillələrin başladığı en (px)
 * sm pilləsində çat tam ekran açılır və arxa fon scroll olunmur; md və lg-də sağ aşağıda pəncərədir.
 * Saytın öz CSS-i ilə də dəyişmək olar (script atributlarından üstündür):
 *   [data-car-advisor]{ --ca-side:30px; --ca-bottom:90px; --ca-side-md:..; --ca-bottom-md:..; --ca-side-sm:..; --ca-bottom-sm:..; --ca-z:9999 }
 *   data-show-on="/,/products/*"       çat yalnız bu səhifələrdə görünür (vergüllə; /yol dəqiq, /yol/* altındakıların hamısı, * hər yer)
 *   data-hide-on="/checkout,/admin/*"  çat bu səhifələrdə gizlənir (ikisi də yazılıbsa: show-on-a uyğun və hide-on-a uyğun olmayan)
 *   Next.js və digər SPA saytlarda link ilə keçid (səhifə yenilənmədən) və geri düyməsi də izlənir.
 * Əl ilə idarə: window.CarAdvisor.open() / close() / toggle() / destroy()
 *
 * Vidjet yalnız ictimai açar (wk_...) göndərir. Gizli API açarı burada lazım deyil.
 */
(function () {
  "use strict";
  if (window.__carAdvisorWidget) return;

  var script = document.currentScript || (function () {
    var all = document.querySelectorAll("script[data-key][src]");
    for (var i = all.length - 1; i >= 0; i--) if (/widget\.js(\?|$)/.test(all[i].getAttribute("src") || "")) return all[i];
    return null;
  })();
  if (!script || !script.src) return console.warn("[car-advisor] script teqi tapılmadı");
  var key = script.getAttribute("data-key") || "";
  if (!/^wk_[a-f0-9]{32}$/.test(key)) return console.warn("[car-advisor] data-key düzgün deyil");
  window.__carAdvisorWidget = true;

  var base = new URL(script.src, location.href).origin;
  var api = base + "/widget/" + key;
  var position = script.getAttribute("data-position") === "left" ? "left" : "right";
  // Piksel dəyərləri: yalnız sonlu rəqəm, 0..3000 arası. Yazılmayıbsa və ya yanlışdırsa null (yəni "miras al").
  function pxOrNull(attr) {
    var raw = script.getAttribute(attr);
    var n = raw === null || raw === "" ? NaN : parseFloat(raw);
    return isFinite(n) ? Math.min(3000, Math.max(0, n)) : null;
  }
  function px(attr, fallback) { var n = pxOrNull(attr); return n === null ? fallback : n; }
  var first = function (a, b) { return a !== null ? a : b; };
  // lg -> md -> sm: yazılmayan pillə yuxarıdakından miras alır (CSS dəyişəni ilə, ona görə saytın CSS-i də zəncirlə axır).
  var sideLg = px("data-side", 20), bottomLg = px("data-bottom", 20);
  var sideMd = pxOrNull("data-side-md"), bottomMd = pxOrNull("data-bottom-md");
  var sideSm = first(pxOrNull("data-side-sm"), pxOrNull("data-side-mobile")), bottomSm = first(pxOrNull("data-bottom-sm"), pxOrNull("data-bottom-mobile"));
  // Pillələrin başladığı en. 0.02 çıxılır ki, kəsr enli ekranda (zoom) boşluq qalmasın.
  var bpMd = Math.max(320, px("data-bp-md", 768)), bpLg = Math.max(bpMd, px("data-bp-lg", 1024));
  var MQ_SM = "(max-width:" + (bpMd - 0.02) + "px)", MQ_MD = "(max-width:" + (bpLg - 0.02) + "px)";
  var STORE = "ca_w_" + key;
  var MAX_STORED = 30;

  // ---------- kiçik köməkçilər ----------
  function el(tag, props, children) {
    var n = document.createElement(tag);
    if (props) for (var k in props) {
      if (k === "class") n.className = props[k];
      else if (k === "text") n.textContent = props[k];
      else if (k.slice(0, 2) === "on") n.addEventListener(k.slice(2), props[k]);
      else n.setAttribute(k, props[k]);
    }
    (children || []).forEach(function (c) { if (c) n.appendChild(c); });
    return n;
  }
  function load() {
    try { var v = JSON.parse(sessionStorage.getItem(STORE) || "{}"); return { messages: Array.isArray(v.messages) ? v.messages : [], open: !!v.open }; }
    catch (e) { return { messages: [], open: false }; }
  }
  function save() {
    try { sessionStorage.setItem(STORE, JSON.stringify({ messages: state.messages.slice(-MAX_STORED), open: state.open })); } catch (e) { /* məxfi rejim */ }
  }
  var state = load();

  function textColorFor(hex) {
    var n = parseInt(hex.slice(1), 16), r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
    return (0.299 * r + 0.587 * g + 0.114 * b) > 160 ? "#111827" : "#ffffff";
  }
  // Brauzerin dil məlumatından asılı olmasın deyə rəqəmlər özümüz formatlanır: 1900 -> "1 900".
  var fmt = function (n) { return String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, " "); };
  // Yeni mətnlər (mənbələr, əlaqə forması): səhifənin dilinə görə az / en / ru
  var L = (function () {
    var lang = ((document.documentElement.lang || navigator.language || "az") + "").slice(0, 2).toLowerCase();
    var T = {
      az: { src: "Mənbə:", offline: "Çat hazırda cavab vermir. İstəsəniz əlaqə qoyun, sizinlə əlaqə saxlayaq.", contact: "Operatorla əlaqə", name: "Adınız (ixtiyari)", cont: "Telefon və ya e-poçt", send: "Göndər", ok: "Təşəkkürlər! Müraciətiniz qəbul edildi, tezliklə sizinlə əlaqə saxlayacağıq.", bad: "Düzgün telefon nömrəsi və ya e-poçt yazın", fail: "Göndərilə bilmədi, bir azdan yenidən cəhd edin", cancel: "Ləğv et", fresh: "Yeni söhbət", limit: "Bu gün üçün sual limitinə çatdınız. İstəsəniz əlaqə qoyun, sizinlə əlaqə saxlayaq.", busy: "Çat hazırda çox yüklüdür. İstəsəniz əlaqə qoyun, sizinlə əlaqə saxlayaq." },
      en: { src: "Source:", offline: "The chat can't answer right now. Leave your contact and we'll get back to you.", contact: "Contact an operator", name: "Your name (optional)", cont: "Phone or email", send: "Send", ok: "Thank you! Your request was received, we'll contact you soon.", bad: "Enter a valid phone number or email", fail: "Could not send, please try again shortly", cancel: "Cancel", fresh: "New chat", limit: "You have reached today's question limit. Leave your contact and we'll get back to you.", busy: "The chat is very busy right now. Leave your contact and we'll get back to you." },
      ru: { src: "Источник:", offline: "Чат сейчас не может ответить. Оставьте контакт, и мы свяжемся с вами.", contact: "Связаться с оператором", name: "Ваше имя (необязательно)", cont: "Телефон или e-mail", send: "Отправить", ok: "Спасибо! Ваше обращение принято, мы скоро свяжемся с вами.", bad: "Введите корректный телефон или e-mail", fail: "Не удалось отправить, попробуйте позже", cancel: "Отмена", fresh: "Новый чат", limit: "Вы достигли лимита вопросов на сегодня. Оставьте контакт, и мы свяжемся с вами.", busy: "Чат сейчас сильно загружен. Оставьте контакт, и мы свяжемся с вами." },
    };
    return T[lang] || T.az;
  })();
  // Anonim ziyarətçi ID-si (təsadüfi, şəxsi məlumat deyil): eyni şəbəkədəki ziyarətçilər bir limiti bölüşməsin deyə.
  var memVid = "";
  function visitorId() {
    var ok = function (v) { return typeof v === "string" && /^[a-f0-9]{16,32}$/.test(v); };
    var K = "ca_vid";
    try { var v = localStorage.getItem(K); if (ok(v)) return v; } catch (e) { /* bağlıdır */ }
    if (!memVid) {
      var a = "";
      try { var arr = new Uint8Array(12); crypto.getRandomValues(arr); for (var i = 0; i < arr.length; i++) a += ("0" + arr[i].toString(16)).slice(-2); }
      catch (e) { for (var j = 0; j < 24; j++) a += Math.floor(Math.random() * 16).toString(16); }
      memVid = a;
      try { localStorage.setItem(K, a); } catch (e) { try { sessionStorage.setItem(K, a); } catch (e2) { /* yaddaşda qalır */ } }
    }
    return memVid;
  }
  var isUrl = function (u) { return typeof u === "string" && /^https?:\/\//i.test(u); };

  // ---------- təhlükəsiz mətn göstəricisi (innerHTML yoxdur) ----------
  // Dəstəklənir: **qalın**, [mətn](https://...), "* " / "- " siyahıları, sətir keçidləri.
  var INLINE = /\*\*([^*]+)\*\*|\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g;
  function inline(parent, text) {
    var last = 0, m;
    INLINE.lastIndex = 0;
    while ((m = INLINE.exec(text))) {
      if (m.index > last) parent.appendChild(document.createTextNode(text.slice(last, m.index)));
      if (m[1] !== undefined) parent.appendChild(el("strong", { text: m[1] }));
      else parent.appendChild(el("a", { href: m[3], target: "_blank", rel: "noopener noreferrer", text: m[2] }));
      last = m.index + m[0].length;
    }
    if (last < text.length) parent.appendChild(document.createTextNode(text.slice(last)));
  }
  function renderText(container, text) {
    var lines = String(text).replace(/\r/g, "").split("\n");
    var i = 0;
    while (i < lines.length) {
      if (!lines[i].trim()) { i++; continue; }
      if (/^\s*[*-]\s+/.test(lines[i])) {
        var ul = el("ul");
        while (i < lines.length && /^\s*[*-]\s+/.test(lines[i])) {
          var li = el("li");
          inline(li, lines[i].replace(/^\s*[*-]\s+/, ""));
          ul.appendChild(li);
          i++;
        }
        container.appendChild(ul);
      } else {
        var p = el("p");
        var first = true;
        while (i < lines.length && lines[i].trim() && !/^\s*[*-]\s+/.test(lines[i])) {
          if (!first) p.appendChild(el("br"));
          inline(p, lines[i].trim());
          first = false;
          i++;
        }
        container.appendChild(p);
      }
    }
  }

  // ---------- görünüş ----------
  var CSS = [
    ":host{all:initial}",
    "*{box-sizing:border-box;font-family:system-ui,-apple-system,'Segoe UI',Roboto,sans-serif}",
    ".launcher{position:fixed;bottom:var(--cy);" + position + ":var(--cx);width:56px;height:56px;border-radius:50%;border:0;cursor:pointer;background:var(--accent);color:var(--accent-fg);display:grid;place-items:center;box-shadow:0 6px 20px rgba(0,0,0,.25);z-index:var(--ca-z);transition:transform .15s}",
    ".launcher:hover{transform:scale(1.06)}",
    // Loqonun yanındakı yazı: loqonun mərkəzi ilə eyni hündürlükdə (56px loqo, 44px yazı -> 6px yuxarı)
    ".hint{position:fixed;bottom:calc(var(--cy) + 6px);height:44px;" + position + ":calc(var(--cx) + 66px);max-width:calc(100vw - var(--cx) - 78px);display:flex;align-items:center;padding:0 16px;border:0;border-radius:22px;background:#fff;color:#111827;font-size:14px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;cursor:pointer;box-shadow:0 6px 20px rgba(0,0,0,.2);z-index:var(--ca-z);animation:hintIn .35s ease both}",
    "@keyframes hintIn{from{opacity:0;transform:translateX(" + (position === "left" ? "-" : "") + "8px)}to{opacity:1;transform:none}}",
    ".launcher:focus-visible,button:focus-visible,textarea:focus-visible,a:focus-visible{outline:2px solid var(--accent);outline-offset:2px}",
    ".launcher svg{width:26px;height:26px}",
    ".panel{position:fixed;bottom:calc(var(--cy) + 68px);" + position + ":var(--cx);width:380px;max-width:calc(100vw - 24px);height:560px;max-height:max(240px,calc(100vh - var(--cy) - 88px));background:#fff;color:#111827;border-radius:16px;box-shadow:0 12px 40px rgba(0,0,0,.28);display:none;flex-direction:column;overflow:hidden;z-index:calc(var(--ca-z) + 1);border:1px solid #e5e7eb}",
    ".panel.open{display:flex}",
    ".head{display:flex;align-items:center;gap:8px;padding:14px 16px;background:var(--accent);color:var(--accent-fg)}",
    ".head h2{flex:1;margin:0;font-size:15px;font-weight:600;line-height:1.3;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
    ".close{background:transparent;border:0;color:inherit;cursor:pointer;padding:4px;border-radius:6px;display:grid;place-items:center}",
    ".close svg{width:20px;height:20px}",
    ".newb[hidden]{display:none}",
    ".log{flex:1;overflow-y:auto;overscroll-behavior:contain;padding:14px;display:flex;flex-direction:column;gap:10px;background:#f9fafb}",
    ".msg{max-width:88%;padding:9px 12px;border-radius:14px;font-size:14px;line-height:1.45;word-wrap:break-word;overflow-wrap:anywhere}",
    ".msg p{margin:0}.msg p+p,.msg ul+p,.msg p+ul{margin-top:6px}",
    ".msg ul{margin:0;padding-left:18px}",
    ".msg a{color:inherit;text-decoration:underline}",
    ".user{align-self:flex-end;background:var(--accent);color:var(--accent-fg);border-bottom-right-radius:4px}",
    ".model{align-self:flex-start;background:#fff;border:1px solid #e5e7eb;border-bottom-left-radius:4px}",
    ".model a{color:var(--accent)}",
    ".srcs{align-self:flex-start;max-width:88%;font-size:12px;color:#6b7280;margin-top:-4px;display:flex;flex-wrap:wrap;gap:4px 8px}",
    ".srcs a{color:var(--accent);text-decoration:underline}",
    ".cbtn{align-self:flex-start;border:1px solid var(--accent);background:#fff;color:var(--accent);border-radius:999px;padding:6px 12px;font-size:13px;font-weight:600;cursor:pointer}",
    ".cform{align-self:stretch;display:flex;flex-direction:column;align-items:stretch;gap:6px;background:#fff;border:1px solid #e5e7eb;border-radius:12px;padding:10px}",
    ".cform input{border:1px solid #d1d5db;border-radius:8px;padding:8px 10px;font-size:14px;color:#111827;background:#fff}",
    ".cform .hp{position:absolute;left:-9999px;width:1px;height:1px;opacity:0}",
    ".cform .row{display:flex;gap:8px}",
    ".cform .row button{flex:1;border-radius:8px;padding:8px;font-size:13px;font-weight:600;cursor:pointer;border:1px solid #d1d5db;background:#fff;color:#374151}",
    ".cform .row button.go{background:var(--accent);color:var(--accent-fg);border-color:var(--accent)}",
    ".cform .row button:disabled{opacity:.5;cursor:default}",
    ".cform .err{font-size:12px;color:#991b1b}",
    ".error{align-self:center;background:#fef2f2;color:#991b1b;border:1px solid #fecaca;font-size:13px}",
    ".cards{align-self:stretch;display:flex;flex-direction:column;gap:8px}",
    ".card{display:flex;gap:10px;background:#fff;border:1px solid #e5e7eb;border-radius:12px;padding:8px;text-decoration:none;color:inherit}",
    "a.card:hover{border-color:var(--accent)}",
    ".card img{width:68px;height:68px;object-fit:cover;border-radius:8px;flex:none;background:#f3f4f6}",
    ".card .t{font-size:14px;font-weight:600;line-height:1.3}",
    ".card .p{font-size:14px;color:var(--accent);font-weight:600;margin-top:2px}",
    ".card .m{font-size:12px;color:#6b7280;margin-top:2px}",
    ".card .go{font-size:12px;color:var(--accent);margin-top:4px}",
    ".typing{align-self:flex-start;display:flex;gap:4px;padding:12px 14px;background:#fff;border:1px solid #e5e7eb;border-radius:14px;border-bottom-left-radius:4px}",
    ".typing i{width:6px;height:6px;border-radius:50%;background:#9ca3af;animation:b 1s infinite ease-in-out}",
    ".typing i:nth-child(2){animation-delay:.15s}.typing i:nth-child(3){animation-delay:.3s}",
    "@keyframes b{0%,80%,100%{opacity:.3;transform:translateY(0)}40%{opacity:1;transform:translateY(-3px)}}",
    "@media (prefers-reduced-motion:reduce){.typing i{animation:none;opacity:.7}.launcher{transition:none}.hint{animation:none}}",
    "form{display:flex;gap:8px;padding:10px;border-top:1px solid #e5e7eb;background:#fff;align-items:flex-end}",
    "textarea{flex:1;resize:none;border:1px solid #d1d5db;border-radius:10px;padding:9px 10px;font-size:14px;line-height:1.35;max-height:96px;color:#111827;background:#fff}",
    ".send{border:0;border-radius:10px;background:var(--accent);color:var(--accent-fg);padding:0 14px;height:38px;font-size:14px;font-weight:600;cursor:pointer}",
    ".send:disabled{opacity:.5;cursor:default}",
    // Cari pillənin məsafələri --cx/--cy-yə yazılır (lg defolt, sonra md, sonra sm). Sm-də çat tam ekrandır.
    ".launcher,.panel,.hint{--cx:var(--ca-side);--cy:var(--ca-bottom)}",
    "@media " + MQ_MD + "{.launcher,.panel,.hint{--cx:var(--ca-side-md);--cy:var(--ca-bottom-md)}}",
    "@media " + MQ_SM + "{.launcher,.panel,.hint{--cx:var(--ca-side-m,var(--ca-side-sm));--cy:var(--ca-bottom-m,var(--ca-bottom-sm))}.panel{inset:0;width:100%;max-width:none;height:100%;max-height:none;border-radius:0;border:0}}",
  ].join("");

  var ICON_CHAT = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>';
  var ICON_NEW = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 12a9 9 0 1 0 3-6.7"/><path d="M3 4v5h5"/></svg>';
  var ICON_X = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M18 6 6 18M6 6l12 12"/></svg>';

  function boot(cfg) {
    var host = el("div");
    host.setAttribute("data-car-advisor", "");
    var root = host.attachShadow({ mode: "open" });
    var accent = /^#[0-9a-fA-F]{6}$/.test(cfg.color) ? cfg.color : "#ea580c";
    // Bunlar defolt dəyərlərdir: saytın CSS-i host elementinə eyni adlı --ca-* yazsa, o üstün gəlir.
    // (Köhnə --ca-side-m / --ca-bottom-m adları sm pilləsi üçün hələ də işləyir.)
    var val = function (n, inherit) { return n === null ? "var(" + inherit + ")" : n + "px"; };
    var vars = "--accent:" + accent + ";--accent-fg:" + textColorFor(accent) + ";--ca-z:2147483000"
      + ";--ca-side:" + sideLg + "px;--ca-bottom:" + bottomLg + "px"
      + ";--ca-side-md:" + val(sideMd, "--ca-side") + ";--ca-bottom-md:" + val(bottomMd, "--ca-bottom")
      + ";--ca-side-sm:" + val(sideSm, "--ca-side-md") + ";--ca-bottom-sm:" + val(bottomSm, "--ca-bottom-md");
    root.appendChild(el("style", { text: ":host{" + vars + "}" + CSS }));

    var log = el("div", { class: "log", role: "log", "aria-live": "polite", "aria-label": "Söhbət" });
    var input = el("textarea", { rows: "1", maxlength: "500", placeholder: "Mesajınızı yazın…", "aria-label": "Mesaj" });
    var sendBtn = el("button", { class: "send", type: "submit", text: "Göndər" });
    var closeBtn = el("button", { class: "close", type: "button", "aria-label": "Söhbəti bağla" });
    closeBtn.innerHTML = ICON_X; // sabit, yoxlanmış SVG
    var newBtn = el("button", { class: "close newb", type: "button", "aria-label": L.fresh, title: L.fresh });
    newBtn.innerHTML = ICON_NEW; // sabit, yoxlanmış SVG
    var form = el("form", null, [input, sendBtn]);
    var panel = el("div", { class: "panel", role: "dialog", "aria-label": cfg.title || "Çat" }, [
      el("div", { class: "head" }, [el("h2", { text: cfg.title || "Çat" }), newBtn, closeBtn]), log, form,
    ]);
    var launcher = el("button", { class: "launcher", type: "button", "aria-label": "Çatı aç", "aria-expanded": "false" });
    launcher.innerHTML = ICON_CHAT;
    root.appendChild(panel);
    root.appendChild(launcher);
    // Yazı mətni textContent ilə yazılır (HTML kimi şərh olunmur). Ekran oxuyucular üçün gizlədilir: loqonun öz adı var.
    var label = typeof cfg.label === "string" ? cfg.label.trim().slice(0, 40) : "";
    var hint = null;
    if (label) {
      hint = el("button", { class: "hint", type: "button", tabindex: "-1", "aria-hidden": "true", text: label });
      root.appendChild(hint);
    }

    function scroll() { log.scrollTop = log.scrollHeight; }
    function bubble(role, text) {
      var b = el("div", { class: "msg " + role });
      if (role === "model") renderText(b, text); else b.textContent = text;
      log.appendChild(b);
    }
    function cards(listings) {
      var list = (listings || []).filter(function (l) { return l && l.title; }).slice(0, 10);
      if (!list.length) return;
      var wrap = el("div", { class: "cards" });
      list.forEach(function (l) {
        var info = [el("div", { class: "t", text: l.title })];
        if (typeof l.price === "number") info.push(el("div", { class: "p", text: fmt(l.price) + " " + (l.currency || "") }));
        var meta = [];
        if (l.year) meta.push(String(l.year));
        if (typeof l.mileage === "number") meta.push(fmt(l.mileage) + " km");
        if (meta.length) info.push(el("div", { class: "m", text: meta.join(" · ") }));
        if (isUrl(l.url)) info.push(el("div", { class: "go", text: "Elana bax →" }));
        var kids = [];
        if (isUrl(l.image)) {
          var img = el("img", { src: l.image, alt: "", loading: "lazy", referrerpolicy: "no-referrer" });
          img.addEventListener("error", function () { img.remove(); });
          kids.push(img);
        }
        kids.push(el("div", null, info));
        wrap.appendChild(isUrl(l.url) ? el("a", { class: "card", href: l.url, target: "_blank", rel: "noopener noreferrer" }, kids) : el("div", { class: "card" }, kids));
      });
      log.appendChild(wrap);
    }
    function sources(list) {
      var items = (list || []).filter(function (s) { return s && s.title; }).slice(0, 3);
      if (!items.length) return;
      var wrap = el("div", { class: "srcs" }, [el("span", { text: L.src })]);
      items.forEach(function (s) {
        wrap.appendChild(isUrl(s.url) ? el("a", { href: s.url, target: "_blank", rel: "noopener noreferrer", text: s.title }) : el("span", { text: s.title }));
      });
      log.appendChild(wrap);
    }
    // Cavab tapılmayanda: "Operatorla əlaqə" düyməsi -> kiçik forma (gizli bal tələsi sahəsi ilə)
    function contactBox(question) {
      if (!cfg.contact) return;
      var btn = el("button", { class: "cbtn", type: "button", text: L.contact });
      log.appendChild(btn);
      btn.addEventListener("click", function () {
        var nameI = el("input", { type: "text", maxlength: "80", placeholder: L.name, "aria-label": L.name, autocomplete: "name" });
        var contI = el("input", { type: "text", maxlength: "120", placeholder: L.cont, "aria-label": L.cont, autocomplete: "email" });
        var hp = el("input", { type: "text", class: "hp", tabindex: "-1", autocomplete: "off", "aria-hidden": "true", name: "website" });
        var err = el("div", { class: "err" });
        var go = el("button", { class: "go", type: "submit", text: L.send });
        var cancel = el("button", { type: "button", text: L.cancel });
        var f = el("form", { class: "cform" }, [nameI, contI, hp, err, el("div", { class: "row" }, [cancel, go])]);
        btn.replaceWith(f);
        scroll(); contI.focus();
        cancel.addEventListener("click", function () { f.replaceWith(btn); });
        f.addEventListener("submit", function (ev) {
          ev.preventDefault(); ev.stopPropagation();
          err.textContent = ""; go.disabled = true;
          fetch(api + "/contact", {
            method: "POST", headers: { "content-type": "application/json" },
            body: JSON.stringify({ name: nameI.value, contact: contI.value, question: question, chat: state.messages.slice(-8).map(function (m) { return { role: m.role, text: String(m.text || "").slice(0, 600) }; }), website: hp.value }),
          }).then(function (res) { return res.json().catch(function () { return {}; }).then(function (d) { return { ok: res.ok, status: res.status, data: d }; }); })
            .then(function (r) {
              if (r.ok) { f.remove(); bubble("model", L.ok); scroll(); return; }
              err.textContent = r.status === 400 ? L.bad : L.fail; go.disabled = false;
            }).catch(function () { err.textContent = L.fail; go.disabled = false; });
        });
      });
    }
    function extras(m, question) {
      cards(m.listings); sources(m.sources);
      if (m.unanswered) contactBox(question);
    }
    function render() {
      newBtn.hidden = state.messages.length === 0;
      log.textContent = "";
      bubble("model", cfg.greeting || "");
      var q = "";
      state.messages.forEach(function (m) { bubble(m.role, m.text); if (m.role === "user") q = m.text; else extras(m, q); });
      scroll();
    }

    // Telefon pilləsində (sm, panel tam ekran olanda) arxadakı səhifə scroll olunmasın.
    // iOS Safari-də yalnız overflow:hidden kifayət etmir, ona görə body sabitlənir və scroll mövqeyi saxlanıb bərpa olunur.
    var mobile = window.matchMedia(MQ_SM);
    var lock = null;
    function lockScroll() {
      if (lock) return;
      var b = document.body, h = document.documentElement;
      var y = window.pageYOffset || h.scrollTop || 0;
      lock = { y: y, body: b.getAttribute("style"), html: h.getAttribute("style") };
      b.style.position = "fixed"; b.style.top = -y + "px"; b.style.left = "0"; b.style.right = "0"; b.style.overflow = "hidden";
      h.style.overscrollBehavior = "none";
    }
    function unlockScroll() {
      if (!lock) return;
      var b = document.body, h = document.documentElement, y = lock.y;
      if (lock.body === null) b.removeAttribute("style"); else b.setAttribute("style", lock.body);
      h.style.scrollBehavior = "auto"; // saytda smooth scroll varsa mövqe animasiyasız bərpa olunsun
      window.scrollTo(0, y);
      if (lock.html === null) h.removeAttribute("style"); else h.setAttribute("style", lock.html);
      lock = null;
    }
    function layout() {
      var full = state.open && mobile.matches;
      launcher.style.display = full ? "none" : "";
      if (hint) hint.style.display = state.open ? "none" : "";
      if (full) lockScroll(); else unlockScroll();
    }
    if (mobile.addEventListener) mobile.addEventListener("change", layout); else if (mobile.addListener) mobile.addListener(layout);

    function setOpen(v) {
      state.open = !!v;
      panel.classList.toggle("open", state.open);
      launcher.setAttribute("aria-expanded", String(state.open));
      launcher.setAttribute("aria-label", state.open ? "Çatı bağla" : "Çatı aç");
      layout();
      save();
      if (state.open) { scroll(); setTimeout(function () { input.focus(); }, 0); }
    }
    launcher.addEventListener("click", function () { setOpen(!state.open); });
    if (hint) hint.addEventListener("click", function () { setOpen(true); });
    closeBtn.addEventListener("click", function () { setOpen(false); launcher.focus(); });
    // Yeni söhbət: yalnız ziyarətçinin brauzerindəki söhbət silinir (sayt sahibinin panelindəki qeydlərə toxunmur)
    newBtn.addEventListener("click", function () {
      gen++; if (curCtrl) { try { curCtrl.abort(); } catch (e) { /* artıq bitib */ } }
      busy = false; sendBtn.disabled = false;
      state.messages = []; save();
      input.value = ""; grow();
      render(); input.focus();
    });
    root.addEventListener("keydown", function (e) { if (e.key === "Escape" && state.open) { setOpen(false); launcher.focus(); } });

    var busy = false, gen = 0, curCtrl = null;
    function grow() { input.style.height = "auto"; input.style.height = Math.min(input.scrollHeight, 96) + "px"; }
    input.addEventListener("input", grow);
    input.addEventListener("keydown", function (e) {
      if (e.key === "Enter" && !e.shiftKey && !e.isComposing) { e.preventDefault(); form.requestSubmit(); }
    });

    form.addEventListener("submit", function (e) {
      e.preventDefault();
      var text = input.value.trim();
      if (!text || busy) return;
      var history = state.messages.slice(-10).map(function (m) { return { role: m.role, text: m.text }; });
      state.messages.push({ role: "user", text: text });
      newBtn.hidden = false;
      save();
      bubble("user", text);
      input.value = ""; grow();
      busy = true; sendBtn.disabled = true;
      var typing = el("div", { class: "typing", "aria-label": "Cavab yazılır" }, [el("i"), el("i"), el("i")]);
      log.appendChild(typing); scroll();

      var ctrl = new AbortController(), myGen = gen;
      curCtrl = ctrl;
      var timer = setTimeout(function () { ctrl.abort(); }, 60000);
      fetch(api + "/chat", {
        method: "POST", headers: { "content-type": "application/json" }, signal: ctrl.signal,
        body: JSON.stringify({ message: text, history: history, vid: visitorId() }),
      }).then(function (res) {
        return res.json().catch(function () { return {}; }).then(function (data) { return { ok: res.ok, data: data }; });
      }).then(function (r) {
        typing.remove();
        if (myGen !== gen) return; // arada "Yeni söhbət" basılıb
        if (!r.ok) {
          // Çat dayanıb (məs. balans bitib): xəta əvəzinə əlaqə formasını göstər, ziyarətçinin müraciəti itməsin
          if (r.data.code === "OFFLINE") { bubble("error", L.offline); contactBox(text); scroll(); return; }
          // Ziyarətçi/sayt limiti dolub: ziyarətçi itməsin, əlaqə forması təklif olunur
          if (r.data.code === "VISITOR_LIMIT" || r.data.code === "BUSY") { bubble("error", r.data.code === "BUSY" ? L.busy : L.limit); contactBox(text); scroll(); return; }
          return bubble("error", r.data.error || "Xəta baş verdi, bir azdan yenidən cəhd et");
        }
        var answer = String(r.data.answer || "");
        var msg = { role: "model", text: answer, listings: r.data.listings || [], sources: r.data.sources || [], unanswered: r.data.unanswered === true };
        state.messages.push(msg);
        save();
        bubble("model", answer); extras(msg, text);
      }).catch(function () {
        typing.remove();
        if (myGen !== gen) return;
        bubble("error", "Bağlantı xətası. İnternetini yoxla və yenidən cəhd et.");
      }).then(function () {
        clearTimeout(timer);
        if (myGen !== gen) return;
        busy = false; sendBtn.disabled = false; scroll();
        if (state.open) input.focus();
      });
    });

    render();
    document.body.appendChild(host);
    setOpen(state.open);

    // Səhifə şərti: data-show-on / data-hide-on. SPA keçidləri (pushState/replaceState/popstate) izlənir.
    var parseList = function (attr) {
      var raw = script.getAttribute(attr);
      return raw ? raw.split(",").map(function (x) { return x.trim(); }).filter(Boolean) : null;
    };
    var showOn = parseList("data-show-on"), hideOn = parseList("data-hide-on");
    var normPath = function (p) { p = (p || "/").split("?")[0].split("#")[0]; return p.length > 1 ? p.replace(/\/+$/, "") : "/"; };
    var pathMatches = function (list, path) {
      return list.some(function (pat) {
        if (pat === "*") return true;
        if (pat.slice(-2) === "/*") { var b = normPath(pat.slice(0, -2)); return path === b || path.indexOf(b === "/" ? "/" : b + "/") === 0; }
        return normPath(pat) === path;
      });
    };
    var shown = true;
    function applyRoute() {
      var path = normPath(location.pathname);
      var ok = (!showOn || pathMatches(showOn, path)) && !(hideOn && pathMatches(hideOn, path));
      if (ok === shown) return;
      shown = ok;
      host.style.display = ok ? "" : "none";
      if (!ok && state.open) setOpen(false); // açıq çat gizlənəndə mobil scroll kilidi də açılsın
    }
    var onRoute = function () { setTimeout(applyRoute, 0); };
    var restore = [];
    if (showOn || hideOn) {
      ["pushState", "replaceState"].forEach(function (fn) {
        var orig = history[fn];
        if (typeof orig !== "function") return;
        history[fn] = function () { var r = orig.apply(this, arguments); onRoute(); return r; };
        restore.push(function () { if (history[fn] !== orig) history[fn] = orig; });
      });
      window.addEventListener("popstate", onRoute);
      window.addEventListener("hashchange", onRoute);
      applyRoute();
    }

    window.CarAdvisor = {
      open: function () { setOpen(true); },
      close: function () { setOpen(false); },
      toggle: function () { setOpen(!state.open); },
      // Vidjeti tam silir (məs. React komponentinin useEffect təmizləməsində). Skript yenidən yüklənsə yenidən qurulur.
      destroy: function () {
        if (state.open) setOpen(false);
        window.removeEventListener("popstate", onRoute); window.removeEventListener("hashchange", onRoute);
        restore.forEach(function (f) { f(); });
        host.remove(); delete window.CarAdvisor; window.__carAdvisorWidget = false;
      },
    };
  }

  function start() {
    // Vidjet söndürülübsə və ya bu sayta icazə verilməyibsə (404/403) heç nə göstərilmir.
    fetch(api + "/config").then(function (res) {
      if (!res.ok) throw new Error("status " + res.status);
      return res.json();
    }).then(boot).catch(function (e) { console.warn("[car-advisor] vidjet yüklənmədi:", e.message); });
  }
  if (document.body) start(); else document.addEventListener("DOMContentLoaded", start);
})();
