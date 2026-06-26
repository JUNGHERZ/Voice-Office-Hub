/**
 * Weiterleitung mit Auto-Rückkehr (Vorstufe Warm Transfer) über ARI.
 *
 * Ablauf:
 *   1. Neuen Kanal zum Ziel dialen und in die bestehende Bridge legen.
 *   2. Nimmt das Ziel innerhalb TRANSFER_TIMEOUT an → connected:true (Mensch ↔ Anrufer).
 *   3. Sonst (Timeout/abgelehnt/besetzt) → Kanal aufräumen, connected:false → der
 *      callHandler reaktiviert den Agenten (Session bleibt durchgehend offen, Kontext erhalten).
 */
import type { AriBridge, AriClient } from "ari-client";

import { config } from "../config.js";
import { logger } from "../util/logger.js";

const log = logger.child({ mod: "transfer" });

export async function transferIntoBridge(
  client: AriClient,
  bridge: AriBridge,
  target: string,
  appArgs = "transfer",
): Promise<{ connected: boolean }> {
  const endpoint = target.startsWith("PJSIP/") ? target : `PJSIP/${target}`;
  let outbound: any;

  try {
    outbound = client.Channel();
  } catch {
    // Ältere ari-client-API: channels.originate
    outbound = undefined;
  }

  return new Promise<{ connected: boolean }>((resolve) => {
    let settled = false;
    const done = (connected: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      client.removeListener("StasisStart", onStart);
      client.removeListener("ChannelDestroyed", onDestroyed);
      resolve({ connected });
    };

    const timer = setTimeout(async () => {
      log.info("Transfer-Timeout — Rückkehr zum Agenten", { target });
      await cleanup();
      done(false);
    }, config.transfer.timeoutSec * 1000);

    const cleanup = async () => {
      try {
        await outbound?.hangup?.();
      } catch {
        /* schon weg */
      }
    };

    const originateOpts = {
      endpoint,
      app: config.ari.app,
      appArgs,
      timeout: config.transfer.timeoutSec,
      formats: "slin16",
    };

    // Named handlers, damit removeListener sie in done() entfernen kann.
    const onStart = (_ev: unknown, ch: any) => {
      if (outbound && ch?.id === outbound.id) {
        // Ziel hat angenommen → in die Bridge legen.
        bridge
          .addChannel({ channel: outbound.id })
          .then(() => {
            log.info("Ziel verbunden", { target });
            done(true);
          })
          .catch(async (err: unknown) => {
            log.warn("addChannel fehlgeschlagen", { err: String(err) });
            await cleanup();
            done(false);
          });
      }
    };

    const onDestroyed = (_ev: unknown, ch: any) => {
      if (outbound && ch?.id === outbound.id && !settled) {
        log.info("Ziel-Kanal beendet (abgelehnt/besetzt)", { target });
        done(false);
      }
    };

    client.on("StasisStart", onStart);
    client.on("ChannelDestroyed", onDestroyed);

    const startOriginate = outbound
      ? outbound.originate(originateOpts)
      : client.channels.originate(originateOpts).then((ch: any) => (outbound = ch));

    Promise.resolve(startOriginate).catch(async (err: unknown) => {
      log.error("Originate fehlgeschlagen", { err: String(err) });
      await cleanup();
      done(false);
    });
  });
}
