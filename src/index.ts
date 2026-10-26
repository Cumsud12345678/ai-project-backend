import "dotenv/config";
import { createAiClient } from "./ai.js";
import { createApp } from "./app.js";
import { loadConfig } from "./config.js";
import { createMailer } from "./mailer.js";
import { createLimiter } from "./security.js";
import { attachRealtime } from "./realtime.js";
import { startReportScheduler } from "./stats.js";
import { createMongoStore } from "./store/mongo.js";

const config = loadConfig();
const store = await createMongoStore(config.mongoUri, config.dbName);
const deps = {
  config, store, limiter: createLimiter(),
  mailer: createMailer(config.smtpUrl, config.mailFrom),
  ai: createAiClient(config.aiServiceUrl, config.aiServiceToken),
};
const app = createApp(deps);

if (!config.smtpUrl) console.warn("[mail] SMTP_URL yoxdur: təsdiq kodları email göndərilmir, bu konsola yazılır (yalnız inkişaf üçün).");
const server = app.listen(config.port, () => console.log(`Portal API: http://localhost:${config.port}`));
attachRealtime(server, deps); // canlı söhbət üçün WebSocket (/ws)
startReportScheduler(deps); // aylıq e-poçt hesabatı (ayın 1-i)
for (const sig of ["SIGINT", "SIGTERM"] as const) process.on(sig, () => server.close(() => store.close().then(() => process.exit(0))));
