/**
 * Modus B — Passthrough/Aufnahme (spätere Ausbaustufe, Grundgerüst).
 *
 * Keine KI: der Anruf wird an eine fest hinterlegte Nummer weitergeleitet, beide Kanäle
 * werden aufgezeichnet. Nach Auflegen beider Seiten: Aufnahme in GridFS + Batch-Transkription
 * (Deepgram Pre-recorded, Diarization) → ins requests-Dokument.
 */
import type { AriChannel, AriClient } from "ari-client";

import { uploadRecording } from "../db/gridfs.js";
import * as repo from "../db/repository.js";
import { transcribeRecording } from "../deepgram/transcribe.js";
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
    log.error("Passthrough ohne Zielnummer — Abbruch");
    await repo.finalizeRequest(requestId, "failed");
    try { await channel.hangup(); } catch { /* ignore */ }
    return;
  }

  let bridge: any;
  let recording: ActiveRecording | null = null;
  let cleaned = false;

  const cleanup = async () => {
    if (cleaned) return;
    cleaned = true;
    try { if (recording) await recording.stop(); } catch { /* ignore */ }
    try { await bridge?.destroy(); } catch { /* ignore */ }

    if (recording) {
      try {
        const gridFsId = await uploadRecording(recording.filePath, `${requestId}.wav`, { requestId });
        await repo.setRecording(requestId, { gridFsId, filename: `${requestId}.wav` });
        // Batch-Transkription (Diarization → caller/callee).
        await repo.setTranscriptionStatus(requestId, "pending");
        const turns = await transcribeRecording(recording.filePath);
        for (const turn of turns) await repo.appendTranscript(requestId, turn);
        await repo.setTranscriptionStatus(requestId, "done");
      } catch (err) {
        log.warn("Aufnahme/Transkription fehlgeschlagen", { err: String(err) });
      }
    }
    await repo.finalizeRequest(requestId, "completed");
  };

  try {
    await channel.answer();
    await repo.setTransfer(requestId, { attempted: true, target });

    bridge = await client.bridges.create({ type: "mixing" });
    await bridge.addChannel({ channel: channel.id });

    recording = await startBridgeRecording(bridge, requestId);

    const { connected } = await transferIntoBridge(client, bridge, target);
    await repo.setTransfer(requestId, { attempted: true, target, connected });
    if (!connected) {
      log.info("Passthrough-Ziel nicht erreichbar");
      await cleanup();
      try { await channel.hangup(); } catch { /* ignore */ }
      return;
    }

    client.on("StasisEnd", (_ev: unknown, ch: AriChannel) => {
      if (ch.id === channel.id) void cleanup();
    });
  } catch (err) {
    log.error("Passthrough-Fehler", { err: String(err) });
    await cleanup();
  }
}
