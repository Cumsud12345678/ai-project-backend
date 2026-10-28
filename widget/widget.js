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
 * Hesaba daxil olmuş istifadəçi (sifariş/ödəniş üçün): saytın SERVERİ imzalı qısaömürlü token yaradır, səhifə onu verir:
 *   window.CarAdvisor.identify(token)   // daxil olanda və hər yenilənəndə; çıxanda identify(null)
 *   window.addEventListener("caradvisor:identity-expired", function () { ... yeni token al və identify(...) çağır ... });
 * Token yalnız yaddaşda saxlanır (storage-ə yazılmır). İstifadəçi dəyişəndə/çıxanda söhbət təmizlənir.
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

  // Şəxsi məlumat üçün kimlik tokeni: vidjet qurulmamışdan əvvəl də identify() çağırıla bilər
  var idToken = null, idWho = null, idHook = null, idCalled = false;
  function whoOf(t) {
    try { var p = String(t).split("."); if (p.length !== 3 || p[0] !== "v1") return ""; var j = JSON.parse(atob(p[1].replace(/-/g, "+").replace(/_/g, "/"))); return typeof j.sub === "string" ? j.sub.slice(0, 100) : ""; }
    catch (e) { return ""; }
  }
  window.CarAdvisor = window.CarAdvisor || {};
  window.CarAdvisor.identify = function (t) {
    idCalled = true;
    idToken = typeof t === "string" && t.length > 20 && t.length <= 1000 ? t : null;
    idWho = idToken ? whoOf(idToken) : "";
    if (!idWho) idToken = null;
    if (idHook) idHook();
  };

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
  // Canlı söhbət 7 gün brauzerdə yadda qalır: ziyarətçi tabı bağlayıb qayıdanda operatorun cavabını görür.
  var LIVE_KEY = STORE + "_live", LIVE_TTL = 7 * 24 * 3600 * 1000;
  function liveStored() {
    try {
      var v = JSON.parse(localStorage.getItem(LIVE_KEY) || "null");
      if (v && v.id && v.token && Date.now() - v.t < LIVE_TTL) return v;
      localStorage.removeItem(LIVE_KEY);
    } catch (e) { /* yaddaş bağlıdır */ }
    return null;
  }
  function load() {
    try {
      var v = JSON.parse(sessionStorage.getItem(STORE) || "{}");
      var live = v.live && typeof v.live === "object" ? v.live : null;
      if (!live) { var s = liveStored(); if (s) live = { id: s.id, token: s.token, after: 0, pending: false, t: s.t, seen: s.seen || 0 }; } // yeni tab: tarixçə serverdən yenidən yüklənir
      return { messages: Array.isArray(v.messages) ? v.messages : [], open: !!v.open, live: live, sid: typeof v.sid === "string" && /^[a-f0-9]{16,32}$/.test(v.sid) ? v.sid : "", who: typeof v.who === "string" ? v.who : "" };
    }
    catch (e) { return { messages: [], open: false, live: null, sid: "", who: "" }; }
  }
  function save() {
    try { sessionStorage.setItem(STORE, JSON.stringify({ messages: state.messages.slice(-MAX_STORED), open: state.open, live: state.live, sid: state.sid, who: state.who })); } catch (e) { /* məxfi rejim */ }
    try {
      if (state.live && state.live.id) localStorage.setItem(LIVE_KEY, JSON.stringify({ id: state.live.id, token: state.live.token, t: state.live.t || Date.now(), seen: state.live.seen || 0 }));
      else localStorage.removeItem(LIVE_KEY);
    } catch (e) { /* yaddaş bağlıdır */ }
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
      az: { poweredBy: "Hazırlayan:", src: "Mənbə:", offline: "Çat hazırda cavab vermir. İstəsəniz əlaqə qoyun, sizinlə əlaqə saxlayaq.", contact: "Operatorla əlaqə", name: "Adınız (ixtiyari)", cont: "Telefon və ya e-poçt", send: "Göndər", ok: "Təşəkkürlər! Müraciətiniz qəbul edildi, tezliklə sizinlə əlaqə saxlayacağıq.", bad: "Düzgün telefon nömrəsi və ya e-poçt yazın", fail: "Göndərilə bilmədi, bir azdan yenidən cəhd edin", cancel: "Ləğv et", fresh: "Yeni söhbət", toDark: "Gecə rejimi", toLight: "Gündüz rejimi", photoAdd: "Şəkil əlavə et", photoDel: "Şəkli sil", photoBad: "Şəkil oxuna bilmədi. PNG, JPG və ya WebP seçin.", photoSent: "Şəkil göndərildi", live: "Operatorla canlı yaz", liveStart: "Operatora qoşuldunuz. Mesajınızı yazın, cavab gələndə burada görəcəksiniz.", opTyping: "Operator yazır…", liveMailPh: "E-poçt (ixtiyari)", liveMailHint: "Çatdan çıxsanız, operatorun cavabını e-poçtla göndərək.", liveBack: "AI-a qayıt", liveWait: "Operator hələ cavab verməyib. İstəsəniz əlaqə qoyun, sizinlə əlaqə saxlayaq.", liveEnd: "Operator söhbəti bitirdi. Yeni sual yazsanız, yenidən AI cavab verəcək.", liveFail: "Mesaj göndərilmədi, yenidən cəhd edin", livePh: "Operatora mesaj yazın…", op: "Operator", up: "Cavab faydalı idi", down: "Cavab faydalı deyildi", thanks: "Təşəkkürlər!", limit: "Bu gün üçün sual limitinə çatdınız. İstəsəniz əlaqə qoyun, sizinlə əlaqə saxlayaq.", busy: "Çat hazırda çox yüklüdür. İstəsəniz əlaqə qoyun, sizinlə əlaqə saxlayaq." },
      en: { poweredBy: "Powered by", src: "Source:", offline: "The chat can't answer right now. Leave your contact and we'll get back to you.", contact: "Contact an operator", name: "Your name (optional)", cont: "Phone or email", send: "Send", ok: "Thank you! Your request was received, we'll contact you soon.", bad: "Enter a valid phone number or email", fail: "Could not send, please try again shortly", cancel: "Cancel", fresh: "New chat", toDark: "Night mode", toLight: "Day mode", photoAdd: "Attach a photo", photoDel: "Remove photo", photoBad: "Couldn't read the image. Choose PNG, JPG or WebP.", photoSent: "Photo sent", live: "Chat with an operator", liveStart: "You are connected to an operator. Type your message, replies will appear here.", opTyping: "Operator is typing…", liveMailPh: "Email (optional)", liveMailHint: "If you leave the chat, we will email you the operator's reply.", liveBack: "Back to AI", liveWait: "The operator has not replied yet. Leave your contact and we'll get back to you.", liveEnd: "The operator ended the chat. Write a new question and the AI will answer again.", liveFail: "Message not sent, please try again", livePh: "Message the operator…", op: "Operator", up: "Helpful answer", down: "Not helpful", thanks: "Thanks!", limit: "You have reached today's question limit. Leave your contact and we'll get back to you.", busy: "The chat is very busy right now. Leave your contact and we'll get back to you." },
      ru: { poweredBy: "Работает на", src: "Источник:", offline: "Чат сейчас не может ответить. Оставьте контакт, и мы свяжемся с вами.", contact: "Связаться с оператором", name: "Ваше имя (необязательно)", cont: "Телефон или e-mail", send: "Отправить", ok: "Спасибо! Ваше обращение принято, мы скоро свяжемся с вами.", bad: "Введите корректный телефон или e-mail", fail: "Не удалось отправить, попробуйте позже", cancel: "Отмена", fresh: "Новый чат", toDark: "Ночной режим", toLight: "Дневной режим", photoAdd: "Прикрепить фото", photoDel: "Убрать фото", photoBad: "Не удалось прочитать изображение. Выберите PNG, JPG или WebP.", photoSent: "Фото отправлено", live: "Написать оператору", liveStart: "Вы подключены к оператору. Напишите сообщение, ответ появится здесь.", opTyping: "Оператор печатает…", liveMailPh: "E-mail (необязательно)", liveMailHint: "Если вы выйдете из чата, мы отправим ответ оператора на e-mail.", liveBack: "Назад к ИИ", liveWait: "Оператор пока не ответил. Оставьте контакт, и мы свяжемся с вами.", liveEnd: "Оператор завершил чат. Напишите новый вопрос, и снова ответит ИИ.", liveFail: "Сообщение не отправлено, попробуйте ещё раз", livePh: "Сообщение оператору…", op: "Оператор", up: "Ответ полезен", down: "Ответ не полезен", thanks: "Спасибо!", limit: "Вы достигли лимита вопросов на сегодня. Оставьте контакт, и мы свяжемся с вами.", busy: "Чат сейчас сильно загружен. Оставьте контакт, и мы свяжемся с вами." },
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
  function newId() {
    var a = "";
    try { var arr = new Uint8Array(12); crypto.getRandomValues(arr); for (var i = 0; i < arr.length; i++) a += ("0" + arr[i].toString(16)).slice(-2); }
    catch (e) { for (var j = 0; j < 24; j++) a += Math.floor(Math.random() * 16).toString(16); }
    return a;
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
    ".hint{position:fixed;bottom:calc(var(--cy) + 6px);height:44px;" + position + ":calc(var(--cx) + 66px);max-width:calc(100vw - var(--cx) - 78px);display:flex;align-items:center;padding:0 16px;border:0;border-radius:22px;background:var(--bg);color:var(--fg);font-size:14px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;cursor:pointer;box-shadow:0 6px 20px rgba(0,0,0,.2);z-index:var(--ca-z);animation:hintIn .35s ease both}",
    "@keyframes hintIn{from{opacity:0;transform:translateX(" + (position === "left" ? "-" : "") + "8px)}to{opacity:1;transform:none}}",
    ".launcher:focus-visible,button:focus-visible,textarea:focus-visible,a:focus-visible{outline:2px solid var(--accent);outline-offset:2px}",
    ".launcher svg{width:26px;height:26px}",
    ".launcher.logo{padding:0;overflow:hidden;background:var(--bg)}.launcher.logo img{width:100%;height:100%;object-fit:cover;display:block}",
    ".logo-h{width:28px;height:28px;border-radius:50%;object-fit:cover;background:var(--bg);flex:none}",
    ".panel{position:fixed;bottom:calc(var(--cy) + 68px);" + position + ":var(--cx);width:380px;max-width:calc(100vw - 24px);height:560px;max-height:max(240px,calc(100vh - var(--cy) - 88px));background:var(--bg);color:var(--fg);border-radius:16px;box-shadow:0 12px 40px rgba(0,0,0,.28);display:none;flex-direction:column;overflow:hidden;z-index:calc(var(--ca-z) + 1);border:1px solid var(--border)}",
    ".panel.open{display:flex}",
    ".head{display:flex;align-items:center;gap:8px;padding:14px 16px;background:var(--accent);color:var(--accent-fg)}",
    ".head h2{flex:1;margin:0;font-size:15px;font-weight:600;line-height:1.3;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
    ".close{background:transparent;border:0;color:inherit;cursor:pointer;padding:4px;border-radius:6px;display:grid;place-items:center}",
    ".close svg{width:20px;height:20px}",
    ".newb[hidden]{display:none}",
    ".log{flex:1;overflow-y:auto;overscroll-behavior:contain;padding:14px;display:flex;flex-direction:column;gap:10px;background:var(--bg2)}",
    ".msg{max-width:88%;padding:9px 12px;border-radius:14px;font-size:14px;line-height:1.45;word-wrap:break-word;overflow-wrap:anywhere}",
    ".msg p{margin:0}.msg p+p,.msg ul+p,.msg p+ul{margin-top:6px}",
    ".msg ul{margin:0;padding-left:18px}",
    ".msg a{color:inherit;text-decoration:underline}",
    ".user{align-self:flex-end;background:var(--accent);color:var(--accent-fg);border-bottom-right-radius:4px}",
    ".model{align-self:flex-start;background:var(--bg);border:1px solid var(--border);border-bottom-left-radius:4px}",
    ".model a{color:var(--accent-t)}",
    ".srcs{align-self:flex-start;max-width:88%;font-size:12px;color:var(--muted);margin-top:-4px;display:flex;flex-wrap:wrap;gap:4px 8px}",
    ".srcs a{color:var(--accent-t);text-decoration:underline}",
    ".cbtn{align-self:flex-start;border:1px solid var(--accent-t);background:var(--bg);color:var(--accent-t);border-radius:999px;padding:6px 12px;font-size:13px;font-weight:600;cursor:pointer}",
    ".cform{align-self:stretch;display:flex;flex-direction:column;align-items:stretch;gap:6px;background:var(--bg);border:1px solid var(--border);border-radius:12px;padding:10px}",
    ".cform input{border:1px solid var(--border2);border-radius:8px;padding:8px 10px;font-size:14px;color:var(--fg);background:var(--bg)}",
    ".cform .hp{position:absolute;left:-9999px;width:1px;height:1px;opacity:0}",
    ".cform .row{display:flex;gap:8px}",
    ".cform .row button{flex:1;border-radius:8px;padding:8px;font-size:13px;font-weight:600;cursor:pointer;border:1px solid var(--border2);background:var(--bg);color:var(--fg)}",
    ".cform .row button.go{background:var(--accent);color:var(--accent-fg);border-color:var(--accent)}",
    ".cform .row button:disabled{opacity:.5;cursor:default}",
    ".cform .err{font-size:12px;color:var(--errfg)}",
    ".brand{flex:none;text-align:center;font-size:11px;padding:4px 8px 6px;color:var(--muted);border-top:1px solid var(--border)}.brand a{color:inherit;text-decoration:underline}",
    ".mailrow{align-self:stretch;display:flex;flex-direction:column;gap:4px}",
    ".mailrow input{border:1px solid var(--border2);border-radius:8px;padding:8px 10px;font-size:14px;color:var(--fg);background:var(--bg)}",
    ".mailrow .hint2{font-size:12px;color:var(--muted)}",
    ".operator{align-self:flex-start;background:var(--opbg);border:1px solid var(--opbd);border-bottom-left-radius:4px}",
    ".who{font-size:11px;font-weight:700;color:var(--opfg);margin-bottom:2px}",
    ".note{align-self:center;max-width:92%;text-align:center;font-size:12px;color:var(--muted);display:flex;flex-direction:column;align-items:center;gap:6px}",
    ".note.typing span{font-style:italic}",
    ".note button{border:1px solid var(--border2);background:var(--bg);color:var(--fg);border-radius:999px;padding:4px 10px;font-size:12px;cursor:pointer}",
    ".fb{align-self:flex-start;display:flex;align-items:center;gap:2px;margin-top:-6px}",
    ".fbb{border:0;background:transparent;color:var(--muted);cursor:pointer;padding:3px;border-radius:6px;display:grid;place-items:center}",
    ".fbb:hover:not(:disabled){color:var(--accent-t)}.fbb.on{color:var(--accent-t)}.fbb:disabled{cursor:default}",
    ".fbb svg{width:15px;height:15px}",
    ".fb span{font-size:11px;color:var(--muted);margin-left:4px}",
    ".livebtn[hidden]{display:none}",
    ".launcher.dot::after{content:\"\";position:absolute;top:2px;right:2px;width:14px;height:14px;border-radius:50%;background:#ef4444;border:2px solid #fff}",
    ".error{align-self:center;background:var(--errbg);color:var(--errfg);border:1px solid var(--errbd);font-size:13px}",
    ".cards{align-self:stretch;display:flex;flex-direction:column;gap:8px}",
    ".card{display:flex;gap:10px;background:var(--bg);border:1px solid var(--border);border-radius:12px;padding:8px;text-decoration:none;color:inherit}",
    "a.card:hover{border-color:var(--accent)}",
    ".card img{width:68px;height:68px;object-fit:cover;border-radius:8px;flex:none;background:var(--bg2)}",
    ".card .t{font-size:14px;font-weight:600;line-height:1.3}",
    ".card .p{font-size:14px;color:var(--accent-t);font-weight:600;margin-top:2px}",
    ".card .m{font-size:12px;color:var(--muted);margin-top:2px}",
    ".card .go{font-size:12px;color:var(--accent-t);margin-top:4px}",
    ".typing{align-self:flex-start;display:flex;gap:4px;padding:12px 14px;background:var(--bg);border:1px solid var(--border);border-radius:14px;border-bottom-left-radius:4px}",
    ".typing i{width:6px;height:6px;border-radius:50%;background:var(--muted);animation:b 1s infinite ease-in-out}",
    ".typing i:nth-child(2){animation-delay:.15s}.typing i:nth-child(3){animation-delay:.3s}",
    "@keyframes b{0%,80%,100%{opacity:.3;transform:translateY(0)}40%{opacity:1;transform:translateY(-3px)}}",
    "@media (prefers-reduced-motion:reduce){.typing i{animation:none;opacity:.7}.launcher{transition:none}.hint{animation:none}}",
    "form{display:flex;gap:8px;padding:10px;border-top:1px solid var(--border);background:var(--bg);align-items:flex-end}",
    "textarea{flex:1;resize:none;border:1px solid var(--border2);border-radius:10px;padding:9px 10px;font-size:14px;line-height:1.35;max-height:96px;color:var(--fg);background:var(--bg)}",
    ".attach{flex:none;width:38px;height:38px;border:1px solid var(--border2);border-radius:10px;background:var(--bg);color:var(--muted);display:grid;place-items:center;cursor:pointer;padding:0}",
    ".attach svg{width:18px;height:18px}.attach[hidden],.pv[hidden]{display:none}",
    ".pv{display:flex;align-items:center;gap:8px;padding:8px 10px 0;background:var(--bg)}",
    ".pv img{width:44px;height:44px;border-radius:8px;object-fit:cover;border:1px solid var(--border)}",
    ".pv button{border:0;background:transparent;color:var(--muted);cursor:pointer;font-size:12px;text-decoration:underline;padding:4px}",
    ".msg img.up{display:block;max-width:160px;max-height:160px;border-radius:8px;margin-bottom:6px}.msg .upl{display:block;font-size:12px;opacity:.8;margin-bottom:4px}",
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

  var ICON_USER = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/></svg>';
  var ICON_MOON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/></svg>';
  var ICON_SUN = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>';
  var ICON_IMG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="9" cy="10" r="1.6"/><path d="m21 16-5-5-8 8"/></svg>';
  var ICON_UP = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M7 10v11H3V10z"/><path d="M7 10l4-8a3 3 0 0 1 3 3v4h6a2 2 0 0 1 2 2.3l-1.3 8a2 2 0 0 1-2 1.7H7"/></svg>';
  var ICON_DOWN = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M17 14V3h4v11z"/><path d="M17 14l-4 8a3 3 0 0 1-3-3v-4H4a2 2 0 0 1-2-2.3l1.3-8A2 2 0 0 1 5.3 3H17"/></svg>';

  // Rəng mövzusu: bg + fg-dən qalan bütün rənglər (xətt, yumşaq fon, ikinci dərəcəli mətn) color-mix ilə çıxarılır.
  var PAL = {
    light: { bg: "#ffffff", fg: "#111827", opbg: "#eef2ff", opbd: "#c7d2fe", opfg: "#4338ca", errbg: "#fef2f2", errfg: "#991b1b", errbd: "#fecaca" },
    dark: { bg: "#1f2937", fg: "#f3f4f6", opbg: "#312e81", opbd: "#4338ca", opfg: "#c7d2fe", errbg: "#450a0a", errfg: "#fecaca", errbd: "#7f1d1d" },
  };
  function palVars(p) { return Object.keys(p).map(function (k) { return "--" + k + ":" + p[k]; }).join(";"); }
  var DERIVED = "--bg2:color-mix(in srgb,var(--bg),var(--fg) 4%);--border:color-mix(in srgb,var(--bg),var(--fg) 14%);--border2:color-mix(in srgb,var(--bg),var(--fg) 28%);--muted:color-mix(in srgb,var(--fg),var(--bg) 42%)";
  // Açıq/tünd mövzu host elementindəki data-ca-theme atributu ilə dəyişir (ziyarətçi düymə ilə seçir).
  function themeCss() {
    // --accent-t: rəngin MƏTN kimi işləndiyi yerlər (link, qiymət). Tünd fonda tünd rəng itməsin deyə açılır.
    return ":host{" + palVars(PAL.light) + ";" + DERIVED + ";--accent-t:var(--accent)}:host([data-ca-theme=dark]){" + palVars(PAL.dark) + ";--accent-t:color-mix(in srgb,var(--accent),#fff 42%)}";
  }

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
    root.appendChild(el("style", { text: ":host{" + vars + "}" + themeCss() + CSS }));

    var log = el("div", { class: "log", role: "log", "aria-live": "polite", "aria-label": "Söhbət" });
    var input = el("textarea", { rows: "1", maxlength: "500", placeholder: "Mesajınızı yazın…", "aria-label": "Mesaj" });
    var sendBtn = el("button", { class: "send", type: "submit", text: "Göndər" });
    var closeBtn = el("button", { class: "close", type: "button", "aria-label": "Söhbəti bağla" });
    closeBtn.innerHTML = ICON_X; // sabit, yoxlanmış SVG
    var newBtn = el("button", { class: "close newb", type: "button", "aria-label": L.fresh, title: L.fresh });
    newBtn.innerHTML = ICON_NEW; // sabit, yoxlanmış SVG
    var liveBtn = el("button", { class: "close livebtn", type: "button", "aria-label": L.live, title: L.live });
    liveBtn.innerHTML = ICON_USER; // sabit, yoxlanmış SVG
    liveBtn.hidden = !cfg.live || !!state.live;
    var themeBtn = el("button", { class: "close themeb", type: "button" });
    // Ziyarətçinin seçimi (düymə) yadda qalır; seçməyibsə panelde təyin olunan açılış rejimi: light / dark / auto (cihaz ayarı)
    var THEME_KEY = "ca_theme";
    var mq = window.matchMedia ? window.matchMedia("(prefers-color-scheme: dark)") : null;
    function chosenTheme() { try { var v = localStorage.getItem(THEME_KEY); return v === "dark" || v === "light" ? v : ""; } catch (e) { return ""; } }
    function effectiveTheme() { return chosenTheme() || (cfg.theme === "dark" ? "dark" : cfg.theme === "auto" && mq && mq.matches ? "dark" : "light"); }
    function applyTheme() {
      var th = effectiveTheme();
      host.setAttribute("data-ca-theme", th);
      if (th === "dark") themeBtn.innerHTML = ICON_SUN; else themeBtn.innerHTML = ICON_MOON; // sabit, yoxlanmış SVG
      var lbl = th === "dark" ? L.toLight : L.toDark;
      themeBtn.setAttribute("aria-label", lbl); themeBtn.title = lbl;
    }
    themeBtn.addEventListener("click", function () {
      try { localStorage.setItem(THEME_KEY, effectiveTheme() === "dark" ? "light" : "dark"); } catch (e) { /* yaddaş bağlıdır */ }
      applyTheme();
    });
    if (mq && mq.addEventListener) mq.addEventListener("change", applyTheme);
    // Şəkilli sual (sayt sahibi panelden açıbsa): şəkil brauzerdə kiçildilir, serverə base64 ilə gedir, heç yerdə saxlanmır
    var attachBtn = el("button", { class: "attach", type: "button", "aria-label": L.photoAdd, title: L.photoAdd });
    attachBtn.innerHTML = ICON_IMG; // sabit, yoxlanmış SVG
    attachBtn.hidden = cfg.imageSearch !== true;
    var fileIn = el("input", { type: "file", accept: "image/png,image/jpeg,image/webp", hidden: "", "aria-label": L.photoAdd });
    var pv = el("div", { class: "pv" }); pv.hidden = true;
    var pending = null; // { b64, url }
    function clearPending() { pending = null; pv.textContent = ""; pv.hidden = true; }
    function shrinkImage(file) {
      return createImageBitmap(file).then(function (bmp) {
        var k = Math.min(1, 1024 / Math.max(bmp.width, bmp.height));
        var c = document.createElement("canvas");
        c.width = Math.max(1, Math.round(bmp.width * k)); c.height = Math.max(1, Math.round(bmp.height * k));
        var g = c.getContext("2d"); g.fillStyle = "#fff"; g.fillRect(0, 0, c.width, c.height); g.drawImage(bmp, 0, 0, c.width, c.height);
        var q = 0.82, url = c.toDataURL("image/jpeg", q);
        while (url.length > 1500000 && q > 0.4) { q -= 0.1; url = c.toDataURL("image/jpeg", q); }
        if (url.length > 2000000) throw new Error("big");
        return { url: url, b64: url.slice(url.indexOf(",") + 1) };
      });
    }
    attachBtn.addEventListener("click", function () { if (!busy) fileIn.click(); });
    fileIn.addEventListener("change", function () {
      var f = fileIn.files && fileIn.files[0]; fileIn.value = "";
      if (!f) return;
      shrinkImage(f).then(function (r) {
        pending = r; pv.textContent = "";
        var thumb = el("img", { src: r.url, alt: "" });
        var del = el("button", { type: "button", text: L.photoDel });
        del.addEventListener("click", clearPending);
        pv.appendChild(thumb); pv.appendChild(del); pv.hidden = false;
      }).catch(function () { bubble("error", L.photoBad); scroll(); });
    });
    var form = el("form", null, [attachBtn, fileIn, input, sendBtn]);
    // Loqo yalnız bizim portaldan gələn https ünvandır; yüklənməsə sakitcə gizlənir (başlıqda) və ya standart ikonaya qayıdır (düymədə)
    var logoUrl = typeof cfg.logo === "string" && /^https?:\/\//i.test(cfg.logo) ? cfg.logo : "";
    var headLogo = logoUrl ? el("img", { class: "logo-h", src: logoUrl, alt: "", referrerpolicy: "no-referrer" }) : null;
    if (headLogo) headLogo.addEventListener("error", function () { headLogo.remove(); });
    var brandEl = null;
    if (cfg.brand && typeof cfg.brand.name === "string" && cfg.brand.name) {
      brandEl = el("div", { class: "brand" }, [el("span", { text: L.poweredBy + " " })]);
      brandEl.appendChild(isUrl(cfg.brand.url) ? el("a", { href: cfg.brand.url, target: "_blank", rel: "noopener noreferrer", text: cfg.brand.name }) : el("span", { text: cfg.brand.name }));
    }
    var panel = el("div", { class: "panel", role: "dialog", "aria-label": cfg.title || "Çat" }, [
      el("div", { class: "head" }, [].concat(logoUrl ? [headLogo] : [], [el("h2", { text: cfg.title || "Çat" }), liveBtn, themeBtn, newBtn, closeBtn])), log, pv, form,
    ].concat(brandEl ? [brandEl] : []));
    var launcher = el("button", { class: "launcher", type: "button", "aria-label": "Çatı aç", "aria-expanded": "false" });
    launcher.innerHTML = ICON_CHAT;
    if (logoUrl) {
      var lImg = el("img", { src: logoUrl, alt: "", referrerpolicy: "no-referrer" });
      lImg.addEventListener("load", function () { launcher.textContent = ""; launcher.classList.add("logo"); launcher.appendChild(lImg); });
    }
    root.appendChild(panel);
    root.appendChild(launcher);
    applyTheme();
    // Yazı mətni textContent ilə yazılır (HTML kimi şərh olunmur). Ekran oxuyucular üçün gizlədilir: loqonun öz adı var.
    var label = typeof cfg.label === "string" ? cfg.label.trim().slice(0, 40) : "";
    var hint = null;
    if (label) {
      hint = el("button", { class: "hint", type: "button", tabindex: "-1", "aria-hidden": "true", text: label });
      root.appendChild(hint);
    }

    function scroll() { log.scrollTop = log.scrollHeight; }
    function bubble(role, text, imgUrl, hadImg) {
      var b = el("div", { class: "msg " + role });
      if (role === "model") renderText(b, text);
      else {
        if (imgUrl) b.appendChild(el("img", { class: "up", src: imgUrl, alt: "" }));
        else if (hadImg) b.appendChild(el("span", { class: "upl", text: L.photoSent }));
        if (text) b.appendChild(document.createTextNode(text));
      }
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
            body: JSON.stringify({ name: nameI.value, contact: contI.value, question: question, chat: state.messages.filter(function (m) { return !m.live; }).slice(-8).map(function (m) { return { role: m.role, text: String(m.text || "").slice(0, 600) }; }), website: hp.value }),
          }).then(function (res) { return res.json().catch(function () { return {}; }).then(function (d) { return { ok: res.ok, status: res.status, data: d }; }); })
            .then(function (r) {
              if (r.ok) { f.remove(); bubble("model", L.ok); scroll(); return; }
              err.textContent = r.status === 400 ? L.bad : L.fail; go.disabled = false;
            }).catch(function () { err.textContent = L.fail; go.disabled = false; });
        });
      });
    }
    // Cavaba 👍/👎: yalnız AI cavablarında
    function feedbackRow(m, question) {
      if (!m.text) return;
      var row = el("div", { class: "fb" });
      var up = el("button", { class: "fbb", type: "button", "aria-label": L.up, title: L.up });
      var dn = el("button", { class: "fbb", type: "button", "aria-label": L.down, title: L.down });
      up.innerHTML = ICON_UP; dn.innerHTML = ICON_DOWN; // sabit, yoxlanmış SVG
      var thanks = el("span");
      function mark() {
        up.classList.toggle("on", m.fb === 1); dn.classList.toggle("on", m.fb === -1);
        up.disabled = dn.disabled = !!m.fb; thanks.textContent = m.fb ? L.thanks : "";
      }
      function vote(r) {
        if (m.fb) return;
        m.fb = r; mark(); save();
        fetch(api + "/feedback", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ rating: r, question: question, answer: String(m.text).slice(0, 600) }) }).catch(function () { /* rəy vacib deyil */ });
      }
      up.addEventListener("click", function () { vote(1); });
      dn.addEventListener("click", function () { vote(-1); });
      mark();
      [up, dn, thanks].forEach(function (n) { row.appendChild(n); });
      log.appendChild(row);
    }
    function extras(m, question) {
      cards(m.listings); sources(m.sources); feedbackRow(m, question);
      if (m.unanswered) { contactBox(question); liveBox(); }
    }

    // ---------- canlı operator söhbəti ----------
    function note(text, withBack) {
      var kids = [el("span", { text: text })];
      if (withBack) {
        var back = el("button", { type: "button", text: L.liveBack });
        back.addEventListener("click", function () { state.live = null; save(); updateLiveUi(); render(); input.focus(); });
        kids.push(back);
      }
      log.appendChild(el("div", { class: withBack ? "note back" : "note" }, kids));
    }
    function liveBubble(role, text) {
      if (role === "system") return note(L.liveEnd, false);
      if (role === "operator") {
        var b = el("div", { class: "msg operator" }, [el("div", { class: "who", text: L.op })]);
        b.appendChild(el("div", { text: text }));
        return log.appendChild(b);
      }
      bubble("user", text);
    }
    function liveBox() {
      if (!cfg.live || state.live) return;
      var b = el("button", { class: "cbtn livecbtn", type: "button", text: L.live });
      b.addEventListener("click", function () { b.remove(); startLive(); });
      log.appendChild(b);
    }
    function updateLiveUi() {
      liveBtn.hidden = !cfg.live || !!state.live;
      input.placeholder = state.live ? L.livePh : "Mesajınızı yazın…";
      attachBtn.hidden = cfg.imageSearch !== true || !!state.live;
    }
    // Operator cavab yazanda ziyarətçi çatda deyilsə cavab bu e-poçta gedəcək (ixtiyari)
    function mailRow() {
      var inp = el("input", { type: "email", maxlength: "120", placeholder: L.liveMailPh, "aria-label": L.liveMailPh, autocomplete: "email" });
      inp.value = (state.live && state.live.email) || "";
      inp.addEventListener("input", function () { if (state.live) state.live.email = inp.value; });
      log.appendChild(el("div", { class: "mailrow" }, [inp, el("div", { class: "hint2", text: L.liveMailHint })]));
    }
    function startLive() {
      if (state.live) return;
      state.live = { pending: true, after: 0 };
      Array.prototype.forEach.call(log.querySelectorAll(".livecbtn"), function (n) { n.remove(); });
      save(); updateLiveUi();
      note(L.liveStart, true); mailRow(); scroll(); input.focus();
    }
    liveBtn.addEventListener("click", startLive);
    function render() {
      newBtn.hidden = state.messages.length === 0 && !state.live;
      log.textContent = "";
      bubble("model", cfg.greeting || "");
      var q = "";
      state.messages.forEach(function (m) {
        if (m.live) return liveBubble(m.role, m.text);
        bubble(m.role, m.text, null, m.img); if (m.role === "user") q = m.text; else extras(m, q);
      });
      if (state.live && state.live.pending) { note(L.liveStart, true); mailRow(); }
      updateLiveUi();
      scroll();
    }

    var pollTimer = null, noReplyTimer = null, liveBusy = false;
    var ws = null, wsOk = false, wsTries = 0, wsRetry = null, typingEl = null, typingTimer = null, typingSentAt = 0, refreshBusy = false, refreshAgain = false;
    var wsUrl = base.replace(/^http/i, "ws") + "/ws";
    // Real vaxt: WebSocket yalnız "yeni mesaj var" siqnalı verir, mesajlar yenə HTTP ilə gəlir. Soket qoşuludursa polling yalnız ehtiyatdır (45 san).
    function schedulePoll() {
      clearTimeout(pollTimer);
      if (!state.live || state.live.pending || !state.live.id) return;
      var wait = wsOk ? (document.hidden ? 60000 : 45000) : document.hidden ? 30000 : state.open ? 3000 : 15000;
      pollTimer = setTimeout(function () { liveCall("").then(schedulePoll, schedulePoll); }, wait);
    }
    function hideTyping() { clearTimeout(typingTimer); if (typingEl) { typingEl.remove(); typingEl = null; } }
    function showTyping() {
      if (!typingEl) { typingEl = el("div", { class: "note typing", "aria-live": "polite" }, [el("span", { text: L.opTyping })]); log.appendChild(typingEl); scroll(); }
      clearTimeout(typingTimer); typingTimer = setTimeout(hideTyping, 4000);
    }
    function liveRefresh() { // eyni anda yalnız bir sorğu; siqnal gec gəlibsə bitəndə yenidən
      if (!state.live || !state.live.id) return;
      if (refreshBusy) { refreshAgain = true; return; }
      refreshBusy = true;
      liveCall("").catch(function () {}).then(function () { refreshBusy = false; if (refreshAgain) { refreshAgain = false; liveRefresh(); } });
    }
    function wsClose() {
      clearTimeout(wsRetry); wsTries = 0; wsOk = false; hideTyping();
      if (ws) { var w = ws; ws = null; w.onclose = null; try { w.close(); } catch (e) { /* artıq bağlıdır */ } }
    }
    function wsOpen() {
      if (ws || !window.WebSocket || !state.live || !state.live.id || state.live.pending) return;
      var sock;
      try { sock = new WebSocket(wsUrl); } catch (e) { return; }
      ws = sock;
      sock.onopen = function () { sock.send(JSON.stringify({ t: "auth", role: "visitor", key: key, id: state.live.id, token: state.live.token })); };
      sock.onmessage = function (ev) {
        var m; try { m = JSON.parse(ev.data); } catch (e) { return; }
        if (m.t === "ready") { wsOk = true; wsTries = 0; schedulePoll(); liveRefresh(); }
        else if (m.t === "new") { hideTyping(); liveRefresh(); }
        else if (m.t === "typing") showTyping();
      };
      sock.onclose = function (ev) {
        if (ws !== sock) return;
        ws = null; wsOk = false; hideTyping(); schedulePoll();
        if (!state.live || !state.live.id) return;
        if (ev && (ev.code === 4403 || ev.code === 4404)) return; // icazə yoxdur / söhbət yoxdur: polling davam edir
        wsTries++; wsRetry = setTimeout(wsOpen, Math.min(60000, 1000 * Math.pow(2, Math.min(wsTries, 6))));
      };
      sock.onerror = function () { /* onclose yenidən qoşulur */ };
    }
    function dropLive() { // söhbət tapılmadı və ya bitdi: ziyarətçi yenidən AI ilə danışır
      clearTimeout(pollTimer); clearTimeout(noReplyTimer); wsClose();
      state.live = null; save(); updateLiveUi();
    }
    function applyLive(d) {
      var gotOperator = false;
      var list = d.messages || [];
      // Siqnal və polling eyni anda işləyə bilər: artıq göstərilən mesajlar təkrar əlavə olunmasın
      var skip = Math.max(0, (state.live ? state.live.after || 0 : 0) - (d.total - list.length));
      list = list.slice(skip);
      if (list.length) hideTyping();
      list.forEach(function (m) {
        var role = m.from === "visitor" ? "user" : m.from === "operator" ? "operator" : "system";
        var text = role === "system" ? "closed" : String(m.text || "");
        state.messages.push({ role: role, text: text, live: true });
        liveBubble(role, text);
        if (role === "operator") gotOperator = true;
      });
      if (gotOperator) {
        clearTimeout(noReplyTimer);
        if (!state.open && state.live && d.total > (state.live.seen || 0)) launcher.classList.add("dot"); // yalnız oxunmamış cavab
      }
      if (state.live) { state.live.after = d.total; if (state.open) state.live.seen = d.total; }
      if (d.status === "closed") dropLive(); else save();
      newBtn.hidden = false;
      scroll();
    }
    // Mesajı göndərir (varsa) və yeni mesajları gətirir. Qaytarır: uğurlu olub-olmadığı.
    function liveCall(text) {
      var lv = state.live;
      if (!lv || !lv.id) return Promise.resolve(false);
      return fetch(api + "/live/" + lv.id + "/sync", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ token: lv.token, after: lv.after || 0, text: text || undefined }),
      }).then(function (res) { return res.json().catch(function () { return {}; }).then(function (d) { return { ok: res.ok, d: d }; }); })
        .then(function (r) {
          if (!r.ok) {
            if (r.d.code === "LIVE_NOT_FOUND") { dropLive(); return false; }
            if (r.d.code === "LIVE_CLOSED") { dropLive(); note(L.liveEnd, false); return false; }
            throw new Error("sync");
          }
          applyLive(r.d); return true;
        });
    }
    function liveSubmit(text) {
      if (liveBusy) return;
      var mail = state.live && state.live.pending ? String(state.live.email || "").trim() : "";
      if (mail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(mail)) { bubble("error", L.bad); scroll(); return; }
      liveBusy = true; sendBtn.disabled = true;
      var lv = state.live, hadOperator = state.messages.some(function (m) { return m.live && m.role === "operator"; });
      var go;
      if (lv.pending) {
        var ai = state.messages.filter(function (m) { return !m.live; }).slice(-10).map(function (m) { return { role: m.role, text: String(m.text || "").slice(0, 600) }; });
        go = fetch(api + "/live", {
          method: "POST", headers: { "content-type": "application/json" },
          body: JSON.stringify({ message: text, chat: ai, vid: visitorId(), contact: mail || undefined }),
        }).then(function (res) { return res.json().catch(function () { return {}; }).then(function (d) { return { ok: res.ok, d: d }; }); })
          .then(function (r) {
            if (!r.ok) throw new Error(r.d.code || "start");
            state.live = { id: r.d.id, token: r.d.token, after: 0, pending: false, t: Date.now(), seen: 0 };
            Array.prototype.forEach.call(log.querySelectorAll(".note.back, .mailrow"), function (n) { n.remove(); }); // "AI-a qayıt" artıq mümkün deyil
            applyLive(r.d); wsOpen(); return true;
          });
      } else go = liveCall(text);
      go.then(function (ok) {
        if (ok) { input.value = ""; grow(); schedulePoll(); if (!hadOperator) { clearTimeout(noReplyTimer); noReplyTimer = setTimeout(function () { note(L.liveWait, false); contactBox(text); scroll(); }, 90000); } }
      }).catch(function () { bubble("error", L.liveFail); scroll(); })
        .then(function () { liveBusy = false; sendBtn.disabled = false; if (state.open) input.focus(); });
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
      if (state.open && state.live && state.live.after) state.live.seen = state.live.after;
      panel.classList.toggle("open", state.open);
      launcher.setAttribute("aria-expanded", String(state.open));
      launcher.setAttribute("aria-label", state.open ? "Çatı bağla" : "Çatı aç");
      layout();
      save();
      if (state.open) { launcher.classList.remove("dot"); scroll(); setTimeout(function () { input.focus(); }, 0); schedulePoll(); }
    }
    launcher.addEventListener("click", function () { setOpen(!state.open); });
    if (hint) hint.addEventListener("click", function () { setOpen(true); });
    closeBtn.addEventListener("click", function () { setOpen(false); launcher.focus(); });
    // Yeni söhbət: yalnız ziyarətçinin brauzerindəki söhbət silinir (sayt sahibinin panelindəki qeydlərə toxunmur)
    newBtn.addEventListener("click", function () {
      gen++; if (curCtrl) { try { curCtrl.abort(); } catch (e) { /* artıq bitib */ } }
      busy = false; sendBtn.disabled = false;
      clearTimeout(pollTimer); clearTimeout(noReplyTimer); wsClose();
      state.messages = []; state.live = null; state.sid = ""; save();
      input.value = ""; grow();
      render(); input.focus();
    });
    root.addEventListener("keydown", function (e) { if (e.key === "Escape" && state.open) { setOpen(false); launcher.focus(); } });

    var busy = false, gen = 0, curCtrl = null;
    function grow() { input.style.height = "auto"; input.style.height = Math.min(input.scrollHeight, 96) + "px"; }
    input.addEventListener("input", grow);
    input.addEventListener("input", function () { // operatora "yazır..." siqnalı (3 saniyədə bir)
      if (wsOk && ws && state.live && state.live.id && Date.now() - typingSentAt > 3000) { typingSentAt = Date.now(); try { ws.send('{"t":"typing"}'); } catch (e) { /* bağlanır */ } }
    });
    input.addEventListener("keydown", function (e) {
      if (e.key === "Enter" && !e.shiftKey && !e.isComposing) { e.preventDefault(); form.requestSubmit(); }
    });

    form.addEventListener("submit", function (e) {
      e.preventDefault();
      var text = input.value.trim();
      var shot = state.live ? null : pending;
      if ((!text && !shot) || busy) return;
      if (state.live) return liveSubmit(text);
      var history = state.messages.filter(function (m) { return !m.live; }).slice(-10).map(function (m) { return { role: m.role, text: m.text + (m.note ? " [şəkil: " + m.note + "]" : (m.img && !m.text ? " [şəkil]" : "")) }; });
      if (!state.sid) state.sid = newId(); // bir söhbət = bir identifikator (sayt sahibi tarixçədə qruplaşdırılmış görür)
      var userMsg = { role: "user", text: text };
      if (shot) userMsg.img = true; // şəklin özü saxlanmır, yalnız "göndərilib" qeydi
      state.messages.push(userMsg);
      newBtn.hidden = false;
      save();
      bubble("user", text, shot ? shot.url : null);
      input.value = ""; grow(); clearPending();
      busy = true; sendBtn.disabled = true;
      var typing = el("div", { class: "typing", "aria-label": "Cavab yazılır" }, [el("i"), el("i"), el("i")]);
      log.appendChild(typing); scroll();

      var ctrl = new AbortController(), myGen = gen;
      curCtrl = ctrl;
      var timer = setTimeout(function () { ctrl.abort(); }, 60000);
      fetch(api + "/chat", {
        method: "POST", headers: { "content-type": "application/json" }, signal: ctrl.signal,
        body: JSON.stringify({ message: text, history: history, vid: visitorId(), sid: state.sid, identity: idToken || undefined, image: shot ? shot.b64 : undefined }),
      }).then(function (res) {
        return res.json().catch(function () { return {}; }).then(function (data) { return { ok: res.ok, data: data }; });
      }).then(function (r) {
        typing.remove();
        if (myGen !== gen) return; // arada "Yeni söhbət" basılıb
        if (!r.ok) {
          // Çat dayanıb (məs. balans bitib): xəta əvəzinə əlaqə formasını göstər, ziyarətçinin müraciəti itməsin
          if (r.data.code === "OFFLINE") { bubble("error", L.offline); contactBox(text); liveBox(); scroll(); return; }
          // Ziyarətçi/sayt limiti dolub: ziyarətçi itməsin, əlaqə forması təklif olunur
          if (r.data.code === "VISITOR_LIMIT" || r.data.code === "BUSY") { bubble("error", r.data.code === "BUSY" ? L.busy : L.limit); contactBox(text); liveBox(); scroll(); return; }
          return bubble("error", r.data.error || "Xəta baş verdi, bir azdan yenidən cəhd et");
        }
        if (r.data.identity === "invalid" && idToken) { idToken = null; try { window.dispatchEvent(new CustomEvent("caradvisor:identity-expired")); } catch (e) { /* köhnə brauzer */ } }
        if (typeof r.data.imageNote === "string" && r.data.imageNote) { userMsg.note = r.data.imageNote.slice(0, 200); }
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

    // İstifadəçi dəyişəndə (və ya çıxanda) əvvəlki söhbət, o cümlədən şəxsi cavablar, bu brauzerdən silinir
    function syncIdentity() {
      if (!idCalled || (state.who || "") === (idWho || "")) return; // identify() hələ çağırılmayıb: səhifə yükləməsində söhbət silinməsin
      gen++; if (curCtrl) { try { curCtrl.abort(); } catch (e) { /* artıq bitib */ } }
      busy = false; sendBtn.disabled = false;
      clearTimeout(pollTimer); clearTimeout(noReplyTimer); wsClose();
      state.messages = []; state.live = null; state.sid = ""; state.who = idWho || ""; save();
      input.value = ""; grow(); render();
    }
    idHook = syncIdentity; syncIdentity();
    render();
    document.body.appendChild(host);
    setOpen(state.open);
    if (state.live && state.live.id && !state.live.pending) { liveCall("").then(schedulePoll, schedulePoll); wsOpen(); } // yenilənəndən sonra canlı söhbət davam edir

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
      identify: window.CarAdvisor.identify,
      open: function () { setOpen(true); },
      close: function () { setOpen(false); },
      toggle: function () { setOpen(!state.open); },
      // Vidjeti tam silir (məs. React komponentinin useEffect təmizləməsində). Skript yenidən yüklənsə yenidən qurulur.
      destroy: function () {
        if (state.open) setOpen(false);
        window.removeEventListener("popstate", onRoute); window.removeEventListener("hashchange", onRoute);
        restore.forEach(function (f) { f(); });
        host.remove(); idHook = null; delete window.CarAdvisor; window.__carAdvisorWidget = false;
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
