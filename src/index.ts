import "dotenv/config";
import { createAiClient } from "./ai.js";
import { createApp } from "./app.js";
import { loadConfig } from "./config.js";
import { recordError, loggedMailer } from "./errorlog.js";
import { createMailer } from "./mailer.js";
import { createTelegramApi } from "./telegram.js";
import { createLimiter } from "./security.js";
import { attachRealtime } from "./realtime.js";
import { startReportScheduler } from "./stats.js";
import { createMongoStore } from "./store/mongo.js";

const config = loadConfig();
const store = await createMongoStore(config.mongoUri, config.dbName);
const deps = {
  config, store, limiter: createLimiter(),
  mailer: loggedMailer(createMailer({ apiKey: config.resendApiKey, from: config.mailFrom, replyTo: config.mailReplyTo }), store),
  ai: createAiClient(config.aiServiceUrl, config.aiServiceToken),
  telegram: createTelegramApi(),
};
const app = createApp(deps);

if (!config.resendApiKey) console.warn("[mail] RESEND_API_KEY yoxdur: təsdiq kodları email göndərilmir, bu konsola yazılır (yalnız inkişaf üçün).");
if (!config.secretKey) console.warn("[telegram] CHANNEL_SECRET_KEY yoxdur: Telegram kanalı qoşulmayacaq (openssl rand -hex 32 ilə yarat).");
const server = app.listen(config.port, () => console.log(`Portal API: http://localhost:${config.port}`));
attachRealtime(server, deps); // canlı söhbət üçün WebSocket (/ws)
startReportScheduler(deps); // aylıq e-poçt hesabatı (ayın 1-i)
for (const sig of ["SIGINT", "SIGTERM"] as const) process.on(sig, () => server.close(() => store.close().then(() => process.exit(0))));

// Tutulmamış xətalar jurnala düşür. Gözlənilməz istisnadan sonra proses təmiz vəziyyətdə olmaya bilər: yazıb çıxırıq (PM2/Docker yenidən qaldırır).
process.on("unhandledRejection", (e) => {
  console.error("[unhandledRejection]", e);
  void recordError(store, { source: "process", message: e instanceof Error ? e.message : String(e), stack: e instanceof Error ? e.stack : undefined, code: "UNHANDLED_REJECTION" });
});
process.on("uncaughtException", (e) => {
  console.error("[uncaughtException]", e);
  void recordError(store, { source: "process", message: e.message, stack: e.stack, code: "UNCAUGHT" }).finally(() => process.exit(1));
  setTimeout(() => process.exit(1), 2000).unref();
});
