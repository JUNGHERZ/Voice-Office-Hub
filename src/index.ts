/**
 * Bootstrap der Telefonie-Komponente:
 *   Config laden → MongoDB verbinden → Tools registrieren → ARI verbinden & Stasis starten.
 */
import { config } from "./config.js";
import { connectMongo, disconnectMongo } from "./db/mongo.js";
import { failOrphanedRequests } from "./db/repository.js";
import { startAri } from "./ari/ariClient.js";
import { audioSocketServer } from "./ari/audiosocketServer.js";
import { registerAllTools } from "./tools/index.js";
import { printBanner } from "./util/banner.js";
import { logger } from "./util/logger.js";

const log = logger.child({ mod: "bootstrap" });

process.on("unhandledRejection", (reason) => {
  log.error("Unbehandelte Promise-Rejection", { reason: String(reason) });
});
process.on("uncaughtException", (err) => {
  log.error("Uncaught Exception", { err: String(err) });
});

async function main(): Promise<void> {
  printBanner();
  log.info("Starte Voice-Office-Hub", {
    app: config.ari.app,
    llm: config.llm.provider,
    embedAsterisk: config.ari.embedAsterisk,
    echoTest: config.echoTest,
  });

  if (!config.echoTest && !config.deepgram.apiKey) {
    log.warn("DEEPGRAM_API_KEY ist leer — Anrufe scheitern bis ein Key gesetzt ist.");
  }

  await connectMongo();

  // Verwaiste Anrufe der Vor-Instanz schließen (Absturz/Redeploy mitten im Gespräch):
  // beim Engine-Start KANN nichts mehr in_progress sein — Reste würden sonst dauerhaft
  // in der Live-Ansicht als „laufend" erscheinen.
  const orphaned = await failOrphanedRequests();
  if (orphaned > 0) log.warn("Verwaiste in_progress-Requests als failed markiert", { count: orphaned });

  registerAllTools();
  if (config.audio.transport === "audiosocket") {
    await audioSocketServer.start();
  }
  const client = await startAri();

  const shutdown = async (signal: string) => {
    log.info("Shutdown", { signal });
    try {
      client.stop?.();
    } catch { /* ignore */ }
    await audioSocketServer.stop().catch(() => undefined);
    await disconnectMongo().catch(() => undefined);
    process.exit(0);
  };

  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
}

main().catch((err) => {
  log.error("Fataler Startfehler", { err: String(err) });
  process.exit(1);
});
