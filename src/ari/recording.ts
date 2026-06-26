/**
 * Aufnahme einer Bridge über ARI (`bridge.record`). Asterisk schreibt die Datei nach
 * /var/spool/asterisk/recording/<name>.wav; nach Stop lädt der callHandler sie in GridFS.
 *
 * ⚠ Verifikationspunkt (Plan): Format/Optionen (mixed vs. getrennte Spuren) und der genaue
 *   Ablageort je Asterisk-Version sind beim Spike zu bestätigen.
 */
import path from "node:path";

import type { AriBridge } from "ari-client";

import { logger } from "../util/logger.js";

const SPOOL_DIR = "/var/spool/asterisk/recording";
const log = logger.child({ mod: "recording" });

export interface ActiveRecording {
  name: string;
  /** Voraussichtlicher Dateipfad nach Stop. */
  filePath: string;
  stop(): Promise<void>;
}

export async function startBridgeRecording(bridge: AriBridge, callId: string): Promise<ActiveRecording | null> {
  const name = `rec-${callId}`;
  try {
    const live = await bridge.record({
      name,
      format: "wav",
      ifExists: "overwrite",
      beep: false,
      terminateOn: "none",
    });
    log.info("Bridge-Aufnahme gestartet", { name });
    return {
      name,
      filePath: path.join(SPOOL_DIR, `${name}.wav`),
      async stop() {
        try {
          await live.stop();
        } catch (err) {
          log.warn("Aufnahme-Stop fehlgeschlagen", { err: String(err) });
        }
      },
    };
  } catch (err) {
    log.error("Aufnahme konnte nicht gestartet werden", { err: String(err) });
    return null;
  }
}
