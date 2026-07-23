/**
 * Aufnahme einer Bridge über ARI (`bridge.record`). Asterisk schreibt die Datei nach
 * /var/spool/asterisk/recording/<name>.wav; nach Stop lädt der callHandler sie in GridFS.
 *
 * ⚠ Verifikationspunkt (Plan): Format/Optionen (mixed vs. getrennte Spuren) und der genaue
 *   Ablageort je Asterisk-Version sind beim Spike zu bestätigen.
 */
import { open } from "node:fs/promises";
import path from "node:path";

import type { AriBridge } from "ari-client";

import { config } from "../config.js";
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
  // Bei 16-kHz-Pipeline in Asterisks "wav16" aufnehmen (sonst rechnete Asterisk auf
  // 8 kHz herunter); Dateiendung folgt dem Formatnamen, der Inhalt ist normales RIFF-WAV.
  const format = config.audio.sampleRate >= 16000 ? "wav16" : "wav";
  try {
    const live = await bridge.record({
      name,
      format,
      ifExists: "overwrite",
      beep: false,
      terminateOn: "none",
    });
    log.info("Bridge-Aufnahme gestartet", { name, format });
    return {
      name,
      filePath: path.join(SPOOL_DIR, `${name}.${format}`),
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

/**
 * Dauer einer (kanonischen) WAV-Datei in Sekunden, aus dem Header berechnet:
 * (Dateigröße − 44-Byte-Header) / byteRate. Für die Asterisk-Aufnahmen (slin mono
 * 16-bit, 8 wie 16 kHz — byteRate steht im Header) ausreichend genau; bei Problemen 0.
 */
export async function wavDurationSec(filePath: string): Promise<number> {
  const fh = await open(filePath, "r");
  try {
    const header = Buffer.alloc(44);
    await fh.read(header, 0, 44, 0);
    const byteRate = header.readUInt32LE(28); // Bytes pro Sekunde
    const { size } = await fh.stat();
    if (byteRate <= 0 || size <= 44) return 0;
    return Math.round(((size - 44) / byteRate) * 10) / 10; // 1 Nachkommastelle
  } finally {
    await fh.close();
  }
}
