/*!
 * Hazırcavab çat vidjeti
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
 *   data-links="new-tab"               elan və linklər həmişə yeni vərəqdə açılsın (defolt: saytın öz linkləri eyni vərəqdə,
 *                                      söhbət yeni səhifədə davam edir; başqa saytların linkləri yeni vərəqdə)
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
  var T_EN = null;
  // Yeni mətnlər (mənbələr, əlaqə forması): səhifənin dilinə görə az / en / ru
  var L = (function () {
    var lang = ((document.documentElement.lang || navigator.language || "az") + "").slice(0, 2).toLowerCase();
    var T = {
      az: { menu: "Əlavə imkanlar", soundOff: "Səsi bağla", soundOn: "Səsi aç", emoji: "Emoji", sendL: "Göndər", months: ["Yanvar","Fevral","Mart","Aprel","May","İyun","İyul","Avqust","Sentyabr","Oktyabr","Noyabr","Dekabr"], poweredBy: "Hazırlayan:", csatQ: "Operatorun xidmətini qiymətləndirin", proClose: "Bağla", actYes: "Təsdiq et", actExpired: "Bu təsdiqin vaxtı keçib. Əməliyyatı yenidən istəyin.", actUnknown: "Əməliyyatın icra olunub-olunmadığı bəlli deyil. Təkrar etməyin, operatorla yoxlayın.", actFail: "Təsdiqlənə bilmədi, əməliyyat icra olunmayıb. Yenidən cəhd edin.", actWait: "Gözləyin…", actCheck: "Əməliyyatı yoxlayın:", src: "Mənbə:", offline: "Çat hazırda cavab vermir. İstəsəniz əlaqə qoyun, sizinlə əlaqə saxlayaq.", contact: "Operatorla əlaqə", name: "Adınız (ixtiyari)", cont: "Telefon və ya e-poçt", send: "Göndər", ok: "Təşəkkürlər! Müraciətiniz qəbul edildi, tezliklə sizinlə əlaqə saxlayacağıq.", bad: "Düzgün telefon nömrəsi və ya e-poçt yazın", fail: "Göndərilə bilmədi, bir azdan yenidən cəhd edin", cancel: "Ləğv et", fresh: "Yeni söhbət", toDark: "Gecə rejimi", toLight: "Gündüz rejimi", photoAdd: "Şəkil əlavə et", photoDel: "Şəkli sil", photoBad: "Şəkil oxuna bilmədi. PNG, JPG və ya WebP seçin.", photoSent: "Şəkil göndərildi", live: "Operatorla canlı yaz", liveStart: "Operatora qoşuldunuz. Mesajınızı yazın, cavab gələndə burada görəcəksiniz.", opTyping: "Operator yazır…", liveMailPh: "E-poçt (ixtiyari)", liveMailHint: "Çatdan çıxsanız, operatorun cavabını e-poçtla göndərək.", liveBack: "AI-a qayıt", liveWait: "Operator hələ cavab verməyib. İstəsəniz əlaqə qoyun, sizinlə əlaqə saxlayaq.", liveEnd: "Operator söhbəti bitirdi. Yeni sual yazsanız, yenidən AI cavab verəcək.", liveFail: "Mesaj göndərilmədi, yenidən cəhd edin", livePh: "Operatora mesaj yazın…", op: "Operator", aiBadge: "AI köməkçi", joined: "{n} söhbətə qoşuldu", up: "Cavab faydalı idi", down: "Cavab faydalı deyildi", thanks: "Təşəkkürlər!", limit: "Bu gün üçün sual limitinə çatdınız. İstəsəniz əlaqə qoyun, sizinlə əlaqə saxlayaq.", busy: "Çat hazırda çox yüklüdür. İstəsəniz əlaqə qoyun, sizinlə əlaqə saxlayaq." , ph: "Mesajınızı yazın…", msgLabel: "Mesaj" },
      en: { menu: "More options", soundOff: "Mute sounds", soundOn: "Turn sounds on", emoji: "Emoji", sendL: "Send", months: ["January","February","March","April","May","June","July","August","September","October","November","December"], poweredBy: "Powered by", csatQ: "Please rate the operator's help", proClose: "Close", actYes: "Confirm", actExpired: "This confirmation has expired. Please ask for the action again.", actUnknown: "It is not known whether the action was carried out. Do not repeat it; check with an operator.", actFail: "Could not confirm; the action was not carried out. Please try again.", actWait: "Please wait…", actCheck: "Please check the action:", src: "Source:", offline: "The chat can't answer right now. Leave your contact and we'll get back to you.", contact: "Contact an operator", name: "Your name (optional)", cont: "Phone or email", send: "Send", ok: "Thank you! Your request was received, we'll contact you soon.", bad: "Enter a valid phone number or email", fail: "Could not send, please try again shortly", cancel: "Cancel", fresh: "New chat", toDark: "Night mode", toLight: "Day mode", photoAdd: "Attach a photo", photoDel: "Remove photo", photoBad: "Couldn't read the image. Choose PNG, JPG or WebP.", photoSent: "Photo sent", live: "Chat with an operator", liveStart: "You are connected to an operator. Type your message, replies will appear here.", opTyping: "Operator is typing…", liveMailPh: "Email (optional)", liveMailHint: "If you leave the chat, we will email you the operator's reply.", liveBack: "Back to AI", liveWait: "The operator has not replied yet. Leave your contact and we'll get back to you.", liveEnd: "The operator ended the chat. Write a new question and the AI will answer again.", liveFail: "Message not sent, please try again", livePh: "Message the operator…", op: "Operator", aiBadge: "AI assistant", joined: "{n} joined the chat", up: "Helpful answer", down: "Not helpful", thanks: "Thanks!", limit: "You have reached today's question limit. Leave your contact and we'll get back to you.", busy: "The chat is very busy right now. Leave your contact and we'll get back to you." , ph: "Type your message…", msgLabel: "Message" },
      ru: { menu: "Дополнительно", soundOff: "Выключить звук", soundOn: "Включить звук", emoji: "Эмодзи", sendL: "Отправить", months: ["января","февраля","марта","апреля","мая","июня","июля","августа","сентября","октября","ноября","декабря"], poweredBy: "Работает на", csatQ: "Оцените помощь оператора", proClose: "Закрыть", actYes: "Подтвердить", actExpired: "Срок подтверждения истёк. Запросите действие заново.", actUnknown: "Неизвестно, выполнено ли действие. Не повторяйте его, уточните у оператора.", actFail: "Не удалось подтвердить, действие не выполнено. Попробуйте ещё раз.", actWait: "Подождите…", actCheck: "Проверьте действие:", src: "Источник:", offline: "Чат сейчас не может ответить. Оставьте контакт, и мы свяжемся с вами.", contact: "Связаться с оператором", name: "Ваше имя (необязательно)", cont: "Телефон или e-mail", send: "Отправить", ok: "Спасибо! Ваше обращение принято, мы скоро свяжемся с вами.", bad: "Введите корректный телефон или e-mail", fail: "Не удалось отправить, попробуйте позже", cancel: "Отмена", fresh: "Новый чат", toDark: "Ночной режим", toLight: "Дневной режим", photoAdd: "Прикрепить фото", photoDel: "Убрать фото", photoBad: "Не удалось прочитать изображение. Выберите PNG, JPG или WebP.", photoSent: "Фото отправлено", live: "Написать оператору", liveStart: "Вы подключены к оператору. Напишите сообщение, ответ появится здесь.", opTyping: "Оператор печатает…", liveMailPh: "E-mail (необязательно)", liveMailHint: "Если вы выйдете из чата, мы отправим ответ оператора на e-mail.", liveBack: "Назад к ИИ", liveWait: "Оператор пока не ответил. Оставьте контакт, и мы свяжемся с вами.", liveEnd: "Оператор завершил чат. Напишите новый вопрос, и снова ответит ИИ.", liveFail: "Сообщение не отправлено, попробуйте ещё раз", livePh: "Сообщение оператору…", op: "Оператор", aiBadge: "ИИ-ассистент", joined: "К чату подключился оператор: {n}", up: "Ответ полезен", down: "Ответ не полезен", thanks: "Спасибо!", limit: "Вы достигли лимита вопросов на сегодня. Оставьте контакт, и мы свяжемся с вами.", busy: "Чат сейчас сильно загружен. Оставьте контакт, и мы свяжемся с вами." , ph: "Напишите сообщение…", msgLabel: "Сообщение" },
      tr: { menu: "Diğer seçenekler", soundOff: "Sesi kapat", soundOn: "Sesi aç", emoji: "Emoji", sendL: "Gönder", months: ["Ocak","Şubat","Mart","Nisan","Mayıs","Haziran","Temmuz","Ağustos","Eylül","Ekim","Kasım","Aralık"], poweredBy: "Sağlayan:", csatQ: "Operatörün yardımını değerlendirin", proClose: "Kapat", actYes: "Onayla", actExpired: "Bu onayın süresi doldu. İşlemi yeniden isteyin.", actUnknown: "İşlemin gerçekleştirilip gerçekleştirilmediği belli değil. Tekrarlamayın, operatörle kontrol edin.", actFail: "Onaylanamadı, işlem gerçekleştirilmedi. Lütfen tekrar deneyin.", actWait: "Lütfen bekleyin…", actCheck: "İşlemi kontrol edin:", src: "Kaynak:", offline: "Sohbet şu anda yanıt veremiyor. İsterseniz iletişim bilgilerinizi bırakın, sizinle iletişime geçelim.", contact: "Operatörle iletişim", name: "Adınız (isteğe bağlı)", cont: "Telefon veya e-posta", send: "Gönder", ok: "Teşekkürler! Başvurunuz alındı, kısa süre içinde sizinle iletişime geçeceğiz.", bad: "Geçerli bir telefon numarası veya e-posta yazın", fail: "Gönderilemedi, birazdan tekrar deneyin", cancel: "İptal", fresh: "Yeni sohbet", toDark: "Gece modu", toLight: "Gündüz modu", photoAdd: "Fotoğraf ekle", photoDel: "Fotoğrafı kaldır", photoBad: "Görsel okunamadı. PNG, JPG veya WebP seçin.", photoSent: "Fotoğraf gönderildi", live: "Operatörle canlı yaz", liveStart: "Operatöre bağlandınız. Mesajınızı yazın, yanıt geldiğinde burada göreceksiniz.", opTyping: "Operatör yazıyor…", liveMailPh: "E-posta (isteğe bağlı)", liveMailHint: "Sohbetten çıkarsanız operatörün yanıtını e-postayla gönderelim.", liveBack: "AI'a dön", liveWait: "Operatör henüz yanıt vermedi. İsterseniz iletişim bilgilerinizi bırakın, sizinle iletişime geçelim.", liveEnd: "Operatör sohbeti bitirdi. Yeni bir soru yazarsanız yine AI yanıt verecek.", liveFail: "Mesaj gönderilemedi, tekrar deneyin", livePh: "Operatöre mesaj yazın…", op: "Operatör", aiBadge: "AI asistan", joined: "{n} sohbete katıldı", up: "Yanıt faydalıydı", down: "Faydalı değildi", thanks: "Teşekkürler!", limit: "Bugünkü soru sınırına ulaştınız. İletişim bilgilerinizi bırakın, sizinle iletişime geçelim.", busy: "Sohbet şu anda çok yoğun. İletişim bilgilerinizi bırakın, sizinle iletişime geçelim.", ph: "Mesajınızı yazın…", msgLabel: "Mesaj" }
    };
    T_EN = T.en;
    return T[lang] || T.az;
  })();
  // Anonim ziyarətçi ID-si (təsadüfi, şəxsi məlumat deyil): eyni şəbəkədəki ziyarətçilər bir limiti bölüşməsin deyə.
  var memVid = "";
  // Operator üçün: ilk ziyarət vaxtı və ziyarət sayı (bu brauzerdə; yeni vərəq sessiyası = yeni ziyarət). IP saxlanmır.
  var visit = (function () {
    var v = { first: Date.now(), visits: 1 };
    try {
      var o = JSON.parse(localStorage.getItem("ca_visit") || "null");
      if (o && typeof o.first === "number" && typeof o.visits === "number") v = { first: o.first, visits: o.visits };
      if (!sessionStorage.getItem("ca_visit_s")) { if (o) v.visits += 1; sessionStorage.setItem("ca_visit_s", "1"); }
      localStorage.setItem("ca_visit", JSON.stringify(v));
    } catch (e) { /* yaddaş bağlıdır */ }
    return v;
  })();
  function visTz() { try { return Intl.DateTimeFormat().resolvedOptions().timeZone || undefined; } catch (e) { return undefined; } }
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

  // ---------- analitika: saytın öz Google Analytics / Tag Manager-inə hadisə ----------
  // gtag varsa gtag("event", ...), yoxdursa dataLayer.push({event, ...}). Hər hadisə "caradvisor:event" adlı DOM hadisəsi kimi də göndərilir
  // (Yandex Metrica, Facebook Pixel və s. üçün). Söndürmək: <script ... data-analytics="off">. Şəxsi məlumat (mesaj mətni, e-poçt) göndərilmir.
  var analyticsOn = script.getAttribute("data-analytics") !== "off";
  // Saytın öz linki eyni vərəqdə açılır: söhbət (sessionStorage) yeni səhifədə də görünür.
  // Yeni vərəqdə sessionStorage boş başlayır, istifadəçi yazışmanı itirmiş kimi görür.
  var linksNewTab = script.getAttribute("data-links") === "new-tab";
  function sameSite(u) {
    try { var h = new URL(u, location.href).hostname.replace(/^www\./, ""); return h === location.hostname.replace(/^www\./, ""); } catch (e) { return false; }
  }
  function linkAttrs(u, extra) {
    var a = extra || {};
    a.href = u;
    if (linksNewTab || !sameSite(u)) { a.target = "_blank"; a.rel = "noopener noreferrer"; }
    return a;
  }
  var opened = false;
  function track(name, params) {
    if (!analyticsOn) return;
    var p = params || {};
    try {
      if (typeof window.gtag === "function") window.gtag("event", name, p);
      else if (Array.isArray(window.dataLayer)) { var o = { event: name }; for (var k in p) o[k] = p[k]; window.dataLayer.push(o); }
    } catch (e) { /* saytın analitikası xəta versə çat işləməyə davam edir */ }
    try { window.dispatchEvent(new CustomEvent("caradvisor:event", { detail: { name: name, params: p } })); } catch (e) { /* köhnə brauzer */ }
  }

  // ---------- təhlükəsiz mətn göstəricisi (innerHTML yoxdur) ----------
  // Dəstəklənir: **qalın**, [mətn](https://...), "* " / "- " siyahıları, sətir keçidləri.
  var INLINE = /\*\*([^*]+)\*\*|\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g;
  function inline(parent, text) {
    var last = 0, m;
    INLINE.lastIndex = 0;
    while ((m = INLINE.exec(text))) {
      if (m.index > last) parent.appendChild(document.createTextNode(text.slice(last, m.index)));
      if (m[1] !== undefined) parent.appendChild(el("strong", { text: m[1] }));
      else parent.appendChild(el("a", linkAttrs(m[3], { text: m[2] })));
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
    ".launcher:focus-visible,button:focus-visible,a:focus-visible{outline:2px solid var(--accent);outline-offset:2px}",
    ".launcher svg{width:26px;height:26px}",
    ".launcher.logo{padding:0;overflow:hidden;background:var(--bg)}.launcher.logo img{width:100%;height:100%;object-fit:cover;display:block}",
    // Başlıqdakı profil şəkli (loqodan ayrıdır): yüklənməyibsə standart bot ikonu
    ".hav{width:32px;height:32px;border-radius:50%;overflow:hidden;display:grid;place-items:center;flex:none;background:color-mix(in srgb,var(--accent-fg) 18%,transparent);color:var(--accent-fg)}",
    ".hav img,.av img{width:100%;height:100%;object-fit:cover;display:block}.hav svg{width:19px;height:19px}",
    ".panel{position:fixed;bottom:calc(var(--cy) + 68px);" + position + ":var(--cx);width:380px;max-width:calc(100vw - 24px);height:560px;max-height:max(240px,calc(100vh - var(--cy) - 88px));background:var(--bg);color:var(--fg);border-radius:16px;box-shadow:0 12px 40px rgba(0,0,0,.28);display:none;flex-direction:column;overflow:hidden;z-index:calc(var(--ca-z) + 1);border:1px solid var(--border)}",
    ".panel.open{display:flex}",
    ".head{display:flex;align-items:center;gap:8px;padding:14px 16px;background:var(--accent);color:var(--accent-fg)}",
    ".head h2{margin:0;font-size:15px;font-weight:600;line-height:1.3;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
    ".htx{flex:1;min-width:0;display:flex;flex-direction:column}.hsub{font-size:11.5px;line-height:1.3;opacity:.85;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
    ".hsub b{display:inline-block;font-weight:600;font-size:10px;letter-spacing:.02em;padding:0 5px;margin-right:4px;border-radius:4px;background:color-mix(in srgb,var(--accent-fg) 20%,transparent);vertical-align:1px}",
    ".close{background:transparent;border:0;color:inherit;cursor:pointer;padding:4px;border-radius:6px;display:grid;place-items:center}",
    ".close svg{width:20px;height:20px}",
    ".newb[hidden]{display:none}",
    ".log{flex:1;overflow-y:auto;overscroll-behavior:contain;padding:14px 14px 12px;display:flex;flex-direction:column;gap:10px;background:var(--bg2)}",
    ".opfile{display:inline-block;margin:2px 0 4px;padding:6px 10px;border-radius:10px;background:rgba(0,0,0,.06);color:inherit;text-decoration:none;font-weight:600;word-break:break-all}.opimg{display:block}",
    ".msg{max-width:88%;min-width:0;padding:9px 12px;border-radius:14px;font-size:14px;line-height:1.45;word-wrap:break-word;overflow-wrap:anywhere}",
    ".msg p{margin:0}.msg p+p,.msg ul+p,.msg p+ul{margin-top:6px}",
    ".msg ul{margin:0;padding-left:18px}",
    ".msg a{color:inherit;text-decoration:underline}",
    ".user{align-self:flex-end;background:var(--accent);color:var(--accent-fg);border-bottom-right-radius:4px}",
    ".model{align-self:flex-start;background:var(--bg);border:1px solid var(--border);border-bottom-left-radius:4px}",
    ".model a{color:var(--accent-t)}",
    ".srcs{align-self:flex-start;max-width:80%;font-size:12px;color:var(--muted);margin-top:-4px;display:flex;flex-wrap:wrap;gap:4px 8px}",
    // Mesaj sətri: bot mesajında solda dairəvi profil şəkli; vaxt yalnız siçan üzərinə gələndə (telefonda toxunanda) görünür
    ".mrow{display:flex;align-items:flex-end;gap:8px;max-width:94%}.mrow.mu{align-self:flex-end}.mrow.mb{align-self:flex-start}.mrow .msg{max-width:none}",
    ".av{flex:none;width:28px;height:28px;border-radius:50%;overflow:hidden;display:grid;place-items:center;background:var(--accent);color:var(--accent-fg)}.av svg{width:17px;height:17px}",
    ".av.op{background:var(--opbg);color:var(--opfg);border:1px solid var(--opbd)}",
    ".tm{flex:none;align-self:center;font-size:11px;color:var(--muted);opacity:0;transition:opacity .15s;white-space:nowrap;font-variant-numeric:tabular-nums}",
    ".mrow:hover .tm,.mrow.show .tm{opacity:1}",
    ".day{align-self:center;font-size:12px;font-weight:600;color:var(--muted);padding:2px 10px}",
    // Bot mesajına aid əlavələr (kartlar, mənbələr, düymələr) mətnlə bir xətdə: profil şəklinin eni qədər içəridən
    ".srcs,.fb,.acard,.cbtn,.csat{margin-left:36px}.cards{width:100%}", // elan kartları tam enlə: solda avatar üçün boş yer qalmır
    ".srcs a{color:var(--accent-t);text-decoration:underline}",
    ".cbtn{align-self:flex-start;border:1px solid var(--accent-t);background:var(--bg);color:var(--accent-t);border-radius:999px;padding:6px 12px;font-size:13px;font-weight:600;cursor:pointer}",
    ".cform{align-self:stretch;display:flex;flex-direction:column;align-items:stretch;gap:6px;background:var(--bg);border:1px solid var(--border);border-radius:12px;padding:10px}",
    ".cform input{border:1px solid var(--border2);border-radius:8px;padding:8px 10px;font-size:14px;color:var(--fg);background:var(--bg)}",
    ".cform .hp{position:absolute;left:-9999px;width:1px;height:1px;opacity:0}",
    ".cform .row{display:flex;gap:8px}",
    ".cform .row button{flex:1;border-radius:8px;padding:8px;font-size:13px;font-weight:600;cursor:pointer;border:1px solid var(--border2);background:var(--bg);color:var(--fg)}",
    ".cform .row button.go{background:var(--accent);color:var(--accent-fg);border-color:var(--accent)}",
    ".cform .row button:disabled{opacity:.5;cursor:default}",
    ".csat{align-self:flex-start;background:var(--bg);border:1px solid var(--border);border-radius:12px;padding:10px 12px;font-size:13px;color:var(--fg);display:flex;flex-direction:column;gap:6px}",
    ".csat .stars{display:flex;gap:4px}",
    ".csat .stars button{border:0;background:none;font-size:24px;line-height:1;cursor:pointer;color:var(--muted);padding:2px}",
    ".csat .stars button:hover,.csat .stars button:focus-visible{color:#f59e0b}",
    ".pro{position:fixed;bottom:calc(var(--cy) + 68px);" + position + ":var(--cx);max-width:min(260px,calc(100vw - 2 * var(--cx)));background:var(--bg);color:var(--fg);border-radius:14px;box-shadow:0 6px 20px rgba(0,0,0,.22);z-index:var(--ca-z);animation:hintIn .35s ease both;display:flex;align-items:flex-start}",
    ".pro .prot .who{display:block;margin-bottom:2px}",
    ".pro .prot{border:0;background:none;color:inherit;font-size:14px;font-weight:600;text-align:left;cursor:pointer;padding:12px 4px 12px 14px;line-height:1.35}",
    ".pro .prox{border:0;background:none;color:var(--muted);font-size:18px;cursor:pointer;padding:6px 10px;line-height:1}",
    // Kampaniya kartı: başlıq, mətn, düymələr və yazı sahəsi
    ".pro.card{flex-direction:column;align-items:stretch;width:min(300px,calc(100vw - 2 * var(--cx)));max-width:none;padding:10px;gap:10px;border-radius:20px}",
    ".pc-top{display:flex;align-items:center;gap:8px}.pc-who{display:flex;align-items:center;gap:6px;min-width:0;font-size:13px;font-weight:600}.pc-who .av{width:24px;height:24px}.pc-who .av svg{width:14px;height:14px}.pc-who span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
    ".pc-top .prox{margin-left:auto}",
    ".pc-hero{border-radius:14px;padding:22px 16px;background:radial-gradient(120% 90% at 85% 0%,color-mix(in srgb,var(--accent) 35%,transparent),transparent 70%),color-mix(in srgb,var(--accent) 8%,var(--bg));font-size:26px;line-height:1.1;font-weight:800;letter-spacing:-.02em;text-align:center;word-break:break-word}",
    ".pc-text{font-size:14px;line-height:1.45;color:var(--fg);padding:0 4px;margin:0;word-break:break-word}",
    ".pc-btns{display:flex;flex-wrap:wrap;gap:6px}.pc-btns button{border:1px solid var(--border);background:var(--bg);color:var(--fg);border-radius:999px;padding:8px 14px;font-size:13px;font-weight:600;cursor:pointer}.pc-btns button.main{background:var(--accent);color:var(--accent-fg);border-color:transparent}",
    ".pc-in{display:flex;align-items:center;gap:6px;border:1px solid var(--border);border-radius:999px;padding:4px 4px 4px 14px}.pc-in input{flex:1;min-width:0;border:0;background:none;color:var(--fg);font:inherit;font-size:14px;outline:none;padding:6px 0}.pc-in button{width:32px;height:32px;border-radius:50%;border:0;background:var(--accent);color:var(--accent-fg);cursor:pointer;display:grid;place-items:center;flex:none}.pc-in button svg{width:16px;height:16px}",
    ".acard{align-self:flex-start;max-width:92%;background:var(--bg);border:1px solid var(--accent-t);border-radius:12px;padding:10px 12px;font-size:13px;color:var(--fg);display:flex;flex-direction:column;gap:6px}",
    ".acard b{font-size:14px}",
    ".acard .ad{display:grid;grid-template-columns:auto 1fr;gap:2px 10px;color:var(--muted)}",
    ".acard .ad span:nth-child(odd){font-weight:600}",
    ".acard .row{display:flex;gap:8px;margin-top:2px}",
    ".acard .row button{flex:1;border-radius:8px;padding:8px;font-size:13px;font-weight:600;cursor:pointer;border:1px solid var(--border2);background:var(--bg);color:var(--fg)}",
    ".acard .row button.go{background:var(--accent);color:var(--accent-fg);border-color:var(--accent)}",
    ".acard .row button:disabled{opacity:.5;cursor:default}",
    ".acard .err{color:#b91c1c;font-size:12px}",
    ".acard.done{border-color:var(--border);opacity:.85}",
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
    // Çat düyməsinin effektləri (paneldən seçilir, yalnız çat bağlı olanda): yumşaq rəngli dalğa və yavaş süzülmə (yuxarı-aşağı)
    "@keyframes ca-pulse{0%{box-shadow:0 6px 20px rgba(0,0,0,.25),0 0 0 0 color-mix(in srgb,var(--accent) 55%,transparent)}70%{box-shadow:0 6px 20px rgba(0,0,0,.25),0 0 0 11px color-mix(in srgb,var(--accent) 0%,transparent)}100%{box-shadow:0 6px 20px rgba(0,0,0,.25),0 0 0 0 color-mix(in srgb,var(--accent) 0%,transparent)}}",
    "@keyframes ca-bounce{0%,100%{transform:translateY(0)}50%{transform:translateY(-5px)}}",
    ".launcher.fx-pulse[aria-expanded=false]{animation:ca-pulse 2.2s ease-out infinite}",
    ".launcher.fx-bounce[aria-expanded=false]{animation:ca-bounce 4s ease-in-out infinite}",
    ".launcher.fx-pulse.fx-bounce[aria-expanded=false]{animation:ca-pulse 2.2s ease-out infinite,ca-bounce 4s ease-in-out infinite}",
    ".launcher.fx-pulse:hover,.launcher.fx-bounce:hover{animation-play-state:paused}",
    "@media (prefers-reduced-motion:reduce){.typing i{animation:none;opacity:.7}.launcher{transition:none;animation:none!important}.hint{animation:none}.sheet,.sheet-bg{transition:none}}",
    // Yazı sahəsi: kənarda heç nə yoxdur; emoji və sancaq/göndər düymələri sahənin içində, sağda
    // Yazı sahəsinin üstündə boşluq və xətt yoxdur; fon söhbətin fonu ilə eynidir, yalnız altda boşluq var
    "form{position:relative;padding:0 12px 12px;background:var(--bg2)}",
    ".ibox{display:flex;align-items:flex-end;gap:2px;border:1px solid var(--border2);border-radius:22px;padding:3px 4px 3px 14px;background:var(--bg);transition:border-color .15s}",
    ".ibox:focus-within{border-color:var(--accent)}",
    "textarea{flex:1;min-width:0;resize:none;border:0;outline:0;padding:8px 0;margin:0;font-size:14px;line-height:1.35;max-height:96px;overflow-y:hidden;color:var(--fg);background:transparent}",
    ".ib{flex:none;width:34px;height:34px;border:0;border-radius:50%;background:transparent;color:var(--muted);display:grid;place-items:center;cursor:pointer;padding:0;transition:background .15s,color .15s,opacity .15s}",
    ".ib:hover{color:var(--accent-t)}.ib svg{width:19px;height:19px}.ib[hidden]{display:none}",
    ".ib.go{background:var(--accent);color:var(--accent-fg)}.ib.go svg{width:17px;height:17px}.ib.go.idle{opacity:.45;cursor:default}.ib:disabled{opacity:.5;cursor:default}",
    ".emo{position:absolute;bottom:calc(100% + 6px);right:12px;width:min(296px,calc(100% - 24px));max-height:216px;overflow-y:auto;background:var(--bg);border:1px solid var(--border);border-radius:14px;box-shadow:0 8px 24px rgba(0,0,0,.18);padding:6px;display:grid;grid-template-columns:repeat(8,1fr);gap:2px;z-index:3}",
    ".emo[hidden]{display:none}.emo button{border:0;background:transparent;font-size:20px;line-height:1;padding:6px 0;border-radius:8px;cursor:pointer}.emo button:hover{background:var(--bg2)}",
    // Üç nöqtə menyusu: pəncərənin altından açılan vərəq
    ".sheet-bg{position:absolute;inset:0;background:rgba(0,0,0,.35);opacity:0;pointer-events:none;transition:opacity .2s;z-index:5}.sheet-bg.on{opacity:1;pointer-events:auto}",
    ".sheet{position:absolute;left:0;right:0;bottom:0;background:var(--bg);color:var(--fg);border-radius:16px 16px 0 0;padding:6px 8px 12px;box-shadow:0 -8px 24px rgba(0,0,0,.18);transform:translateY(100%);visibility:hidden;transition:transform .22s ease,visibility 0s .22s;z-index:6}",
    ".sheet.on{transform:none;visibility:visible;transition:transform .22s ease}",
    ".grab{width:36px;height:4px;border-radius:2px;background:var(--border2);margin:4px auto 8px}",
    ".mi{display:flex;align-items:center;gap:12px;width:100%;border:0;background:transparent;color:var(--fg);font-size:14px;padding:12px;border-radius:10px;cursor:pointer;text-align:left}",
    ".mi:hover{background:var(--bg2)}.mi svg{width:20px;height:20px;color:var(--muted);flex:none}.mi[hidden]{display:none}",
    ".pv{display:flex;align-items:center;gap:8px;padding:0 12px 8px;background:var(--bg2)}",
    ".pv img{width:44px;height:44px;border-radius:8px;object-fit:cover;border:1px solid var(--border)}",
    ".pv button{border:0;background:transparent;color:var(--muted);cursor:pointer;font-size:12px;text-decoration:underline;padding:4px}",
    ".msg img.up{display:block;max-width:160px;max-height:160px;border-radius:8px;margin-bottom:6px}.msg .upl{display:block;font-size:12px;opacity:.8;margin-bottom:4px}",
    // Cari pillənin məsafələri --cx/--cy-yə yazılır (lg defolt, sonra md, sonra sm). Sm-də çat tam ekrandır.
    ".launcher,.panel,.hint,.pro{--cx:var(--ca-side);--cy:var(--ca-bottom)}",
    "@media " + MQ_MD + "{.launcher,.panel,.hint,.pro{--cx:var(--ca-side-md);--cy:var(--ca-bottom-md)}}",
    "@media " + MQ_SM + "{.launcher,.panel,.hint,.pro{--cx:var(--ca-side-m,var(--ca-side-sm));--cy:var(--ca-bottom-m,var(--ca-bottom-sm))}.panel{inset:0;width:100%;max-width:none;height:100%;max-height:none;border-radius:0;border:0}}",
  ].join("");

  var ICON_CHAT = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>';
  var ICON_NEW = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 12a9 9 0 1 0 3-6.7"/><path d="M3 4v5h5"/></svg>';
  var ICON_X = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M18 6 6 18M6 6l12 12"/></svg>';

  var ICON_USER = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/></svg>';
  var ICON_MOON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/></svg>';
  var ICON_SUN = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>';
  var ICON_BOT = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="4" y="8" width="16" height="12" rx="3"/><path d="M12 4.5V8"/><circle cx="12" cy="3.5" r="1"/><circle cx="9" cy="14" r="1.3" fill="currentColor" stroke="none"/><circle cx="15" cy="14" r="1.3" fill="currentColor" stroke="none"/><path d="M2 13v3M22 13v3"/></svg>';
  var ICON_DOTS = '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><circle cx="5" cy="12" r="2"/><circle cx="12" cy="12" r="2"/><circle cx="19" cy="12" r="2"/></svg>';
  var ICON_SMILE = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M8 14s1.5 2 4 2 4-2 4-2"/><path d="M9 9h.01M15 9h.01"/></svg>';
  var ICON_CLIP = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m21.4 11.1-9.2 9.2a6 6 0 0 1-8.5-8.5l8.6-8.6a4 4 0 1 1 5.7 5.7l-8.6 8.6a2 2 0 0 1-2.8-2.8l8.5-8.5"/></svg>';
  var ICON_SEND = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M22 2 11 13"/><path d="M22 2 15 22l-4-9-9-4z"/></svg>';
  var ICON_VOL = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M11 5 6 9H2v6h4l5 4z"/><path d="M15.5 8.5a5 5 0 0 1 0 7M19 5a10 10 0 0 1 0 14"/></svg>';
  var ICON_MUTE = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M11 5 6 9H2v6h4l5 4z"/><path d="m22 9-6 6M16 9l6 6"/></svg>';
  var EMOJIS = ["😀","😄","😁","😂","🤣","😊","😍","🥰","😘","😉","😎","🤩","🙂","🤔","😐","😅","😢","😭","😡","😱","🥳","😴","🤗","🙏","👍","👎","👌","👏","🙌","💪","🤝","✌️","❤️","🧡","💛","💚","💙","💜","🔥","⭐","✨","🎉","🎁","💯","✅","❌","⚠️","❓","📦","🚚","🚗","🏍️","🏠","📱","💻","💳","💰","🛒","⏰","📍","📞","✉️","☀️","🌙"];
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
    var accent = /^#[0-9a-fA-F]{6}$/.test(cfg.color) ? cfg.color : "#18181b";
    // Bunlar defolt dəyərlərdir: saytın CSS-i host elementinə eyni adlı --ca-* yazsa, o üstün gəlir.
    // (Köhnə --ca-side-m / --ca-bottom-m adları sm pilləsi üçün hələ də işləyir.)
    var val = function (n, inherit) { return n === null ? "var(" + inherit + ")" : n + "px"; };
    var vars = "--accent:" + accent + ";--accent-fg:" + textColorFor(accent) + ";--ca-z:2147483000"
      + ";--ca-side:" + sideLg + "px;--ca-bottom:" + bottomLg + "px"
      + ";--ca-side-md:" + val(sideMd, "--ca-side") + ";--ca-bottom-md:" + val(bottomMd, "--ca-bottom")
      + ";--ca-side-sm:" + val(sideSm, "--ca-side-md") + ";--ca-bottom-sm:" + val(bottomSm, "--ca-bottom-md");
    root.appendChild(el("style", { text: ":host{" + vars + "}" + themeCss() + CSS }));

    var log = el("div", { class: "log", role: "log", "aria-live": "polite", "aria-label": "Söhbət" });
    var input = el("textarea", { rows: "1", maxlength: "500", placeholder: L.ph, "aria-label": L.msgLabel });
    // Sağdakı düymə: yazı yoxdursa sancaq (şəkil əlavə et), yazı varsa göndər. Şəkil söndürülübsə həmişə göndər.
    var sendBtn = el("button", { class: "ib go idle", type: "submit", "aria-label": L.sendL, title: L.sendL });
    sendBtn.innerHTML = ICON_SEND; // sabit, yoxlanmış SVG
    var emojiBtn = el("button", { class: "ib emob", type: "button", "aria-label": L.emoji, title: L.emoji, "aria-expanded": "false" });
    emojiBtn.innerHTML = ICON_SMILE; // sabit, yoxlanmış SVG
    var emo = el("div", { class: "emo", role: "dialog", "aria-label": L.emoji }); emo.hidden = true;
    EMOJIS.forEach(function (ch) {
      var b = el("button", { type: "button", text: ch, "aria-label": ch });
      b.addEventListener("click", function () {
        var a = input.selectionStart == null ? input.value.length : input.selectionStart, z = input.selectionEnd == null ? a : input.selectionEnd;
        if ((input.value.length - (z - a) + ch.length) > 500) return;
        input.setRangeText(ch, a, z, "end");
        grow(); input.focus();
      });
      emo.appendChild(b);
    });
    function emoShow(v) { emo.hidden = !v; emojiBtn.setAttribute("aria-expanded", String(!!v)); }
    emojiBtn.addEventListener("click", function () { emoShow(emo.hidden); if (emo.hidden) input.focus(); });
    var closeBtn = el("button", { class: "close", type: "button", "aria-label": "Söhbəti bağla" });
    closeBtn.innerHTML = ICON_X; // sabit, yoxlanmış SVG
    var newBtn = el("button", { class: "close newb", type: "button", "aria-label": L.fresh, title: L.fresh });
    newBtn.innerHTML = ICON_NEW; // sabit, yoxlanmış SVG
    // Üç nöqtə: gecə/gündüz, operatoru qoş və səs bu menyudadır (pəncərənin altından açılır)
    var moreBtn = el("button", { class: "close moreb", type: "button", "aria-label": L.menu, title: L.menu, "aria-haspopup": "dialog", "aria-expanded": "false" });
    moreBtn.innerHTML = ICON_DOTS; // sabit, yoxlanmış SVG
    // Menyu ikonları adla seçilir: innerHTML-ə yalnız sabit SVG yazılır
    function menuIcon(node, name) {
      if (name === "sun") node.innerHTML = ICON_SUN;
      else if (name === "moon") node.innerHTML = ICON_MOON;
      else if (name === "user") node.innerHTML = ICON_USER;
      else if (name === "vol") node.innerHTML = ICON_VOL;
      else node.innerHTML = ICON_MUTE;
    }
    function menuItem(cls) { var b = el("button", { class: "mi " + cls, type: "button" }); var ic = el("span"); var tx = el("span"); b.appendChild(ic); b.appendChild(tx); return { b: b, set: function (name, text) { menuIcon(ic, name); tx.textContent = text; } }; }
    var themeItem = menuItem("mi-theme"), liveItem = menuItem("mi-live"), soundItem = menuItem("mi-sound");
    liveItem.set("user", L.live);
    liveItem.b.hidden = !cfg.live || !!state.live;
    var sheetBg = el("div", { class: "sheet-bg" });
    var sheet = el("div", { class: "sheet", role: "dialog", "aria-label": L.menu, "aria-hidden": "true" }, [el("div", { class: "grab" }), themeItem.b, liveItem.b, soundItem.b]);
    function sheetShow(v) {
      sheet.classList.toggle("on", !!v); sheetBg.classList.toggle("on", !!v);
      sheet.setAttribute("aria-hidden", String(!v)); moreBtn.setAttribute("aria-expanded", String(!!v));
      if (v) { emoShow(false); setTimeout(function () { var f = sheet.querySelector(".mi:not([hidden])"); if (f) f.focus({ preventScroll: true }); }, 30); } // preventScroll: menyu qalxarkən pəncərə sürüşüb titrəməsin
    }
    var sheetOpen = function () { return sheet.classList.contains("on"); };
    moreBtn.addEventListener("click", function () { sheetShow(!sheetOpen()); });
    sheetBg.addEventListener("click", function () { sheetShow(false); });
    // Bot cavabına qısa səs (defolt açıq; ziyarətçinin seçimi yadda qalır). Fayl yüklənmir: WebAudio ilə yaradılır.
    var SOUND_KEY = "ca_sound", actx = null;
    function soundOn() { try { return localStorage.getItem(SOUND_KEY) !== "off"; } catch (e) { return true; } }
    function applySound() { soundItem.set(soundOn() ? "mute" : "vol", soundOn() ? L.soundOff : L.soundOn); }
    function unlockAudio() { // brauzerlər səsi yalnız istifadəçi hərəkətindən sonra icazə verir
      if (actx || !soundOn()) return;
      try { var AC = window.AudioContext || window.webkitAudioContext; if (AC) actx = new AC(); } catch (e) { actx = null; }
    }
    function chime() {
      if (!soundOn() || !actx) return;
      try {
        if (actx.state === "suspended") actx.resume();
        var t0 = actx.currentTime;
        [[880, 0], [1320, 0.09]].forEach(function (n) {
          var o = actx.createOscillator(), g = actx.createGain();
          o.type = "sine"; o.frequency.value = n[0];
          g.gain.setValueAtTime(0.0001, t0 + n[1]); g.gain.exponentialRampToValueAtTime(0.12, t0 + n[1] + 0.015); g.gain.exponentialRampToValueAtTime(0.0001, t0 + n[1] + 0.22);
          o.connect(g); g.connect(actx.destination); o.start(t0 + n[1]); o.stop(t0 + n[1] + 0.24);
        });
      } catch (e) { /* səs vacib deyil */ }
    }
    soundItem.b.addEventListener("click", function () {
      try { localStorage.setItem(SOUND_KEY, soundOn() ? "off" : "on"); } catch (e) { /* yaddaş bağlıdır */ }
      applySound(); unlockAudio(); sheetShow(false);
    });
    applySound();
    // Ziyarətçinin seçimi (düymə) yadda qalır; seçməyibsə panelde təyin olunan açılış rejimi: light / dark / auto (cihaz ayarı)
    var THEME_KEY = "ca_theme";
    var mq = window.matchMedia ? window.matchMedia("(prefers-color-scheme: dark)") : null;
    function chosenTheme() { try { var v = localStorage.getItem(THEME_KEY); return v === "dark" || v === "light" ? v : ""; } catch (e) { return ""; } }
    function effectiveTheme() { return chosenTheme() || (cfg.theme === "dark" ? "dark" : cfg.theme === "auto" && mq && mq.matches ? "dark" : "light"); }
    function applyTheme() {
      var th = effectiveTheme();
      host.setAttribute("data-ca-theme", th);
      themeItem.set(th === "dark" ? "sun" : "moon", th === "dark" ? L.toLight : L.toDark);
    }
    themeItem.b.addEventListener("click", function () {
      try { localStorage.setItem(THEME_KEY, effectiveTheme() === "dark" ? "light" : "dark"); } catch (e) { /* yaddaş bağlıdır */ }
      applyTheme(); sheetShow(false);
    });
    if (mq && mq.addEventListener) mq.addEventListener("change", applyTheme);
    // Şəkilli sual (sayt sahibi panelden açıbsa): şəkil brauzerdə kiçildilir, serverə base64 ilə gedir, heç yerdə saxlanmır
    var fileIn = el("input", { type: "file", accept: "image/png,image/jpeg,image/webp", hidden: "", "aria-label": L.photoAdd });
    var pv = el("div", { class: "pv" }); pv.hidden = true;
    var pending = null; // { b64, url }
    function clearPending() { pending = null; pv.textContent = ""; pv.hidden = true; updateAct(); }
    // Şəkil: AI söhbətində sayt sahibi şəkillə axtarışı açıbsa; operatorla canlı söhbətdə həmişə (operator şəkli görür)
    var canAttach = function () { return state.live ? !!state.live.id && !state.live.creating : cfg.imageSearch === true; };
    var actMode = "";
    function updateAct() { // sancaq <-> göndər
      var has = !!input.value.trim() || !!pending;
      var mode = !has && canAttach() ? "clip" : "send";
      sendBtn.classList.toggle("idle", mode === "send" && !has);
      if (mode === actMode) return;
      actMode = mode;
      sendBtn.type = mode === "clip" ? "button" : "submit";
      sendBtn.className = mode === "clip" ? "ib" : "ib go" + (has ? "" : " idle");
      if (mode === "clip") sendBtn.innerHTML = ICON_CLIP; else sendBtn.innerHTML = ICON_SEND; // sabit, yoxlanmış SVG
      var lbl = mode === "clip" ? L.photoAdd : L.sendL;
      sendBtn.setAttribute("aria-label", lbl); sendBtn.title = lbl;
    }
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
    sendBtn.addEventListener("click", function () { if (actMode === "clip" && !busy) fileIn.click(); });
    fileIn.addEventListener("change", function () {
      var f = fileIn.files && fileIn.files[0]; fileIn.value = "";
      if (!f) return;
      shrinkImage(f).then(function (r) {
        pending = r; pv.textContent = "";
        var thumb = el("img", { src: r.url, alt: "" });
        var del = el("button", { type: "button", text: L.photoDel });
        del.addEventListener("click", clearPending);
        pv.appendChild(thumb); pv.appendChild(del); pv.hidden = false; updateAct();
      }).catch(function () { bubble("error", L.photoBad); scroll(); });
    });
    var form = el("form", null, [emo, fileIn, el("div", { class: "ibox" }, [input, emojiBtn, sendBtn])]);
    // Loqo yalnız bizim portaldan gələn https ünvandır; yüklənməsə sakitcə gizlənir (başlıqda) və ya standart ikonaya qayıdır (düymədə)
    var logoUrl = typeof cfg.logo === "string" && /^https?:\/\//i.test(cfg.logo) ? cfg.logo : "";
    // Profil şəkli (başlıq və bot mesajları) loqodan ayrıdır; yoxdursa və ya yüklənməsə robot ikonu
    var avatarUrl = typeof cfg.avatar === "string" && /^https?:\/\//i.test(cfg.avatar) ? cfg.avatar : "";
    var avatarOk = !!avatarUrl;
    function avatarInto(box) {
      if (avatarOk) {
        var im = el("img", { src: avatarUrl, alt: "", referrerpolicy: "no-referrer" });
        im.addEventListener("error", function () { avatarOk = false; box.innerHTML = ICON_BOT; }); // sabit SVG
        box.appendChild(im);
      } else box.innerHTML = ICON_BOT; // sabit, yoxlanmış SVG
      return box;
    }
    var headAvatar = avatarInto(el("span", { class: "hav", "aria-hidden": "true" }));
    var botName = typeof cfg.botName === "string" ? cfg.botName.slice(0, 40) : "";
    var headSub = el("span", { class: "hsub" });
    // Başlıq altı: AI danışırsa "[AI] Aysel" (ad yoxdursa "AI köməkçi"), operator qoşulubsa onun adı və şəkli (bot insan kimi göstərilmir)
    function opPhoto(op) { return op && typeof op.photo === "string" && /^https?:\/\//i.test(op.photo) ? op.photo : ""; }
    function opInto(box, op) {
      var url = opPhoto(op);
      if (url) {
        var im = el("img", { src: url, alt: "", referrerpolicy: "no-referrer" });
        im.addEventListener("error", function () { box.innerHTML = ICON_USER; }); // sabit SVG
        box.appendChild(im);
      } else box.innerHTML = ICON_USER; // sabit SVG
      return box;
    }
    function updateHead() {
      var op = state.live && state.live.op;
      headSub.textContent = "";
      headAvatar.textContent = "";
      if (state.live) {
        headSub.textContent = op && op.name ? op.name + " · " + L.op : L.op;
        if (op) opInto(headAvatar, op); else avatarInto(headAvatar);
      } else {
        if (botName) { headSub.appendChild(el("b", { text: "AI" })); headSub.appendChild(document.createTextNode(botName)); }
        else headSub.textContent = L.aiBadge;
        avatarInto(headAvatar);
      }
    }
    function botAv() { return avatarInto(el("span", { class: "av", "aria-hidden": "true" })); }
    function opAv(op) { return opInto(el("span", { class: "av op", "aria-hidden": "true" }), op); }
    var brandEl = null;
    if (cfg.brand && typeof cfg.brand.name === "string" && cfg.brand.name) {
      brandEl = el("div", { class: "brand" }, [el("span", { text: L.poweredBy + " " })]);
      brandEl.appendChild(isUrl(cfg.brand.url) ? el("a", { href: cfg.brand.url, target: "_blank", rel: "noopener noreferrer", text: cfg.brand.name }) : el("span", { text: cfg.brand.name }));
    }
    var panel = el("div", { class: "panel", role: "dialog", "aria-label": cfg.title || "Çat" }, [
      el("div", { class: "head" }, [headAvatar, el("div", { class: "htx" }, [el("h2", { text: cfg.title || "Çat" }), headSub]), newBtn, moreBtn, closeBtn]), log, pv, form,
    ].concat(brandEl ? [brandEl] : [], [sheetBg, sheet]));
    updateHead();
    var launcher = el("button", { class: "launcher", type: "button", "aria-label": "Çatı aç", "aria-expanded": "false" });
    launcher.innerHTML = ICON_CHAT;
    var fx = cfg.effects || {};
    if (fx.pulse) launcher.classList.add("fx-pulse");
    if (fx.bounce) launcher.classList.add("fx-bounce");
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
    // Vaxt (1:18) və gün (18 Oktyabr): brauzerin dil ayarından asılı olmasın deyə özümüz formatlayırıq
    var lastDay = "";
    function hm(t) { var d = new Date(t); return d.getHours() + ":" + ("0" + d.getMinutes()).slice(-2); }
    function dayLabel(t) {
      var d = new Date(t), m = L.months[d.getMonth()], y = d.getFullYear() !== new Date().getFullYear() ? " " + d.getFullYear() : "";
      return L === T_EN ? m + " " + d.getDate() + y : d.getDate() + " " + m + y;
    }
    function maybeDay(t) {
      if (!t) return;
      var d = new Date(t), k = d.getFullYear() + "-" + d.getMonth() + "-" + d.getDate();
      if (k === lastDay) return;
      lastDay = k;
      log.appendChild(el("div", { class: "day", text: dayLabel(t) }));
    }
    // Mesaj sətri: [profil şəkli] balon [vaxt] (bot) və ya [vaxt] balon (istifadəçi)
    function row(side, b, t, av) {
      var kids = side === "mu" ? [t ? el("span", { class: "tm", text: hm(t) }) : null, b] : [av, b, t ? el("span", { class: "tm", text: hm(t) }) : null];
      var r = el("div", { class: "mrow " + side }, kids);
      if (t) r.addEventListener("click", function (e) { if (!e.target.closest || !e.target.closest("a,button")) r.classList.toggle("show"); }); // telefonda toxunanda
      log.appendChild(r);
      return r;
    }
    function bubble(role, text, imgUrl, hadImg, t) {
      var b = el("div", { class: "msg " + role });
      if (role === "model") renderText(b, text);
      else {
        if (imgUrl) b.appendChild(el("img", { class: "up", src: imgUrl, alt: "" }));
        else if (hadImg) b.appendChild(el("span", { class: "upl", text: L.photoSent }));
        if (text) b.appendChild(document.createTextNode(text));
      }
      if (role === "model") return row("mb", b, t, botAv());
      if (role === "user") return row("mu", b, t);
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
        var cardEl = isUrl(l.url) ? el("a", linkAttrs(l.url, { class: "card" }), kids) : el("div", { class: "card" }, kids);
        // Klik sayğacı (hesabat üçün): məzmun göndərilmir, sorğu sadədir (preflight yoxdur)
        if (isUrl(l.url)) cardEl.addEventListener("click", function () { var ev = { item_name: String(l.title).slice(0, 100) }; if (typeof l.price === "number") { ev.value = l.price; ev.currency = String(l.currency || "").slice(0, 3); } track("ai_chat_listing_click", ev); try { fetch(api + "/click", { method: "POST", keepalive: true, headers: { "content-type": "application/json" }, body: JSON.stringify({ sid: state.sid || undefined, id: l.id, title: String(l.title || "").slice(0, 120) }) }).catch(function () { /* vacib deyil */ }); } catch (e) { /* vacib deyil */ } });
        wrap.appendChild(cardEl);
      });
      log.appendChild(wrap);
    }
    function sources(list) {
      var items = (list || []).filter(function (s) { return s && s.title; }).slice(0, 3);
      if (!items.length) return;
      var wrap = el("div", { class: "srcs" }, [el("span", { text: L.src })]);
      items.forEach(function (s) {
        wrap.appendChild(isUrl(s.url) ? el("a", linkAttrs(s.url, { text: s.title })) : el("span", { text: s.title }));
      });
      log.appendChild(wrap);
    }
    // Cavab tapılmayanda: "Operatorla əlaqə" düyməsi -> kiçik forma (gizli bal tələsi sahəsi ilə)
    function contactBox(question, reason) {
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
            body: JSON.stringify({ name: nameI.value, contact: contI.value, question: question, reason: reason || undefined, chat: state.messages.filter(function (m) { return !m.live; }).slice(-8).map(function (m) { return { role: m.role, text: String(m.text || "").slice(0, 600) }; }), website: hp.value, page: { path: location.pathname, title: document.title } }),
          }).then(function (res) { return res.json().catch(function () { return {}; }).then(function (d) { return { ok: res.ok, status: res.status, data: d }; }); })
            .then(function (r) {
              if (r.ok) { f.remove(); bubble("model", L.ok, null, null, Date.now()); scroll(); track("ai_chat_lead", { source: "contact_form" }); return; }
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
    // Əməliyyat təsdiqi: AI heç nəyi özü icra etmir; ziyarətçi kartı görüb "Təsdiq et" deməlidir. Parametrləri server saxlayır, burada dəyişdirilə bilməz.
    function actionCard(m) {
      var c = m.confirm;
      if (!c) return;
      var last = state.messages[state.messages.length - 1] === m;
      var box = el("div", { class: "acard" + (c.res ? " done" : "") });
      var head = [el("b", { text: c.title })];
      if (c.summary) head.push(el("div", { text: c.summary }));
      if (c.details.length) { var dl = el("div", { class: "ad" }); c.details.forEach(function (d) { dl.appendChild(el("span", { text: d.k })); dl.appendChild(el("span", { text: d.v })); }); head.push(dl); }
      head.forEach(function (n) { box.appendChild(n); });
      if (c.res) { box.appendChild(el("div", { text: c.res.message })); log.appendChild(box); return; }
      if (!last || Date.now() > c.exp) { box.classList.add("done"); box.appendChild(el("div", { text: L.actExpired })); log.appendChild(box); return; }
      var err = el("div", { class: "err" });
      var yes = el("button", { class: "go", type: "button", text: L.actYes });
      var no = el("button", { type: "button", text: L.cancel });
      box.appendChild(err); box.appendChild(el("div", { class: "row" }, [no, yes]));
      log.appendChild(box);
      function decide(decision) {
        yes.disabled = no.disabled = true; err.textContent = ""; if (decision === "confirm") yes.textContent = L.actWait;
        fetch(api + "/action-confirm", {
          method: "POST", headers: { "content-type": "application/json" },
          body: JSON.stringify({ id: c.id, decision: decision, sid: state.sid, identity: idToken || undefined, vid: visitorId() }),
        }).then(function (res) { return res.json().catch(function () { return {}; }).then(function (d) { return { ok: res.ok, data: d }; }); })
          .then(function (r) {
            if (!r.ok) { yes.textContent = L.actYes; yes.disabled = no.disabled = false; err.textContent = (r.data && r.data.error) || L.actFail; return; }
            c.res = { status: String(r.data.status || ""), message: String(r.data.message || L.actUnknown) };
            track("ai_chat_action", { action_title: String(c.title).slice(0, 60), status: c.res.status });
            save(); render();
          }).catch(function () {
            // Sorğu serverə çatmış ola bilər: nəticə bəlli deyil, təkrar göndərilmir
            c.res = { status: "unknown", message: L.actUnknown }; save(); render();
          });
      }
      yes.addEventListener("click", function () { decide("confirm"); });
      no.addEventListener("click", function () { decide("cancel"); });
    }
    function extras(m, question) {
      cards(m.listings); sources(m.sources); actionCard(m); feedbackRow(m, question);
      if (m.unanswered) { contactBox(question, m.handoffReason); liveBox(); }
    }

    // ---------- canlı operator söhbəti ----------
    function note(text, withBack) {
      var kids = [el("span", { text: text })];
      if (withBack) {
        var back = el("button", { type: "button", text: L.liveBack });
        back.addEventListener("click", function () { leaveLive(); state.live = null; save(); updateLiveUi(); render(); input.focus(); });
        kids.push(back);
      }
      log.appendChild(el("div", { class: withBack ? "note back" : "note" }, kids));
    }
    function liveBubble(role, text, t, withFile, opFile, op) {
      if (role === "system") return note(L.liveEnd, false);
      maybeDay(t);
      if (role === "operator") {
        var b = el("div", { class: "msg operator" }, [el("div", { class: "who", text: op && op.name ? op.name : L.op })]);
        if (opFile && opFile.id) {
          b.appendChild(opFileEl(opFile));
          if (text === "📷" || text === "📄 " + opFile.name) text = ""; // yalnız işarə idi
        }
        if (text) b.appendChild(el("div", { text: text }));
        return row("mb", b, t, opAv(op));
      }
      // Şəkil: bu tabda yenicə göndərilibsə önizləmə, yoxsa "Şəkil göndərildi" qeydi. Şəkilsiz mətn "📷" yalnız işarədir, göstərilmir.
      var url = withFile && sentShot ? sentShot : null;
      if (withFile) sentShot = "";
      bubble("user", withFile && text === "📷" ? "" : text, url, withFile, t);
    }
    // Operatorun faylı: söhbətin tokeni ilə POST edilir (token linkdə görünmür), blob kimi göstərilir
    var fileUrls = {};
    function loadOpFile(f) {
      if (fileUrls[f.id]) return Promise.resolve(fileUrls[f.id]);
      var lv = state.live;
      if (!lv || !lv.id) return Promise.reject(new Error("no live"));
      return fetch(api + "/live/" + lv.id + "/file", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token: lv.token, fid: f.id }) })
        .then(function (res) { if (!res.ok) throw new Error("file"); return res.blob(); })
        .then(function (bl) { fileUrls[f.id] = URL.createObjectURL(bl); return fileUrls[f.id]; });
    }
    function opFileEl(f) {
      var isImg = /^image\//.test(f.mime);
      if (isImg) {
        var img = el("img", { class: "up", alt: "" });
        loadOpFile(f).then(function (u) { img.src = u; }).catch(function () { img.remove(); });
        var a = el("a", { href: "#", class: "opimg" }, [img]);
        a.addEventListener("click", function (e) { e.preventDefault(); loadOpFile(f).then(function (u) { window.open(u, "_blank", "noopener"); }).catch(function () {}); });
        return a;
      }
      var link = el("a", { href: "#", class: "opfile", text: "📄 " + (f.name || "PDF") });
      link.addEventListener("click", function (e) {
        e.preventDefault();
        loadOpFile(f).then(function (u) { var x = document.createElement("a"); x.href = u; x.download = f.name || "fayl.pdf"; x.rel = "noopener"; document.body.appendChild(x); x.click(); x.remove(); }).catch(function () {});
      });
      return link;
    }
    function liveBox() {
      if (!cfg.live || state.live) return;
      var b = el("button", { class: "cbtn livecbtn", type: "button", text: L.live });
      b.addEventListener("click", function () { b.remove(); startLive(); });
      log.appendChild(b);
    }
    function updateLiveUi() {
      updateHead();
      liveItem.b.hidden = !cfg.live || !!state.live;
      input.placeholder = state.live ? L.livePh : L.ph;
      updateAct();
    }
    // Operator cavab yazanda ziyarətçi çatda deyilsə cavab bu e-poçta gedəcək (ixtiyari)
    function mailRow() {
      var inp = el("input", { type: "email", maxlength: "120", placeholder: L.liveMailPh, "aria-label": L.liveMailPh, autocomplete: "email" });
      inp.value = (state.live && state.live.email) || "";
      inp.addEventListener("input", function () { if (state.live) state.live.email = inp.value; });
      log.appendChild(el("div", { class: "mailrow" }, [inp, el("div", { class: "hint2", text: L.liveMailHint })]));
    }
    // "Operatorla yaz" basılan kimi söhbət serverdə açılır: panel operatora dərhal göstərir (əvvəl ilk mesaja qədər heç nə görünmürdü).
    // pending = ziyarətçi hələ yazmayıb ("AI-a qayıt" mümkündür); creating = söhbət yaradılır.
    function startLive(handoff) {
      if (state.live) return;
      state.live = { pending: true, creating: true, after: 0 };
      Array.prototype.forEach.call(log.querySelectorAll(".livecbtn"), function (n) { n.remove(); });
      save(); updateLiveUi();
      note(L.liveStart, true); mailRow(); scroll(); input.focus();
      var ai = state.messages.filter(function (m) { return !m.live; }).slice(-10).map(function (m) { return { role: m.role, text: String(m.text || "").slice(0, 600) }; });
      fetch(api + "/live", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ chat: ai, handoff: handoff || undefined, vid: visitorId(), page: { path: location.pathname, title: document.title }, tz: visTz(), first: visit.first, visits: visit.visits, lang: (navigator.language || "").slice(0, 12), mobile: mobile.matches }),
      }).then(function (res) { return res.json().catch(function () { return {}; }).then(function (d) { return { ok: res.ok, d: d }; }); })
        .then(function (r) {
          var lv = state.live;
          if (!lv || !lv.creating) { if (r.ok && r.d.id) leaveLive({ id: r.d.id, token: r.d.token }); return; } // arada "AI-a qayıt" basılıb
          if (!r.ok) throw new Error(r.d.code || "start");
          state.live = { id: r.d.id, token: r.d.token, after: 0, pending: true, t: Date.now(), seen: 0, email: lv.email };
          track("ai_chat_live_start", { source: "visitor" }); presenceSoon();
          save(); applyLive(r.d); wsOpen(); schedulePoll();
        })
        .catch(function (e) {
          if (!state.live || !state.live.creating) return;
          state.live = null; save(); updateLiveUi();
          Array.prototype.forEach.call(log.querySelectorAll(".note.back, .mailrow"), function (n) { n.remove(); });
          bubble("error", e && e.message === "OUTSIDE_HOURS" ? L.liveWait : L.liveFail); contactBox(""); scroll();
        });
    }
    // Ziyarətçi canlı söhbətdən çıxdı ("Yeni söhbət", "AI-a qayıt"): serverdə bağlanır ki, operator boşuna gözləməsin
    function leaveLive(lv) {
      lv = lv || state.live;
      if (!lv || !lv.id || !lv.token) return;
      try { fetch(api + "/live/" + lv.id + "/leave", { method: "POST", keepalive: true, headers: { "content-type": "application/json" }, body: JSON.stringify({ token: lv.token }) }).catch(function () { /* vacib deyil */ }); } catch (e) { /* köhnə brauzer */ }
      try { localStorage.removeItem(LIVE_KEY); } catch (e) { /* məxfi rejim */ }
    }
    liveItem.b.addEventListener("click", function () { sheetShow(false); startLive(); });
    function render() {
      newBtn.hidden = state.messages.length === 0 && !state.live;
      log.textContent = ""; lastDay = "";
      var firstT = (state.messages.filter(function (m) { return m.t; })[0] || {}).t;
      maybeDay(firstT || Date.now()); // gün söhbətin lap əvvəlində, ortada
      bubble("model", cfg.greeting || "");
      var q = "";
      state.messages.forEach(function (m) {
        if (m.joined) return note(m.text, false);
        if (m.live) return liveBubble(m.role, m.text, m.t, m.img === true, m.file, m.op);
        maybeDay(m.t);
        bubble(m.role, m.text, null, m.img, m.t); if (m.role === "user") q = m.text; else extras(m, q);
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
      if (!state.live || !state.live.id) return;
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
      if (ws || !window.WebSocket || !state.live || !state.live.id) return;
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
    // Söhbət bitəndən sonra 1-5 ulduz qiyməti (yalnız operator cavab veribsə)
    function csatBox(id, token) {
      var box = el("div", { class: "csat" }, [el("div", { text: L.csatQ })]);
      var row = el("div", { class: "stars" });
      for (var i = 1; i <= 5; i++) (function (n) {
        var b = el("button", { type: "button", "aria-label": String(n), text: "\u2605" });
        b.addEventListener("click", function () {
          Array.prototype.forEach.call(row.children, function (x) { x.disabled = true; });
          fetch(api + "/live/" + id + "/csat", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token: token, rating: n }) }).catch(function () { /* qiymət vacib deyil */ });
          box.textContent = ""; box.appendChild(el("div", { text: L.thanks }));
        });
        row.appendChild(b);
      })(i);
      box.appendChild(row); log.appendChild(box);
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
        var at = Date.parse(m.at) || Date.now();
        var withFile = role === "user" && m.file === true;
        // Operatorun faylı: { id, mime, name } (baytlar tokenlə ayrıca yüklənir)
        var opFile = role === "operator" && m.file && typeof m.file.id === "string" ? { id: m.file.id, mime: String(m.file.mime || ""), name: String(m.file.name || "") } : null;
        var op = role === "operator" && m.op && typeof m.op.name === "string" ? { name: m.op.name.slice(0, 40), photo: opPhoto(m.op) || undefined } : null;
        // Yeni operator qoşuldu (və ya söhbəti başqası götürdü): "Leyla söhbətə qoşuldu"
        if (op && state.live && (!state.live.op || state.live.op.name !== op.name)) {
          state.live.op = op; updateHead();
          state.messages.push({ role: "model", live: true, joined: true, text: L.joined.replace("{n}", op.name), t: at });
          note(L.joined.replace("{n}", op.name), false);
        }
        state.messages.push({ role: role, text: text, live: true, t: at, img: withFile || undefined, file: opFile || undefined, op: op || undefined });
        liveBubble(role, text, at, withFile, opFile, op);
        if (role === "operator") gotOperator = true;
      });
      if (gotOperator) chime();
      if (gotOperator && state.live && state.live.pending) { state.live.pending = false; Array.prototype.forEach.call(log.querySelectorAll(".note.back, .mailrow"), function (n) { n.remove(); }); }
      if (gotOperator) {
        clearTimeout(noReplyTimer);
        if (!state.open && state.live && d.total > (state.live.seen || 0)) launcher.classList.add("dot"); // yalnız oxunmamış cavab
      }
      if (state.live) { state.live.after = d.total; if (state.open) state.live.seen = d.total; }
      if (d.status === "closed") {
        var lv0 = state.live;
        if (lv0 && lv0.id && cfg.csat !== false && state.messages.some(function (m) { return m.live && m.role === "operator"; })) csatBox(lv0.id, lv0.token);
        dropLive();
      } else save();
      newBtn.hidden = false;
      scroll();
    }
    // Mesajı göndərir (varsa) və yeni mesajları gətirir. Qaytarır: uğurlu olub-olmadığı.
    function liveCall(text, img) {
      var lv = state.live;
      if (!lv || !lv.id) return Promise.resolve(false);
      return fetch(api + "/live/" + lv.id + "/sync", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ token: lv.token, after: lv.after || 0, text: text || undefined, image: img || undefined, contact: text && lv.pending && lv.email ? String(lv.email).trim() : undefined }),
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
    var sentShot = ""; // göndərilən şəklin önizləməsi: serverdən qayıdan mesajda dərhal göstərilir
    function liveSubmit(text, shot) {
      proChatted();
      if (liveBusy) return;
      var mail = state.live && state.live.pending ? String(state.live.email || "").trim() : "";
      if (mail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(mail)) { bubble("error", L.bad); scroll(); return; }
      if (state.live && state.live.creating) return; // söhbət hələ yaradılır (bir an)
      liveBusy = true; sendBtn.disabled = true;
      var lv = state.live, hadOperator = state.messages.some(function (m) { return m.live && m.role === "operator"; });
      var go;
      if (lv.pending && !lv.id) { // köhnə yol (söhbət hələ yaradılmayıbsa): ilk mesajla birlikdə açılır
        var ai = state.messages.filter(function (m) { return !m.live; }).slice(-10).map(function (m) { return { role: m.role, text: String(m.text || "").slice(0, 600) }; });
        go = fetch(api + "/live", {
          method: "POST", headers: { "content-type": "application/json" },
          body: JSON.stringify({ message: text, chat: ai, vid: visitorId(), contact: mail || undefined, page: { path: location.pathname, title: document.title }, tz: visTz(), first: visit.first, visits: visit.visits, lang: (navigator.language || "").slice(0, 12), mobile: mobile.matches }),
        }).then(function (res) { return res.json().catch(function () { return {}; }).then(function (d) { return { ok: res.ok, d: d }; }); })
          .then(function (r) {
            if (!r.ok) throw new Error(r.d.code || "start");
            state.live = { id: r.d.id, token: r.d.token, after: 0, pending: false, t: Date.now(), seen: 0 };
            track("ai_chat_live_start", { source: "visitor" }); presenceSoon();
            Array.prototype.forEach.call(log.querySelectorAll(".note.back, .mailrow"), function (n) { n.remove(); }); // "AI-a qayıt" artıq mümkün deyil
            applyLive(r.d); wsOpen(); return true;
          });
      } else {
        if (shot) sentShot = shot.url;
        go = liveCall(text, shot ? shot.b64 : null).then(function (ok) {
          if (ok && state.live && state.live.pending) { state.live.pending = false; save(); Array.prototype.forEach.call(log.querySelectorAll(".note.back, .mailrow"), function (n) { n.remove(); }); }
          return ok;
        });
      }
      go.then(function (ok) {
        if (ok) { input.value = ""; clearPending(); grow(); schedulePoll(); if (!hadOperator) { clearTimeout(noReplyTimer); noReplyTimer = setTimeout(function () { note(L.liveWait, false); contactBox(text); scroll(); }, 90000); } }
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
      if (state.open) proHide(); else { sheetShow(false); emoShow(false); }
      if (state.open && state.live && state.live.after) state.live.seen = state.live.after;
      panel.classList.toggle("open", state.open);
      launcher.setAttribute("aria-expanded", String(state.open));
      launcher.setAttribute("aria-label", state.open ? "Çatı bağla" : "Çatı aç");
      layout();
      save();
      if (state.open) { launcher.classList.remove("dot"); scroll(); setTimeout(function () { input.focus(); }, 0); schedulePoll(); if (!opened) { opened = true; track("ai_chat_open", { page_path: location.pathname }); } }
      presenceSoon();
    }
    launcher.addEventListener("click", function () { setOpen(!state.open); });
    // Telefonda çat tam ekrandır: saytın öz linkinə keçəndə yeni səhifədə bağlı açılsın ki, elan görünsün.
    // Yazışma yerində qalır, düyməyə basanda davam edir. Kompüterdə açıq qalır (elanın yanında).
    panel.addEventListener("click", function (e) {
      var a = e.target && e.target.closest ? e.target.closest("a[href]") : null;
      if (!a || a.target === "_blank" || e.defaultPrevented || e.ctrlKey || e.metaKey || e.shiftKey || e.button) return;
      if (mobile.matches) setOpen(false);
    });
    if (hint) hint.addEventListener("click", function () { setOpen(true); });
    closeBtn.addEventListener("click", function () { setOpen(false); launcher.focus(); });
    // Yeni söhbət: yalnız ziyarətçinin brauzerindəki söhbət silinir (sayt sahibinin panelindəki qeydlərə toxunmur)
    newBtn.addEventListener("click", function () {
      gen++; if (curCtrl) { try { curCtrl.abort(); } catch (e) { /* artıq bitib */ } }
      busy = false; sendBtn.disabled = false;
      clearTimeout(pollTimer); clearTimeout(noReplyTimer); wsClose();
      leaveLive(); // operatorla söhbət gedirdisə serverdə bağlanır (əvvəl panel söhbəti açıq göstərirdi, ziyarətçiyə isə AI cavab verirdi)
      state.messages = []; state.live = null; state.sid = ""; save();
      input.value = ""; grow();
      render(); input.focus();
    });
    root.addEventListener("keydown", function (e) {
      if (e.key !== "Escape" || !state.open) return;
      if (sheetOpen()) { sheetShow(false); moreBtn.focus(); return; }
      if (!emo.hidden) { emoShow(false); input.focus(); return; }
      setOpen(false); launcher.focus();
    });
    // Emoji pəncərəsi kənara toxunanda bağlanır
    root.addEventListener("click", function (e) { if (emo.hidden) return; var path = e.composedPath ? e.composedPath() : []; if (path.indexOf(emo) < 0 && path.indexOf(emojiBtn) < 0) emoShow(false); });
    root.addEventListener("pointerdown", unlockAudio);

    var busy = false, gen = 0, curCtrl = null;
    function grow() { input.style.height = "auto"; var h = input.scrollHeight + (input.offsetHeight - input.clientHeight); input.style.height = Math.min(h, 96) + "px"; input.style.overflowY = h > 96 ? "auto" : "hidden"; updateAct(); scheduleDraft(); }
    input.addEventListener("input", grow);
    // Canlı operator söhbətində yazılan mətn operatora canlı görünür ("yazır…" ilə birlikdə), 0.6 saniyədə bir. AI söhbətində heç nə getmir.
    var draftTimer = null, draftSent = "";
    function scheduleDraft() {
      if (!(wsOk && ws && state.live && state.live.id) || draftTimer) return;
      var wait = Math.max(0, 600 - (Date.now() - typingSentAt));
      draftTimer = setTimeout(function () {
        draftTimer = null;
        if (!(wsOk && ws && state.live && state.live.id)) return;
        var v = input.value.slice(0, 300);
        if (v === draftSent) return;
        draftSent = v; typingSentAt = Date.now();
        try { ws.send(JSON.stringify({ t: "draft", text: v })); } catch (e) { /* bağlanır */ }
      }, wait);
    }
    input.addEventListener("keydown", function (e) {
      if (e.key === "Enter" && !e.shiftKey && !e.isComposing) { e.preventDefault(); form.requestSubmit(); }
    });

    form.addEventListener("submit", function (e) {
      e.preventDefault();
      var text = input.value.trim();
      var shot = state.live && !canAttach() ? null : pending;
      if ((!text && !shot) || busy) return;
      if (state.live) return liveSubmit(text, shot);
      // Köməkçinin cavabları serverin imzası (sig) ilə qayıdır: imzasız/dəyişdirilmiş cavab server tərəfindən atılır
      var history = state.messages.filter(function (m) { return !m.live; }).slice(-10).map(function (m) { return m.role === "model" ? { role: "model", text: m.text, sig: m.sig } : { role: m.role, text: m.text + (m.note ? " [şəkil: " + m.note + "]" : (m.img && !m.text ? " [şəkil]" : "")) }; });
      if (!state.sid) state.sid = newId(); // bir söhbət = bir identifikator (sayt sahibi tarixçədə qruplaşdırılmış görür)
      var userMsg = { role: "user", text: text, t: Date.now() };
      unlockAudio(); emoShow(false);
      track("ai_chat_message", { has_image: !!shot });
      proChatted();
      if (shot) userMsg.img = true; // şəklin özü saxlanmır, yalnız "göndərilib" qeydi
      state.messages.push(userMsg);
      newBtn.hidden = false;
      save();
      maybeDay(userMsg.t);
      bubble("user", text, shot ? shot.url : null, null, userMsg.t);
      input.value = ""; grow(); clearPending();
      busy = true; sendBtn.disabled = true;
      var typing = row("mb", el("div", { class: "typing", "aria-label": "Cavab yazılır" }, [el("i"), el("i"), el("i")]), 0, botAv());
      scroll();

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
        // Ziyarətçi "operatora qoş" yazıb və operator işləyir: AI cavabı yox, canlı söhbət açılır
        if (r.data.handoff === "live" && cfg.live) { save(); startLive(typeof r.data.handoffReason === "string" ? { reason: r.data.handoffReason, note: typeof r.data.handoffNote === "string" ? r.data.handoffNote : "" } : null); return; }
        var answer = String(r.data.answer || "");
        var msg = { role: "model", text: answer, t: Date.now(), listings: r.data.listings || [], sources: r.data.sources || [], unanswered: r.data.unanswered === true };
        if (typeof r.data.handoffReason === "string") msg.handoffReason = r.data.handoffReason.slice(0, 20);
        if (typeof r.data.sig === "string") msg.sig = r.data.sig.slice(0, 64);
        var cf = r.data.confirm;
        if (cf && typeof cf.id === "string" && /^[0-9a-f]{32}$/.test(cf.id) && typeof cf.title === "string") {
          msg.confirm = { id: cf.id, title: String(cf.title).slice(0, 60), summary: String(cf.summary || "").slice(0, 300),
            details: (Array.isArray(cf.details) ? cf.details : []).slice(0, 8).map(function (d) { return { k: String(d.k || "").slice(0, 40), v: String(d.v || "").slice(0, 120) }; }),
            exp: Date.now() + Math.min(Number(cf.expiresInS) || 600, 3600) * 1000 - 5000 };
        }
        state.messages.push(msg);
        save();
        maybeDay(msg.t); bubble("model", answer, null, null, msg.t); extras(msg, text); chime();
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
    if (state.live && state.live.creating) { state.live = null; save(); } // yaradılarkən səhifə yeniləndi
    render();
    document.body.appendChild(host);
    setOpen(state.open);
    if (state.live && state.live.id) { liveCall("").then(schedulePoll, schedulePoll); wsOpen(); } // yenilənəndən sonra canlı söhbət davam edir

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

    // ---------- "saytda kim var": operator ziyarətçini görür və özü ilk yaza bilər ----------
    // Yalnız canlı söhbət açıqdırsa, yalnız görünən tabda, 15 saniyədən bir. Göndərilən: təsadüfi ziyarətçi ID-si, səhifə yolu/başlığı,
    // gəldiyi saytın adı (referrer domeni), dil, telefon/kompüter. Mesaj mətni və şəxsi məlumat göndərilmir.
    var presTimer = null, presBusy = false, presSoonT = null;
    function chatState() { return state.live && state.live.id ? "live" : state.messages.length ? "ai" : "none"; }
    function presenceBeat() {
      clearTimeout(presTimer);
      if (!cfg.presence || !shown) return;
      presTimer = setTimeout(presenceBeat, 15000);
      // Vərəq gizlidirsə (ziyarətçi başqa vərəqə keçib) daha seyrək xəbər veririk, amma siyahıdan düşmürük:
      // əks halda AI ilə yazışan ziyarətçi başqa vərəqə keçən kimi paneldən itirdi
      if (presBusy || (document.hidden && Date.now() - presLast < 30000)) return;
      presBusy = true; presLast = Date.now();
      fetch(api + "/presence", {
        method: "POST", headers: { "content-type": "application/json" }, keepalive: true,
        body: JSON.stringify({ vid: visitorId(), path: location.pathname, title: document.title, ref: document.referrer || "", lang: (navigator.language || "").slice(0, 12), mobile: mobile.matches, chat: chatState(), sid: state.sid || undefined, hidden: document.hidden || undefined, tz: visTz(), first: visit.first, visits: visit.visits }),
      }).then(function (res) { return res.ok ? res.json() : {}; })
        .then(function (d) { if (d && d.invite && typeof d.invite.id === "string" && typeof d.invite.token === "string") acceptInvite(d.invite); })
        .catch(function () { /* növbəti dəfə */ })
        .then(function () { presBusy = false; });
    }
    var presLast = 0;
    function presenceSoon() { clearTimeout(presSoonT); presSoonT = setTimeout(presenceBeat, 400); }
    document.addEventListener("visibilitychange", function () { if (!document.hidden) presenceSoon(); });
    // Operator ziyarətçiyə ilk yazıb: canlı söhbət bu brauzerdə açılır, operatorun mesajı balonda göstərilir
    function acceptInvite(inv) {
      if (state.live && state.live.id) return;
      state.live = { id: inv.id, token: inv.token, after: 0, pending: false, t: Date.now(), seen: 0 };
      Array.prototype.forEach.call(log.querySelectorAll(".livecbtn, .note.back, .mailrow"), function (n) { n.remove(); });
      save(); updateLiveUi(); newBtn.hidden = false;
      track("ai_chat_live_start", { source: "operator" }); presenceSoon(); // panel "Operatorla" statusunu dərhal görsün
      liveCall("").then(function () {
        schedulePoll(); wsOpen();
        if (state.open) return;
        var op = null;
        for (var i = state.messages.length - 1; i >= 0; i--) if (state.messages[i].live && state.messages[i].role === "operator") { op = state.messages[i]; break; }
        if (op) invitePop(op.text);
      }).catch(function () { /* polling sonra gətirəcək */ });
    }
    function invitePop(text) {
      proHide();
      var t = el("button", { class: "prot", type: "button" }, [el("span", { class: "who", text: L.op }), el("span", { text: String(text).slice(0, 140) })]);
      var x = el("button", { class: "prox", type: "button", "aria-label": L.proClose, text: "\u00d7" });
      proEl = el("div", { class: "pro", role: "status" }, [t, x]);
      root.appendChild(proEl);
      t.addEventListener("click", function () { proHide(); setOpen(true); });
      x.addEventListener("click", function () { proHide(); });
    }

    // ---------- kampaniyalar (proaktiv mesajlar): ziyarətçi yazmadan, şərtə görə kart və ya balon ----------
    var proRules = Array.isArray(cfg.proactive) ? cfg.proactive : [];
    var proEl = null, proTimers = [], PRO_KEY = STORE + "_pro", PRO_ONCE = STORE + "_pro1", PRO_CHAT = STORE + "_proc";
    function proMem() { try { return JSON.parse(sessionStorage.getItem(PRO_KEY) || "{}") || {}; } catch (e) { return {}; } }
    function proOnce() { try { return JSON.parse(localStorage.getItem(PRO_ONCE) || "{}") || {}; } catch (e) { return {}; } }
    function proMark(id, once) {
      try { var m = proMem(); m[id] = Date.now(); sessionStorage.setItem(PRO_KEY, JSON.stringify(m)); } catch (e) { /* məxfi rejim */ }
      if (once) try { var o = proOnce(); o[id] = Date.now(); localStorage.setItem(PRO_ONCE, JSON.stringify(o)); } catch (e) { /* məxfi rejim */ }
    }
    function proStat(id, ev) {
      if (!/^[a-f0-9]{8}$/.test(String(id))) return;
      try { fetch(api + "/campaign", { method: "POST", keepalive: true, headers: { "content-type": "application/json" }, body: JSON.stringify({ id: id, ev: ev }) }).catch(function () { /* vacib deyil */ }); } catch (e) { /* vacib deyil */ }
    }
    // Kampaniya kliklənibsə, ziyarətçinin ilk mesajı "söhbətə çevrildi" kimi bir dəfə sayılır
    function proEngaged(id) { try { sessionStorage.setItem(PRO_CHAT, id); } catch (e) { /* məxfi rejim */ } }
    function proChatted() { try { var id = sessionStorage.getItem(PRO_CHAT); if (id) { sessionStorage.removeItem(PRO_CHAT); proStat(id, "chat"); } } catch (e) { /* məxfi rejim */ } }
    function proFits(r) {
      if (r.audience === "new" && visit.visits > 1) return false;
      if (r.audience === "returning" && visit.visits < 2) return false;
      if (r.device === "mobile" && !mobile.matches) return false;
      if (r.device === "desktop" && mobile.matches) return false;
      if (r.freq === "once" && proOnce()[r.id]) return false;
      return true;
    }
    function proHide() { if (proEl) { proEl.remove(); proEl = null; } }
    function proOpen(text, id) { proHide(); proEngaged(id); state.messages.push({ role: "model", text: text, t: Date.now() }); save(); setOpen(true); render(); }
    function proShow(text, id, r) {
      text = String(text || "").replace(/[\u0000-\u001f]/g, " ").trim().slice(0, 300);
      if (!text || state.open || proEl || state.live || state.messages.length > 0) return;
      r = r || {};
      var x = el("button", { class: "prox", type: "button", "aria-label": L.proClose, text: "\u00d7" });
      x.addEventListener("click", function () { proHide(); });
      var hit = function () { proStat(id, "click"); };
      if (!r.title && !(r.buttons && r.buttons.length)) {
        var t = el("button", { class: "prot", type: "button", text: text });
        proEl = el("div", { class: "pro", role: "status" }, [t, x]);
        t.addEventListener("click", function () { hit(); proOpen(text, id); });
      } else {
        var who = el("span", { class: "pc-who" }, [botAv(), el("span", { text: cfg.title || "" })]);
        var parts = [el("div", { class: "pc-top" }, [who, x])];
        if (r.title) parts.push(el("div", { class: "pc-hero", text: String(r.title).slice(0, 40) }));
        parts.push(el("p", { class: "pc-text", text: text }));
        if (r.buttons && r.buttons.length) {
          parts.push(el("div", { class: "pc-btns" }, r.buttons.slice(0, 3).map(function (b, i) {
            var bt = el("button", { type: "button", class: b.kind !== "close" && i === 0 ? "main" : "", text: String(b.label || "").slice(0, 30) });
            bt.addEventListener("click", function () {
              hit();
              if (b.kind === "close") return proHide();
              proOpen(text, id);
              if (b.kind === "send") { input.value = String(b.label).slice(0, 30); form.requestSubmit(); }
            });
            return bt;
          })));
        }
        var qi = el("input", { type: "text", maxlength: "500", placeholder: L.ph, "aria-label": L.msgLabel });
        var qs = el("button", { type: "submit", "aria-label": L.sendL }); qs.innerHTML = ICON_SEND; // sabit, yoxlanmış SVG
        var qf = el("form", { class: "pc-in" }, [qi, qs]);
        qf.addEventListener("submit", function (e) {
          e.preventDefault(); hit();
          var v = qi.value.trim();
          proOpen(text, id);
          if (v) { input.value = v; form.requestSubmit(); }
        });
        parts.push(qf);
        proEl = el("div", { class: "pro card", role: "dialog", "aria-label": r.title || text.slice(0, 60) }, parts);
      }
      root.appendChild(proEl); proMark(id, r.freq === "once"); proStat(id, "shown");
    }
    function schedulePro(path, visible) {
      proTimers.forEach(clearTimeout); proTimers = []; proHide();
      if (!visible || !proRules.length) return;
      var mem = proMem();
      proRules.forEach(function (r) {
        if (mem[r.id] || !proFits(r) || !pathMatches(String(r.match || "").split(",").map(function (x) { return x.trim(); }).filter(Boolean), path)) return;
        var d = Number(r.delaySec);
        proTimers.push(setTimeout(function () { if (proFits(r)) proShow(r.text, r.id, r); }, Math.max(0.5, isFinite(d) ? d : 10) * 1000));
      });
    }
    var shown = true;
    function applyRoute() {
      var path = normPath(location.pathname);
      var ok = (!showOn || pathMatches(showOn, path)) && !(hideOn && pathMatches(hideOn, path));
      schedulePro(path, ok);
      if (ok === shown) return;
      shown = ok;
      host.style.display = ok ? "" : "none";
      if (!ok && state.open) setOpen(false); // açıq çat gizlənəndə mobil scroll kilidi də açılsın
    }
    var onRoute = function () { setTimeout(function () { applyRoute(); presenceSoon(); }, 0); };
    var restore = [];
    if (showOn || hideOn || proRules.length || cfg.presence) {
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
    presenceBeat();

    window.CarAdvisor = {
      identify: window.CarAdvisor.identify,
      open: function () { setOpen(true); },
      close: function () { setOpen(false); },
      toggle: function () { setOpen(!state.open); },
      // Saytın öz şərti üçün (məs. səbətdə məhsul qalıb): CarAdvisor.proactive("Sifarişi tamamlamaqda kömək edək?"); 30 dəqiqədə bir dəfə
      proactive: function (text) { var m = proMem(); if (m.api && Date.now() - m.api < 30 * 60000) return; proShow(text, "api"); },
      // Vidjeti tam silir (məs. React komponentinin useEffect təmizləməsində). Skript yenidən yüklənsə yenidən qurulur.
      destroy: function () {
        proTimers.forEach(clearTimeout); proHide();
        cfg.presence = false; clearTimeout(presTimer); clearTimeout(presSoonT);
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
