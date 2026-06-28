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
import type { ResolvedAgent } from "../types.js";
import { logger } from "../util/logger.js";
import { looksExternal, toSipgateCli } from "../util/phone.js";

const log = logger.child({ mod: "transfer" });

export interface TransferOptions {
  /** Absender-CLI (sipgate-Format `49…`) für externe Wahl über den Trunk → P-Preferred-Identity. */
  callerId?: string;
  appArgs?: string;
}

/**
 * Entscheidet, WIE ein Transfer-Ziel gewählt wird:
 *  - **intern** (kurze Durchwahl, z. B. `101`) → `PJSIP/<ziel>` wie bisher, keine CLI.
 *  - **extern** (PSTN/Mobil) → `PJSIP/<e164>@<trunk-endpoint>` + Absender-CLI.
 *    CLI = Original-Anrufernummer, wenn `agent.useTransferCallerId` UND der Trunk CLIP no screening
 *    erlaubt (`TRUNK_CLIP_NO_SCREENING`); sonst die eigene Agent-DID (bzw. `OUTBOUND_CALLER_ID`).
 */
export function resolveOutboundTransfer(
  agent: Pick<ResolvedAgent, "targetNumbers" | "useTransferCallerId">,
  target: string,
  callerNumber?: string,
): { target: string; callerId?: string } {
  if (!looksExternal(target)) return { target };

  // Ziel als E.164 mit führendem "+" (sipgate erwartet das im Request-URI).
  const dialNumber = `+${toSipgateCli(target)}`;
  const ownRaw = (agent.targetNumbers ?? []).find(looksExternal) || config.trunk.outboundCallerId;
  const ownCli = toSipgateCli(ownRaw);

  let callerId = ownCli;
  if (agent.useTransferCallerId) {
    if (config.trunk.clipNoScreening) {
      callerId = toSipgateCli(callerNumber) || ownCli;
    } else {
      log.warn("useTransferCallerId aktiv, aber TRUNK_CLIP_NO_SCREENING=false → eigene Nummer", {
        callerNumber,
      });
    }
  }

  return { target: `${dialNumber}@${config.trunk.endpoint}`, callerId: callerId || undefined };
}

export async function transferIntoBridge(
  client: AriClient,
  bridge: AriBridge,
  target: string,
  opts: TransferOptions = {},
): Promise<{ connected: boolean; channel?: any }> {
  const appArgs = opts.appArgs ?? "transfer";
  const endpoint = target.startsWith("PJSIP/") ? target : `PJSIP/${target}`;
  let outbound: any;

  try {
    outbound = client.Channel();
  } catch {
    // Ältere ari-client-API: channels.originate
    outbound = undefined;
  }

  return new Promise<{ connected: boolean; channel?: any }>((resolve) => {
    let settled = false;
    const done = (connected: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      client.removeListener("StasisStart", onStart);
      client.removeListener("ChannelDestroyed", onDestroyed);
      // Bei Erfolg den Ziel-Kanal zurückgeben, damit der callHandler die durchgeschaltete
      // Beendigung verdrahten kann (legt eine Seite auf → ganzer Anruf endet).
      resolve({ connected, channel: connected ? outbound : undefined });
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

    const originateOpts: Record<string, unknown> = {
      endpoint,
      app: config.ari.app,
      appArgs,
      timeout: config.transfer.timeoutSec,
      formats: "slin16",
    };
    // Externe Wahl über den Trunk: Absender-Rufnummer setzen. sipgate wertet die angezeigte
    // Nummer aus `P-Preferred-Identity` aus (gesetzt als PJSIP-Header beim Kanalaufbau).
    if (opts.callerId) {
      originateOpts.callerId = opts.callerId;
      originateOpts.variables = {
        [`PJSIP_HEADER(add,${config.trunk.clipHeader})`]: `<sip:${opts.callerId}@${config.trunk.server}>`,
      };
    }

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
