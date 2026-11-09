export type Role = "admin" | "user";
/** `role` köhnə sənədlərdə olmaya bilər: yoxdursa "user" sayılır. */
/** Avtomatlaşdırma: hadisə (nə vaxt) + şərt + addımlar. Göndərmə yerləri (Telegram qrupu, Bitrix24, webhook) leadForward-dakı bağlantılardır. */
export type AutoTrigger = "lead" | "bad_rating" | "chat_closed" | "daily";
export type AutoAction = { type: "telegram" | "email" | "webhook" | "bitrix" } | { type: "ticket"; priority: "normal" | "high" } | { type: "tag"; tag: string };
export type Automation = {
  id: string; name: string; trigger: AutoTrigger; enabled: boolean; actions: AutoAction[];
  when?: { channel?: "any" | "site" | "telegram" | "whatsapp"; withContact?: boolean; source?: "any" | "csat" | "feedback"; hour?: number };
  createdAt: string;
  /** son işləmə (panel göstərir) və sayğac; lastDay: gündəlik hadisənin son günü (YYYY-MM-DD, saytın saat qurşağı) */
  lastRun?: { at: string; ok: boolean; error?: string } | null; runs?: number; lastDay?: string;
};
export type LeadForward = { telegram?: { chatId: string; title: string } | null; bitrix?: { urlEnc: string; host: string } | null; webhook?: { urlEnc: string; host: string } | null };
/** Operatorun canlı söhbət bildirişləri üçün bağladığı Telegram (platformanın bildiriş botu ilə). */
export type TgNotify = { chatId: string; name: string; at: Date };
/** İki addımlı giriş (TOTP, Google Authenticator və s.). Sirr CHANNEL_SECRET_KEY ilə şifrəlidir; ehtiyat kodlar yalnız hash kimi saxlanır. `lastStep`: son qəbul olunan kodun 30 saniyəlik addımı (eyni kod iki dəfə işləmir). */
export type TwoFactor = { secretEnc: string; enabledAt: Date; backupHashes: string[]; lastStep?: number };
/** Partnyor (yalnız admin təyin edir): kodu ilə gələn müştərilərin ödənişlərindən `rate` faiz qazanır. */
export type PartnerInfo = { code: string; /** faiz, məs. 15 = 15% */ rate: number; active: boolean; since: Date; note?: string };
/**
 * Müştəri hansı partnyorla gəlib. `at`: komissiya pəncərəsinin başlanğıcı (bu tarixdən N ay ərzindəki ödənişlər sayılır).
 * `source`: link/code = qeydiyyatda (yeni müştəri bonusu verilir), admin = sonradan əl ilə bağlanıb (bonus yoxdur).
 * `bonusAt`: ilk ödəniş bonusu verilibsə.
 */
export type ReferralInfo = { partnerId: string; code: string; at: Date; source: "link" | "code" | "admin"; bonusAt?: Date | null };
/** Partnyor balansındakı hərəkət. commission: avtomatik (ödənişdən); adjust: admin əl ilə ±; payout: admin ödəyib (mənfi). */
export type PartnerEntry = {
  id: string; partnerId: string; kind: "commission" | "adjust" | "payout"; amountAzn: number; at: Date;
  /** commission: AI servisindəki ödəniş qeydinin ID-si (təkrar yazılmır) */
  sourceRef?: string; tenantId?: string; customerId?: string; baseAzn?: number; rate?: number;
  note?: string; by?: string;
};
export type User = { id: string; email: string; passwordHash: string; verified: boolean; createdAt: Date; role?: Role; tgNotify?: TgNotify | null; totp?: TwoFactor | null; /** quraşdırma başlanıb, hələ kodla təsdiqlənməyib */ totpPending?: { secretEnc: string; at: Date } | null; partner?: PartnerInfo | null; referredBy?: ReferralInfo | null };
/** `createdAt`: admin sessiyasının qısa ömrünü (ADMIN_SESSION_HOURS) yoxlamaq üçün. Köhnə sessiyalarda yoxdur. */
export type Session = { tokenHash: string; userId: string; expiresAt: Date; createdAt?: Date };
/** "2fa": parol düzgündür, iki addımlı kod gözlənilir (kod əvəzinə qısa ömürlü bilet saxlanır). */
export type CodePurpose = "verify" | "reset" | "2fa";
export type CodeRecord = { email: string; purpose: CodePurpose; codeHash: string; expiresAt: Date; attempts: number; sentAt: Date };

/** Həftənin 7 günü (0 = bazar, JS getDay). null = həmin gün işləmir. Saat "HH:MM", gecəni keçən aralıq yoxdur. */
export type WorkHours = { tz: string; days: ({ from: string; to: string } | null)[] };
export type CampaignButton = { label: string; /** chat: çatı açır; send: çatı açıb düymənin yazısını sual kimi göndərir; close: kartı bağlayır */ kind: "chat" | "send" | "close" };
/** Kampaniya (proaktiv mesaj): ziyarətçi yazmadan, şərtə görə çat düyməsinin yanında kart göstərilir. Köhnə qaydalarda yalnız id/text/delaySec/match olur. */
export type ProactiveRule = {
  id: string; text: string; /** səhifədə neçə saniyə qaldıqdan sonra */ delaySec: number; /** yol şablonu: "/", "/products/*", "*" (vergüllə) */ match: string;
  /** Paneldə görünən ad */ name?: string;
  /** Kartın iri başlığı (məs. "Xoş gəldin!"); boşdursa kiçik balon göstərilir */ title?: string;
  /** false = deaktiv (qeyd qalır, göstərilmir); olmayanda aktivdir */ active?: boolean;
  /** Kimə: hamıya, ilk dəfə gələnlərə, təkrar gələnlərə */ audience?: "all" | "new" | "returning";
  device?: "all" | "mobile" | "desktop";
  /** visit: hər ziyarətdə (sessiyada) bir dəfə; once: ziyarətçiyə ümumiyyətlə bir dəfə */ freq?: "visit" | "once";
  /** Yalnız operator onlayn olanda (canlı söhbət açıq və iş saatı daxilində) */ online?: boolean;
  buttons?: CampaignButton[];
  /** Planlaşdırma (ISO): başlamazdan əvvəl və bitəndən sonra göstərilmir */ startAt?: string | null; endAt?: string | null;
};
/** Kampaniya statistikası: göstərilib, kliklənib, söhbətə çevrilib */
export type CampaignStat = { shown: number; clicked: number; chats: number };
export type LiveNote = { text: string; by: string; at: Date };
export type CannedReply = { id: string; title: string; text: string };

/** Müştəri saytına qoyulan çat vidjetinin ayarları. `key` ictimaidir (brauzerdə görünür), sirr deyil. */
/** Vidjet şəkli (kiçildilmiş, base64). Panelə və vidjetə yalnız ünvanı qayıdır. `v` keşi yeniləmək üçündür. */
export type WidgetImage = { mime: "image/png" | "image/jpeg" | "image/webp"; data: string; v: number };
/** Vidjetin ayrıca saxlanan şəkilləri: logo = çat düyməsi, avatar = çatın içindəki profil şəkli. */
export type WidgetImageKind = "logo" | "avatar";

export type WidgetSettings = {
  key: string;
  enabled: boolean;
  /** Domendən əlavə icazə verilən mənbələr (məs. https://staging.motoelan.com). */
  origins: string[];
  title: string;
  greeting: string;
  /** Loqonun yanındakı qısa yazı (məs. "AI-dan soruş"). Boş sətir = yazı göstərilmir. Olmayanda defolt işləyir. */
  label?: string;
  color: string;
  /** Sahib rəngi paneldən özü seçib. Olmayanda və rəng köhnə standartdırsa, yeni standart (qara) göstərilir. */
  colorSet?: boolean;
  /** Çatın ilk açılış rejimi: light (defolt), dark və ya auto (cihaz ayarı). Ziyarətçi çatdakı düymə ilə özü dəyişir və seçimi yadda qalır. */
  theme?: "light" | "dark" | "auto";
  /** Çat düyməsinin diqqət çəkən effektləri (yalnız çat bağlı olanda işləyir): pulse = rəngli dalğa, bounce = yavaş yuxarı-aşağı süzülmə. */
  effects?: { pulse: boolean; bounce: boolean };
  /** Çat düyməsinin loqosu. Olmayanda düymədə standart çat ikonu göstərilir. */
  logo?: WidgetImage;
  /** Çatın içindəki profil şəkli (başlıq və bot mesajlarının yanındakı dairə). Olmayanda vidjet standart bot ikonunu göstərir. */
  avatar?: WidgetImage;
  /** Çat istifadə limitləri (0 = limitsiz). Olmayanda defolt: ziyarətçi başına gündə 30 mesaj, sayt üzrə limitsiz. */
  limits?: { perVisitorDay: number; siteHour: number };
  /** Canlı operator söhbəti: ziyarətçi operatorla panel vasitəsilə yazışır. Defolt: söndürülüb (operator panelə baxmalıdır). */
  live?: { enabled: boolean; /** Söhbət bağlananda ziyarətçidən 1-5 qiymət istənir (defolt: aktiv) */ csat?: boolean; /** İşçi saatları: kənarda canlı operator düyməsi gizlənir, əlaqə forması göstərilir */ hours?: WorkHours | null };
  /** Proaktiv mesajlar: ziyarətçi yazmadan, şərtə görə çat düyməsinin yanında qısa təklif göstərilir. */
  proactive?: { enabled: boolean; rules: ProactiveRule[] };
  /** Vidjet scriptinin müştəri saytında son dəfə yükləndiyi vaxt (quraşdırmanın işlədiyini göstərir). */
  lastSeenAt?: Date;
};

export type TeamMember = { email: string; userId?: string; addedAt: Date };

/** Müştərinin aktiv AI tenant-ı. `config` apiSecret olmadan saxlanır. */
export type TenantRecord = {
  userId: string;
  tenantId: string;
  businessName: string;
  domain: string;
  config: Record<string, unknown>;
  createdAt: Date;
  updatedAt: Date;
  keyRotatedAt?: Date;
  /** Sahib panelin sınaq çatında köməkçini öz məlumatı ilə ilk dəfə uğurla yoxlayıb (quraşdırma addımı) */
  testedAt?: Date;
  /** Quraşdırma sehirbazında seçilən məqsədlər: hansı məlumat addımının lazım olduğunu həll edir (panelin hər yerində eyni hazırlıq) */
  setup?: { goals: ("answer" | "catalog")[]; at: Date };
  widget?: WidgetSettings;
  /** "Powered by" yazısı vidjetdə defolt görünür; yalnız admin söndürə bilir (ödənişli xidmət). */
  brandRemoved?: boolean;
  /** Admin müştərini dayandırıbsa: vidjet, kanallar və AI sorğuları işləmir. Sahib panelə daxil ola bilir. */
  suspended?: { at: Date; by: string; reason: string } | null;
  /** Aylıq e-poçt hesabatı: defolt aktivdir (monthly=false ilə söndürülür); lastSent = axırıncı göndərilən dövr ("2026-09"). */
  report?: { monthly?: boolean; lastSent?: string };
  /** Operator komandası: sahibin dəvət etdiyi işçilər yalnız canlı söhbət qutusunu görür. `userId` işçi qeydiyyatdan keçəndə dolur. */
  team?: TeamMember[];
  telegram?: TelegramLink | null;
  whatsapp?: WhatsAppLink | null;
  /** WhatsApp-da köməkçinin cavab yazmadığı nömrələr və ya adlar. Nömrə qoşulmazdan əvvəl də yazılır, ayıranda silinmir. */
  waIgnore?: string[];
  /** Hazır cavablar: operatorlar söhbətdə bir kliklə mesaja əlavə edir */
  canned?: CannedReply[];
  /** Yeni müraciətin ötürüldüyü yerlər. Bitrix24 və webhook linkləri sirr daşıyır: şifrəli saxlanır (CHANNEL_SECRET_KEY). */
  leadForward?: LeadForward;
  /** Bloklanmış ziyarətçilər və kanal müştəriləri (spam, təhqir) */
  blocked?: BlockEntry[];
  /** Kampaniya ID-si → statistika */
  campaignStats?: Record<string, CampaignStat>;
  /** Avtomatlaşdırmalar. Olmayanda (köhnə hesab) qoşulmuş ötürmə yerlərinə "yeni müraciət → göndər" işləyir. */
  automations?: Automation[];
};

/** Müştərinin Telegram botu. Token şifrələnmiş saxlanır, panelə qayıtmır. `hook` webhook ünvanındakı təsadüfi hissədir, `secret` Telegram-ın hər sorğuya qoyduğu başlıqdır. */
export type TelegramLink = { tokenEnc: string; botId: number; botUsername: string; hook: string; secret: string; enabled: boolean; connectedAt: Date };
/** Müştərinin QR ilə qoşulmuş WhatsApp nömrəsi. Sessiya açarları ayrıca (`wa_auth`) şifrəli saxlanır. `ackAt`: qeyri-rəsmi qoşulmanın riskini qəbul etdiyi an. */
export type WhatsAppLink = { enabled: boolean; phone: string; connectedAt: Date; ackAt: Date; /** Sahib telefondan özü yazanda bot həmin söhbətdə 12 saat susur */ pauseOnOwnReply: boolean };
/** Kanaldakı (Telegram) söhbətin serverdə saxlanan vəziyyəti: vidjetdən fərqli olaraq tarixçəni brauzer göndərmir. */
export type ChannelSession = {
  tenantId: string; channel: "telegram" | "whatsapp"; chatId: string; sid: string;
  history: { role: "user" | "model"; text: string }[];
  /** Cavab tapılmayıb: növbəti mesaj telefon/e-poçt kimi qəbul edilir və müraciətə çevrilir. */
  pending?: { question: string } | null;
  /** AI-nin təklif etdiyi, istifadəçinin BƏLİ/XEYR cavabını gözləyən əməliyyat (yalnız id; məzmun AI serverindədir) */
  pendingAction?: { id: string } | null;
  /** Müştərinin adı və kanal ünvanı: operator ona özü yaza bilsin */
  name?: string; ref?: string;
  /** Müştərinin real telefon nömrəsi (yalnız rəqəmlər). WhatsApp bəzən nömrə əvəzinə gizli LID ünvanı göndərir */
  phone?: string;
  /** Əvvəlki söhbətlərin sid-ləri (sakitlikdən sonra yeni söhbət başlayanda): paneldə bütün yazışma göstərilsin */
  prevSids?: { sid: string; at: Date }[];
  updatedAt: Date;
};

export type LiveMessage = { from: "visitor" | "operator" | "system"; text: string; at: Date; /** operator mesajını yazan komanda üzvü */ by?: string; /** göndərilən fayl: ziyarətçinin şəkli və ya operatorun şəkli/PDF-i (baytlar ayrıca, live_files-da) */ file?: { id: string; mime: string; name?: string } };
/** Canlı söhbətdə göndərilən şəkil. Söhbət sənədini böyütməmək üçün ayrıca saxlanır, söhbətlə eyni müddətdə silinir. */
export type LiveFile = { id: string; tenantId: string; chatId: string; mime: "image/png" | "image/jpeg" | "image/webp" | "application/pdf"; name?: string; data: string; at: Date };
/** Ziyarətçi ilə operator arasında canlı söhbət. Ziyarətçi yalnız `tokenHash`-ın sahibi olan token ilə oxuya/yaza bilər. */
export type LiveChat = {
  id: string; tenantId: string; tokenHash: string;
  name: string; contact: string; status: "open" | "closed";
  /** Operatorun söhbəti başa düşməsi üçün: ziyarətçinin AI ilə əvvəlki yazışması. */
  context: { role: "user" | "model"; text: string }[];
  messages: LiveMessage[];
  createdAt: Date; updatedAt: Date;
  /** Operator söhbəti axırıncı dəfə nə vaxt açdı (cavab gözləyənləri ayırmaq üçün). */
  operatorSeenAt?: Date;
  /** Ziyarətçi çatda axırıncı dəfə nə vaxt aktiv idi (hər sorğuda yenilənir, 30 san-dən tez yazılmır). */
  visitorSeenAt?: Date;
  /** Ziyarətçiyə operator cavabı barədə axırıncı e-poçt və göndərilən sayı. */
  notifiedAt?: Date;
  notifyCount?: number;
  /** Söhbəti götürən operator (null/yoxdur = kimsəyə təyin olunmayıb) */
  assignee?: { userId: string; name: string } | null;
  /** Telegram/WhatsApp-dan gələn söhbət: operatorun cavabı bu kanala göndərilir, açıq olduqca bot həmin söhbətdə susur. `ref` WhatsApp-da tam JID-dir. */
  channel?: { type: "telegram" | "whatsapp"; chatId: string; ref?: string };
  /** Daxili qeydlər: yalnız komanda görür, ziyarətçiyə getmir */
  notes?: LiveNote[];
  tags?: string[];
  /** Ziyarətçinin söhbət bağlananda verdiyi qiymət (1-5) */
  csat?: { rating: number; comment?: string; at: Date };
  /** Ziyarətçinin söhbəti başladığı səhifə (yalnız yol və başlıq, sorğu parametrləri saxlanmır) */
  page?: { path: string; title?: string };
  /** Sayt ziyarətçisi: pid (brauzer ID-sindən törəmə, bloklamaq üçün) və brauzerin özü bildirdiyi məlumat */
  visitor?: VisitorInfo & { pid: string };
};
/** Ziyarətçi haqqında (brauzer bildirir, IP saxlanmır): saat qurşağı, dil, cihaz, ilk ziyarət, ziyarət sayı, gəldiyi sayt */
export type VisitorInfo = { tz?: string; lang?: string; mobile?: boolean; first?: number; visits?: number; ref?: string };
/** Bloklanmış ziyarətçi və ya kanal müştərisi. key: "v:<pid>" | "tg:<chatId>" | "wa:<chatId>" */
export type BlockEntry = { key: string; label: string; at: Date; by: string };
export type FeedbackRecord = { tenantId: string; rating: 1 | -1; question: string; answer: string; at: Date };

export type ErrorSource = "api" | "ai" | "mail" | "widget" | "process" | "client" | "job" | "channel";
/** Sistem xəta jurnalı: serverdə və ya panelin brauzerində baş verən gözlənilməz xəta. Sirr və şəxsi məlumat yazılmır. */
export type ErrorRecord = {
  id: string; at: Date; source: ErrorSource; message: string;
  /** Eyni səbəbli xətaları qruplaşdırmaq üçün (mənbə + normallaşmış mesaj + yol). */
  fingerprint: string;
  code?: string; status?: number; method?: string; path?: string; stack?: string; userId?: string; tenantId?: string;
};
/** Admin əməliyyatlarının izi: kim, nəyi, nə vaxt dəyişdi. */
export type AuditRecord = { id: string; at: Date; actor: string; action: string; target?: string; detail?: string };
/** Bütün müştərilərə panelin yuxarısında göstərilən elan. */
export type Announcement = { text: string; level: "info" | "warn" | "critical"; active: boolean; updatedAt: Date; by: string; /** bu vaxtdan sonra müştərilərə göstərilmir */ expiresAt?: Date | null };

export class DuplicateError extends Error {}

/** Admin istifadəçi siyahısı üçün süzgəc. admins: ADMIN_EMAILS (onlar bazada role="admin" olmaya bilər). */
export type UserQuery = { ids?: string[]; /** e-poçtda axtarış VƏ YA bu ID-lər (müştəri adı/domeni uyğun gələn sahiblər) */ search?: { text: string; ids: string[] }; verified?: boolean; admins?: string[]; since?: Date };

export interface Store {
  findUserByEmail(email: string): Promise<User | null>;
  findUserById(id: string): Promise<User | null>;
  createUser(u: { email: string; passwordHash: string }): Promise<User>;
  updateUser(id: string, patch: Partial<Pick<User, "passwordHash" | "verified" | "role" | "tgNotify" | "totp" | "totpPending" | "partner" | "referredBy">>): Promise<void>;
  listUsers(limit: number): Promise<User[]>;
  deleteUser(id: string): Promise<void>;

  createSession(s: Session): Promise<void>;
  findSession(tokenHash: string): Promise<Session | null>;
  deleteSession(tokenHash: string): Promise<void>;
  deleteSessionsForUser(userId: string): Promise<void>;

  saveCode(c: CodeRecord): Promise<void>;
  findCode(email: string, purpose: CodePurpose): Promise<CodeRecord | null>;
  bumpCodeAttempts(email: string, purpose: CodePurpose): Promise<void>;
  deleteCode(email: string, purpose: CodePurpose): Promise<void>;
  deleteCodesForEmail(email: string): Promise<void>;

  findTenantByUser(userId: string): Promise<TenantRecord | null>;
  findTenantByMember(userId: string): Promise<TenantRecord | null>;
  findTenantByTeamEmail(email: string): Promise<TenantRecord | null>;
  findTenantById(tenantId: string): Promise<TenantRecord | null>;
  findTenantByWidgetKey(key: string): Promise<TenantRecord | null>;
  findTenantByTelegramHook(hook: string): Promise<TenantRecord | null>;
  listTenants(limit: number): Promise<TenantRecord[]>;
  createTenant(t: TenantRecord): Promise<void>; // DuplicateError: istifadəçinin artıq tenant-ı var
  /** Yalnız vidjet loqosunu dəyişir (bütün vidjet sənədini yenidən yazmır). null = sil. */
  setWidgetLogo(tenantId: string, logo: WidgetImage | null, kind?: WidgetImageKind): Promise<void>;
  updateTenant(tenantId: string, patch: Partial<Pick<TenantRecord, "config" | "businessName" | "domain" | "keyRotatedAt" | "testedAt" | "setup" | "widget" | "report" | "team" | "brandRemoved" | "canned" | "leadForward" | "suspended" | "blocked" | "campaignStats" | "automations" | "waIgnore">> & { telegram?: TelegramLink | null; whatsapp?: WhatsAppLink | null }): Promise<void>;

  /** Vidjetin saytda yükləndiyini qeyd edir (digər sahələrə toxunmur, updatedAt dəyişmir). */
  touchWidget(tenantId: string, at: Date): Promise<void>;
  /** Kampaniya sayğacını artırır (digər sahələrə toxunmur) */
  incCampaignStat(tenantId: string, id: string, field: keyof CampaignStat): Promise<void>;
  /** Avtomatlaşdırmanın son işləməsini yazır (siyahının qalanına toxunmur) */
  setAutomationRun(tenantId: string, id: string, run: { at: string; ok: boolean; error?: string } | null, lastDay?: string): Promise<void>;
  deleteTenant(tenantId: string): Promise<void>;

  // Canlı söhbət (hər müştəri yalnız öz tenantId-si ilə)
  createLive(c: LiveChat): Promise<void>;
  getLive(tenantId: string, id: string): Promise<LiveChat | null>;
  /** Mesaj əlavə edir (ən çox 300) və sahələri yeniləyir; söhbət tapılmasa null. */
  pushLive(tenantId: string, id: string, msg: LiveMessage | null, patch?: Partial<Pick<LiveChat, "status" | "operatorSeenAt" | "visitorSeenAt" | "name" | "contact" | "assignee">>): Promise<LiveChat | null>;
  /** updatedAt-a toxunmadan yalnız izləmə sahələrini yeniləyir */
  patchLive(tenantId: string, id: string, patch: Partial<Pick<LiveChat, "visitorSeenAt" | "notifiedAt" | "notifyCount" | "notes" | "tags" | "csat" | "contact">>): Promise<void>;
  findLiveByChannel(tenantId: string, type: "telegram" | "whatsapp", chatId: string): Promise<LiveChat | null>;
  listLive(tenantId: string, status: "open" | "closed", limit: number): Promise<LiveChat[]>;
  deleteLiveForTenant(tenantId: string): Promise<void>;
  /** Bir söhbəti və onun fayllarını silir */
  deleteLive(tenantId: string, id: string): Promise<boolean>;
  addLiveFile(f: LiveFile): Promise<void>;
  getLiveFile(tenantId: string, id: string): Promise<LiveFile | null>;

  addFeedback(f: FeedbackRecord): Promise<void>;
  feedbackSince(tenantId: string, since: Date, limit: number): Promise<FeedbackRecord[]>;
  feedbackCounts(tenantId: string, since: Date): Promise<{ up: number; down: number }>;
  /** Çatdakı məhsul/elan kartına klik (saytın yönləndirmə sayğacı) */
  addClick(tenantId: string, at: Date): Promise<void>;
  countClicks(tenantId: string, since: Date): Promise<number>;

  getChannelSession(tenantId: string, channel: ChannelSession["channel"], chatId: string): Promise<ChannelSession | null>;
  saveChannelSession(s: ChannelSession): Promise<void>;
  listChannelSessions(tenantId: string, limit: number): Promise<ChannelSession[]>;
  deleteChannelSessions(tenantId: string, channel?: ChannelSession["channel"]): Promise<void>;

  /** WhatsApp sessiya açarları (hər biri şifrəli sətir). value=null olan açar silinir. */
  getWaAuth(tenantId: string, names: string[]): Promise<Record<string, string>>;
  setWaAuth(tenantId: string, entries: Record<string, string | null>): Promise<void>;
  deleteWaAuth(tenantId: string): Promise<void>;

  addError(e: Omit<ErrorRecord, "id" | "at"> & { at?: Date }): Promise<void>;
  listErrors(opts: { since?: Date; source?: ErrorSource; limit: number }): Promise<ErrorRecord[]>;
  countErrors(since: Date): Promise<number>;
  deleteErrors(opts: { id?: string; fingerprint?: string }): Promise<number>;
  clearErrors(): Promise<number>;

  addAudit(a: Omit<AuditRecord, "id" | "at">): Promise<void>;
  listAudit(limit: number): Promise<AuditRecord[]>;

  getAnnouncement(): Promise<Announcement | null>;
  setAnnouncement(a: Announcement | null): Promise<void>;

  // ---- Partnyor proqramı ----
  /** Kod böyük hərflə saxlanır */
  findUserByPartnerCode(code: string): Promise<User | null>;
  listPartners(): Promise<User[]>;
  /** partnerId verilibsə yalnız onun gətirdikləri */
  listReferred(partnerId?: string): Promise<User[]>;
  /** false: eyni sourceRef artıq var (komissiya təkrar yazılmır) */
  addPartnerEntry(e: Omit<PartnerEntry, "id">): Promise<boolean>;
  listPartnerEntries(partnerId: string, limit: number): Promise<PartnerEntry[]>;
  /** Partnyor üzrə cəmlər (AZN): earned = komissiya, adjust = əl ilə ±, paidOut = ödənilən (müsbət ədəd), balance = hamısının cəmi */
  partnerTotals(partnerIds?: string[]): Promise<Record<string, { earned: number; adjust: number; paidOut: number; balance: number }>>;
  /** Müştəri üzrə partnyora yazılan komissiya və onun əsası (ödəniş) */
  partnerTotalsByCustomer(partnerId: string): Promise<Record<string, { base: number; earned: number }>>;

  // ---- Admin: böyük siyahılar (səhifələmə, bazada sayma) və ümumi ayarlar ----
  /** Ümumi ayar (məs. "admin_alerts"). null = sil. */
  getSetting<T = unknown>(key: string): Promise<T | null>;
  setSetting(key: string, value: unknown): Promise<void>;
  /** İstifadəçi səhifəsi: ids verilibsə yalnız onlar arasından; search = e-poçtda (hərf fərqi yoxdur) və ya verilən ID-lər. Ən yenidən köhnəyə. */
  pageUsers(q: UserQuery & { skip: number; limit: number }): Promise<{ items: User[]; total: number }>;
  countUsers(q?: UserQuery): Promise<number>;
  /** Gün üzrə yeni qeydiyyat sayı (UTC, "YYYY-MM-DD") */
  signupsByDay(since: Date): Promise<{ date: string; users: number }[]>;
  findUsersByIds(ids: string[]): Promise<User[]>;
  /** Adminlər: role="admin" və ya e-poçtu ADMIN_EMAILS-dədir */
  listAdmins(ownerEmails: string[]): Promise<User[]>;
  findTenantsByIds(tenantIds: string[]): Promise<TenantRecord[]>;
  findTenantsByUserIds(userIds: string[]): Promise<TenantRecord[]>;
  /** Şərtə uyğun müştərilərin sahiblərinin ID-ləri (text: ad, domen və ya müştəri ID-də axtarış) */
  tenantUserIds(q: { text?: string; suspended?: boolean; tenantIds?: string[] }): Promise<string[]>;
  /** Müştəri axtarışı (Ödənişlər süzgəci üçün): ID tam uyğun gələn birinci, sonra ad/domen */
  searchTenants(text: string, limit: number): Promise<TenantRecord[]>;
  tenantStats(activeSince: Date): Promise<{ total: number; suspended: number; widgetActive: number; modes: Record<string, number> }>;
  /** Telegram və ya WhatsApp qoşulmuş müştərilər (loqo baytları oxunmur) */
  listChannelTenants(): Promise<TenantRecord[]>;
  /** Kanal üzrə son söhbət vaxtı (müştəri + kanal) */
  lastChannelActivity(): Promise<{ tenantId: string; channel: ChannelSession["channel"]; at: Date }[]>;
  /** Müştəri üzrə xəta sayı */
  countErrorsByTenant(since: Date, source?: ErrorSource): Promise<Record<string, number>>;
  /** Audit jurnalı: süzgəc və səhifələmə (before: bu tarixdən köhnələr) */
  queryAudit(q: { actor?: string; action?: string; text?: string; before?: Date; limit: number }): Promise<AuditRecord[]>;

  close(): Promise<void>;
}

export const LIVE_MAX_MESSAGES = 300;
