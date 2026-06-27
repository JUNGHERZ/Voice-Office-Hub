/**
 * Modus B — Passthrough/Aufnahme.
 *
 * Keine KI: der Anruf wird an eine fest hinterlegte Nummer (agent.passthroughTarget)
 * durchgeleitet, beide Beine liegen in einer Mixing-Bridge und werden gemeinsam aufgezeichnet.
 * Legt eine Seite auf, endet der ganze Anruf. Nach dem Auflegen: Aufnahme in GridFS +
 * Batch-Transkription (Deepgram Pre-recorded, Diarization) → ins requests-Dokument.
 */
import { rm } from "node:fs/promises";

import type { AriChannel, AriClient } from "ari-client";

import { uploadRecording } from "../db/gridfs.js";
import * as repo from "../db/repository.js";
import { transcribeRecording } from "../deepgram/transcribe.js";
import { runPostCallSummary } from "../llm/summarize.js";
import type { ResolvedAgent } from "../types.js";
import { logger } from "../util/logger.js";
import { startBridgeRecording, type ActiveRecording } from "./recording.js";
import { transferIntoBridge } from "./transfer.js";

export async function handlePassthrough(
  client: AriClient,
  channel: AriChannel,
  agent: ResolvedAgent,
  meta: { targetNumber?: string; callerNumber?: string },
): Promise<void> {
  const log = logger.child({ mod: "passthrough", channel: channel.id });
  const target = agent.passthroughTarget;

  const requestId = await repo.createRequest({
    channelId: channel.id,
    mode: "passthrough",
    callerNumber: meta.callerNumber,
    targetNumber: meta.targetNumber,
    ...(agent.id ? { agentId: agent.id as unknown as never } : {}),
  });

  if (!target) {
    log.error("Passthrough ohne Zielnummer (PASSTHROUGH_TARGET) — Abbruch");
    await repo.finalizeRequest(requestId, "failed");
    try { await channel.hangup(); } catch { /* ignore */ }
    return;
  }

  let bridge: any;
  let calleeChannel: any; // der durchverbundene Ziel-Kanal
  let recording: ActiveRecording | null = null;
  let cleaned = false;

  // Beide Beine sind verbunden: legt eine Seite auf, beenden wir die andere ebenfalls.
  const onCallerGone = (_ev: unknown, ch: AriChannel) => {
    if (ch.id === channel.id) void cleanup("completed");
  };
  const onCalleeGone = (_ev: unknown, ch: AriChannel) => {
    if (calleeChannel && ch?.id === calleeChannel.id) void cleanup("completed");
  };

  const cleanup = async (status: "completed" | "failed") => {
    if (cleaned) return;
    cleaned = true;
    log.info("Passthrough-Teardown", { status });
    client.removeListener("StasisEnd", onCallerGone);
    client.removeListener("ChannelDestroyed", onCalleeGone);

    try { if (recording) await recording.stop(); } catch { /* ignore */ }
    // Beide Beine + Bridge beenden (durchgeschaltete Beendigung).
    try { await calleeChannel?.hangup(); } catch { /* ignore */ }
    try { await channel.hangup(); } catch { /* ignore */ }
    try { await bridge?.destroy(); } catch { /* ignore */ }

    if (recording) {
      try {
        const gridFsId = await uploadRecording(recording.filePath, `${requestId}.wav`, { requestId });
        await repo.setRecording(requestId, { gridFsId, filename: `${requestId}.wav`, channels: "mixed" });

        // Batch-Transkription (Diarization → caller/callee) — VOR dem Löschen der temp-WAV.
        await repo.setTranscriptionStatus(requestId, "pending");
        const turns = await transcribeRecording(recording.filePath, { language: agent.language });
        for (const turn of turns) await repo.appendTranscript(requestId, turn);
        await repo.setTranscriptionStatus(requestId, "done");
        log.info("Passthrough-Transkription fertig", { turns: turns.length });

        await rm(recording.filePath, { force: true });

        // Post-Call-Summary über das Batch-Transkript (asynchron, blockiert nichts).
        if (agent.summary.enabled) void runPostCallSummary(requestId, agent, log);
      } catch (err) {
        log.warn("Aufnahme/Transkription fehlgeschlagen", { err: String(err) });
        await repo.setTranscriptionStatus(requestId, "failed");
      }
    }

    await repo.finalizeRequest(requestId, status);
  };

  try {
    await channel.answer();
    await repo.setTransfer(requestId, { attempted: true, target });

    bridge = await client.bridges.create({ type: "mixing" });
    await bridge.addChannel({ channel: channel.id });

    recording = await startBridgeRecording(bridge, requestId);

    const { connected, channel: callee } = await transferIntoBridge(client, bridge, target);
    await repo.setTransfer(requestId, { attempted: true, target, connected });
    if (!connected) {
      log.info("Passthrough-Ziel nicht erreichbar", { target });
      await cleanup("completed");
      return;
    }
    calleeChannel = callee;
    log.info("Passthrough verbunden", { target });

    // Ende, sobald eine der beiden Seiten auflegt.
    client.on("StasisEnd", onCallerGone);
    client.on("ChannelDestroyed", onCalleeGone);
  } catch (err) {
    log.error("Passthrough-Fehler", { err: String(err) });
    await cleanup("failed");
  }
}
