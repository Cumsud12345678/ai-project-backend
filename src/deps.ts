import type { AiClient } from "./ai.js";
import type { Config } from "./config.js";
import type { Mailer } from "./mailer.js";
import type { Limiter } from "./security.js";
import type { TelegramApi } from "./telegram.js";
import type { Store, User } from "./store/types.js";

export type Deps = { config: Config; store: Store; mailer: Mailer; ai: AiClient; limiter: Limiter; telegram: TelegramApi };

/** ADMIN_EMAILS: "əsas adminlər". Verilənlər bazası boş/səhv olsa belə sistemdən kənarda qalmamaq üçün həmişə adminlər. */
export const isOwner = (config: Config, user: User) => config.adminEmails.includes(user.email);
/** Admin: əsas admin (.env) və ya bazada role="admin" olan istifadəçi. Rol hər sorğuda bazadan oxunur, restart lazım deyil. */
export const isAdmin = (config: Config, user: User) => isOwner(config, user) || user.role === "admin";
