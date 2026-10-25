export type Role = "admin" | "user";
/** `role` köhnə sənədlərdə olmaya bilər: yoxdursa "user" sayılır. */
export type User = { id: string; email: string; passwordHash: string; verified: boolean; createdAt: Date; role?: Role };
export type Session = { tokenHash: string; userId: string; expiresAt: Date };
export type CodePurpose = "verify" | "reset";
export type CodeRecord = { email: string; purpose: CodePurpose; codeHash: string; expiresAt: Date; attempts: number; sentAt: Date };

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
  /** Çat istifadə limitləri (0 = limitsiz). Olmayanda defolt: ziyarətçi başına gündə 30 mesaj, sayt üzrə limitsiz. */
  limits?: { perVisitorDay: number; siteHour: number };
  /** Vidjet scriptinin müştəri saytında son dəfə yükləndiyi vaxt (quraşdırmanın işlədiyini göstərir). */
  lastSeenAt?: Date;
};

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
};

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
  findTenantById(tenantId: string): Promise<TenantRecord | null>;
  findTenantByWidgetKey(key: string): Promise<TenantRecord | null>;
  listTenants(limit: number): Promise<TenantRecord[]>;
  createTenant(t: TenantRecord): Promise<void>; // DuplicateError: istifadəçinin artıq tenant-ı var
  updateTenant(tenantId: string, patch: Partial<Pick<TenantRecord, "config" | "businessName" | "domain" | "keyRotatedAt" | "widget">>): Promise<void>;

  /** Vidjetin saytda yükləndiyini qeyd edir (digər sahələrə toxunmur, updatedAt dəyişmir). */
  touchWidget(tenantId: string, at: Date): Promise<void>;
  deleteTenant(tenantId: string): Promise<void>;

  close(): Promise<void>;
}
