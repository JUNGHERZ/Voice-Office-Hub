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
  await warnOnAudioSocket16k(client);

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

/**
 * Betriebsschutz: AudioSocket überträgt bis einschließlich Asterisk 22.6 IMMER slin@8kHz —
 * `externalMedia format=slin16` setzt dort nur die NativeFormats-Deklaration (Write/Read
 * bleiben slin), 16-kHz-Audio läuft dann mit halber Geschwindigkeit („Murmelstimmen").
 * Multi-Format-AudioSocket (Message-Typen 0x11–0x18) gibt es erst ab Asterisk 22.7 —
 * und erfordert zusätzlich eine Protokoll-Anpassung unseres Servers.
 */
async function warnOnAudioSocket16k(client: AriClient): Promise<void> {
  if (config.audio.sampleRate <= 8000 || config.audio.transport !== "audiosocket") return;
  try {
    const info = await (client as unknown as {
      asterisk: { getInfo(): Promise<{ system?: { version?: string } }> };
    }).asterisk.getInfo();
    const version = info?.system?.version ?? "unbekannt";
    const [maj = 0, min = 0] = version.split(".").map((v) => parseInt(v, 10));
    const supported = maj > 22 || (maj === 22 && min >= 7);
    if (!supported) {
      log.error(
        "AUDIO_SAMPLE_RATE > 8000 mit AudioSocket, aber dieses Asterisk kann nur slin@8k — " +
          "Audio läuft mit falscher Geschwindigkeit! 16 kHz erfordert Asterisk >= 22.7 " +
          "(Multi-Format-AudioSocket). Bitte AUDIO_SAMPLE_RATE=8000 + EXTERNAL_MEDIA_FORMAT=slin setzen.",
        { asteriskVersion: version },
      );
    }
  } catch (err) {
    log.warn("Asterisk-Versionsprüfung fehlgeschlagen", { err: String(err) });
  }
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
