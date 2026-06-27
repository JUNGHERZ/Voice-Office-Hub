/**
 * Bootstrap des Admin-Servers (eigener Prozess via supervisord).
 * Startet nur, wenn ADMIN_PASSWORD gesetzt ist.
 */
import { config } from "../config.js";
import { connectMongo } from "../db/mongo.js";
import { logger } from "../util/logger.js";
import { buildAdminServer } from "./server.js";

const log = logger.child({ mod: "admin" });

async function main(): Promise<void> {
  if (!config.admin.password) {
    log.warn("ADMIN_PASSWORD nicht gesetzt — Admin-Server startet nicht");
    return;
  }
  await connectMongo();
  const app = await buildAdminServer();
  await app.listen({ host: "0.0.0.0", port: config.admin.port });
  log.info("Admin-Server lauscht", { port: config.admin.port });
}

main().catch((err) => {
  log.error("Admin-Server-Start fehlgeschlagen", { err: String(err) });
  process.exitCode = 1;
});
