/**
 * ARI-Verbindung zu Asterisk: verbindet, registriert die Stasis-App und routet
 * StasisStart an den callHandler. Reconnect mit einfachem Backoff.
 */
import ari, { type AriClient } from "ari-client";

import { config } from "../config.js";
import { logger } from "../util/logger.js";
import { handleStasisStart } from "./callHandler.js";

const log = logger.child({ mod: "ari" });

export async function startAri(): Promise<AriClient> {
  const client = await connectWithRetry();

  client.on("StasisStart", (event: any, channel: any) => {
    // Von uns selbst erzeugte Media-/Hilfskanäle ignorieren — nur echte eingehende Anrufe.
    // externalMedia-Kanäle heißen "UnicastRTP/..." (RTP) bzw. "AudioSocket/..." (AudioSocket)
    // und treten ebenfalls in die Stasis-App ein.
    const args: string[] = event?.args ?? [];
    const name: string = channel?.name ?? "";
    if (args[0] === "transfer" || name.startsWith("UnicastRTP") || name.startsWith("AudioSocket")) {
      log.debug("Ignoriere eigenen Media-/Hilfskanal", { name, args });
      return;
    }
    handleStasisStart(client, channel, args).catch((err) =>
      log.error("handleStasisStart-Fehler", { err: String(err) }),
    );
  });

  client.on("StasisEnd", (_event: any, channel: any) => {
    log.debug("StasisEnd", { channel: channel?.id });
  });

  client.start(config.ari.app);
  log.info("Stasis-App registriert", { app: config.ari.app });
  return client;
}

async function connectWithRetry(): Promise<AriClient> {
  let attempt = 0;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      const client = await ari.connect(config.ari.url, config.ari.username, config.ari.password);
      log.info("Mit ARI verbunden", { url: config.ari.url });
      return client;
    } catch (err) {
      attempt += 1;
      const delay = Math.min(30_000, 1000 * 2 ** Math.min(attempt, 5));
      log.warn("ARI-Verbindung fehlgeschlagen — Retry", { attempt, delayMs: delay, err: String(err) });
      await new Promise((r) => setTimeout(r, delay));
    }
  }
}
