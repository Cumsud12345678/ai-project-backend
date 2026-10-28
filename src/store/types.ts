export type Role = "admin" | "user";
/** `role` köhnə sənədlərdə olmaya bilər: yoxdursa "user" sayılır. */
export type User = { id: string; email: string; passwordHash: string; verified: boolean; createdAt: Date; role?: Role };
export type Session = { tokenHash: string; userId: string; expiresAt: Date };
export type CodePurpose = "verify" | "reset";
export type CodeRecord = { email: string; purpose: CodePurpose; codeHash: string; expiresAt: Date; attempts: number; sentAt: Date };

/** Həftənin 7 günü (0 = bazar, JS getDay). null = həmin gün işləmir. Saat "HH:MM", gecəni keçən aralıq yoxdur. */
export type WorkHours = { tz: string; days: ({ from: string; to: string } | null)[] };
export type ProactiveRule = { id: string; text: string; /** səhifədə neçə saniyə qaldıqdan sonra */ delaySec: number; /** yol şablonu: "/", "/products/*", "*" (vergüllə) */ match: string };
export type LiveNote = { text: string; by: string; at: Date };
export type CannedReply = { id: string; title: string; text: string };

/** Müştəri saytına qoyulan çat vidjetinin ayarları. `key` ictimaidir (brauzerdə görünür), sirr deyil. */
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
  /** Çatın ilk açılış rejimi: light (defolt), dark və ya auto (cihaz ayarı). Ziyarətçi çatdakı düymə ilə özü dəyişir və seçimi yadda qalır. */
  theme?: "light" | "dark" | "auto";
  /** Yüklənmiş loqo (kiçildilmiş şəkil, base64). Panelə və vidjetə yalnız ünvanı qayıdır. `v` keşi yeniləmək üçündür. */
  logo?: { mime: "image/png" | "image/jpeg" | "image/webp"; data: string; v: number };
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
  widget?: WidgetSettings;
  /** "Powered by" yazısı vidjetdə defolt görünür; yalnız admin söndürə bilir (ödənişli xidmət). */
  brandRemoved?: boolean;
  /** Aylıq e-poçt hesabatı: defolt aktivdir (monthly=false ilə söndürülür); lastSent = axırıncı göndərilən dövr ("2026-09"). */
  report?: { monthly?: boolean; lastSent?: string };
  /** Operator komandası: sahibin dəvət etdiyi işçilər yalnız canlı söhbət qutusunu görür. `userId` işçi qeydiyyatdan keçəndə dolur. */
  team?: TeamMember[];
  telegram?: TelegramLink | null;
  whatsapp?: WhatsAppLink | null;
  /** Hazır cavablar: operatorlar söhbətdə bir kliklə mesaja əlavə edir */
  canned?: CannedReply[];
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
  updatedAt: Date;
};

export type LiveMessage = { from: "visitor" | "operator" | "system"; text: string; at: Date; /** operator mesajını yazan komanda üzvü */ by?: string };
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
};
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
export type Announcement = { text: string; level: "info" | "warn" | "critical"; active: boolean; updatedAt: Date; by: string };

export class DuplicateError extends Error {}

export interface Store {
  findUserByEmail(email: string): Promise<User | null>;
  findUserById(id: string): Promise<User | null>;
  createUser(u: { email: string; passwordHash: string }): Promise<User>;
  updateUser(id: string, patch: Partial<Pick<User, "passwordHash" | "verified" | "role">>): Promise<void>;
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
  setWidgetLogo(tenantId: string, logo: NonNullable<WidgetSettings["logo"]> | null): Promise<void>;
  updateTenant(tenantId: string, patch: Partial<Pick<TenantRecord, "config" | "businessName" | "domain" | "keyRotatedAt" | "widget" | "report" | "team" | "brandRemoved" | "canned">> & { telegram?: TelegramLink | null; whatsapp?: WhatsAppLink | null }): Promise<void>;

  /** Vidjetin saytda yükləndiyini qeyd edir (digər sahələrə toxunmur, updatedAt dəyişmir). */
  touchWidget(tenantId: string, at: Date): Promise<void>;
  deleteTenant(tenantId: string): Promise<void>;

  // Canlı söhbət (hər müştəri yalnız öz tenantId-si ilə)
  createLive(c: LiveChat): Promise<void>;
  getLive(tenantId: string, id: string): Promise<LiveChat | null>;
  /** Mesaj əlavə edir (ən çox 300) və sahələri yeniləyir; söhbət tapılmasa null. */
  pushLive(tenantId: string, id: string, msg: LiveMessage | null, patch?: Partial<Pick<LiveChat, "status" | "operatorSeenAt" | "visitorSeenAt" | "name" | "contact" | "assignee">>): Promise<LiveChat | null>;
  /** updatedAt-a toxunmadan yalnız izləmə sahələrini yeniləyir */
  patchLive(tenantId: string, id: string, patch: Partial<Pick<LiveChat, "visitorSeenAt" | "notifiedAt" | "notifyCount" | "notes" | "tags" | "csat">>): Promise<void>;
  findLiveByChannel(tenantId: string, type: "telegram" | "whatsapp", chatId: string): Promise<LiveChat | null>;
  listLive(tenantId: string, status: "open" | "closed", limit: number): Promise<LiveChat[]>;
  deleteLiveForTenant(tenantId: string): Promise<void>;

  addFeedback(f: FeedbackRecord): Promise<void>;
  feedbackSince(tenantId: string, since: Date, limit: number): Promise<FeedbackRecord[]>;
  feedbackCounts(tenantId: string, since: Date): Promise<{ up: number; down: number }>;

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

  close(): Promise<void>;
}

export const LIVE_MAX_MESSAGES = 300;
