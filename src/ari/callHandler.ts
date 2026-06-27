/**
 * Orchestriert einen einzelnen Anruf (Modus "agent"):
 *   answer → Bridge → externalMedia → Deepgram-Session → Audio-Bridging → Events → Teardown.
 *
 * Bei Modus "passthrough" wird an das passthrough-Modul delegiert.
 */
import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";

import type { AriChannel, AriClient } from "ari-client";

import { config } from "../config.js";
import { buildSettings } from "../deepgram/settings.js";
import { AgentSession } from "../deepgram/agentSession.js";
import * as repo from "../db/repository.js";
import { uploadRecording } from "../db/gridfs.js";
import { runPostCallSummary } from "../llm/summarize.js";
import { buildFunctionDefinitions, dispatchTool, type ToolContext } from "../tools/index.js";
import type { ResolvedAgent } from "../types.js";
import { logger } from "../util/logger.js";
import { resolveAgent } from "./agentResolver.js";
import { MediaBridge } from "./media.js";
import { audioSocketServer, type MediaSession } from "./audiosocketServer.js";
import { startBridgeRecording, wavDurationSec, type ActiveRecording } from "./recording.js";
import { transferIntoBridge } from "./transfer.js";
import { handlePassthrough } from "./passthrough.js";

export async function handleStasisStart(
  client: AriClient,
  channel: AriChannel,
  args: string[],
): Promise<void> {
  const targetNumber = args[0] || undefined;
  const callerNumber = args[1] || undefined;
  const log = logger.child({ mod: "call", channel: channel.id });
  log.info("StasisStart", { targetNumber, callerNumber, echoTest: config.echoTest });

  // Spike/Diagnose: externalMedia-Pfad ohne Deepgram verifizieren.
  if (config.echoTest) {
    await runEchoTest(client, channel, log);
    return;
  }

  const agent = await resolveAgent(targetNumber);

  if (agent.mode === "passthrough") {
    await handlePassthrough(client, channel, agent, { targetNumber, callerNumber });
    return;
  }

  await runAgentCall(client, channel, agent, { targetNumber, callerNumber, log });
}

type Media = MediaBridge | MediaSession;

/**
 * Transport-abhängige Media-Anbindung erzeugen.
 *  - audiosocket: Session am geteilten Server registrieren (UUID-Zuordnung)
 *  - rtp: per-Anruf UDP-Bridge
 */
function createMedia(callId: string, uuid: string): Media {
  return config.audio.transport === "rtp"
    ? new MediaBridge(config.audio.externalMediaPort, callId)
    : audioSocketServer.register(uuid, callId);
}

/** externalMedia-Kanal passend zum Transport anlegen (UUID = AudioSocket-Connection-ID). */
async function createExternalMedia(client: AriClient, uuid: string): Promise<any> {
  const params: Record<string, unknown> = {
    app: config.ari.app,
    external_host: `${config.audio.externalMediaHost}:${config.audio.externalMediaPort}`,
    format: config.audio.externalMediaFormat,
  };
  if (config.audio.transport === "audiosocket") {
    params.encapsulation = "audiosocket";
    params.transport = "tcp";
    params.data = uuid; // sonst ARI: "data can not be empty"
  }
  return client.channels.externalMedia(params);
}

/**
 * Echo-Test: Anrufer-Audio über externalMedia empfangen und unverändert zurückspielen.
 * Verifiziert die Media-Bridge (RTP/Framing) isoliert, ohne Deepgram/LLM/DB.
 */
async function runEchoTest(
  client: AriClient,
  channel: AriChannel,
  log: ReturnType<typeof logger.child>,
): Promise<void> {
  let bridge: any;
  let externalChannel: any;
  let media: Media | undefined;
  let cleaned = false;

  const onStasisEnd = (_ev: unknown, ch: AriChannel) => {
    if (ch.id === channel.id) void cleanup();
  };
  const cleanup = async () => {
    if (cleaned) return;
    cleaned = true;
    log.info("Echo-Test Teardown");
    client.removeListener("StasisEnd", onStasisEnd);
    media?.close();
    try { await externalChannel?.hangup(); } catch { /* ignore */ }
    try { await bridge?.destroy(); } catch { /* ignore */ }
  };

  try {
    await channel.answer();
    bridge = await client.bridges.create({ type: "mixing" });
    await bridge.addChannel({ channel: channel.id });

    const uuid = randomUUID();
    media = createMedia(channel.id, uuid);
    if (config.echoMode === "raw") {
      media.enableRawEcho(); // 1:1 zurück
    } else {
      let frames = 0;
      media.on("audio", (pcm) => {
        frames += 1;
        if (frames === 1) log.info("Echo: erstes Audio empfangen → spiele zurück", { transport: config.audio.transport });
        media?.sendAudio(pcm);
      });
    }
    await media.start();

    externalChannel = await createExternalMedia(client, uuid);
    await bridge.addChannel({ channel: externalChannel.id });

    client.on("StasisEnd", onStasisEnd);
    log.info("Echo-Test bereit — sprich ins Telefon, du solltest dich selbst hören");
  } catch (err) {
    log.error("Echo-Test-Fehler", { err: String(err) });
    await cleanup();
    try { await channel.hangup(); } catch { /* ignore */ }
  }
}

interface CallMeta {
  targetNumber?: string;
  callerNumber?: string;
  log: ReturnType<typeof logger.child>;
}

async function runAgentCall(
  client: AriClient,
  channel: AriChannel,
  agent: ResolvedAgent,
  meta: CallMeta,
): Promise<void> {
  const { log } = meta;
  const startTime = Date.now();
  const elapsed = () => (Date.now() - startTime) / 1000;

  const requestId = await repo.createRequest({
    channelId: channel.id,
    mode: "agent",
    callerNumber: meta.callerNumber,
    targetNumber: meta.targetNumber,
    ...(agent.id ? { agentId: agent.id as unknown as never } : {}),
  });

  let bridge: any;
  let externalChannel: any;
  let media: Media | undefined;
  let session: AgentSession | undefined;
  let recording: ActiveRecording | null = null;
  let transferActive = false; // voller Mute (beide Richtungen) — nach erfolgreichem Connect
  let transferRinging = false; // während des Klingelns: Agent hört nicht zu, Ansage darf noch raus
  let calleeChannel: any; // bei erfolgreichem Transfer: der durchverbundene Ziel-Kanal
  let endRequested = false;
  let lastAudioAt = 0; // Zeitpunkt des zuletzt empfangenen Agent-Audios (für Drain-Erkennung)
  let audioSinceEnd = false; // kam nach end_call noch Audio (der Abschied)?
  let drainInterval: NodeJS.Timeout | undefined;
  let hangupTimer: NodeJS.Timeout | undefined;
  let cleaned = false;

  const onEnd = (_ev: unknown, ch: AriChannel) => {
    if (ch.id === channel.id) void cleanup("completed");
  };

  // Durchgeschaltete Beendigung: legt der durchverbundene Mitarbeiter (Ziel) auf, endet der Anruf.
  const onCalleeGone = (_ev: unknown, ch: AriChannel) => {
    if (calleeChannel && ch?.id === calleeChannel.id) void cleanup("completed");
  };

  const cleanup = async (status: "completed" | "failed") => {
    if (cleaned) return;
    cleaned = true;
    log.info("Teardown", { status });
    if (hangupTimer) clearTimeout(hangupTimer);
    if (drainInterval) clearInterval(drainInterval);
    client.removeListener("StasisEnd", onEnd);
    client.removeListener("ChannelDestroyed", onCalleeGone);
    try {
      if (recording) await recording.stop();
    } catch { /* ignore */ }
    session?.close();
    media?.close();
    // Beide Beine + Medienkanal beenden (durchgeschaltete Beendigung).
    try { await calleeChannel?.hangup(); } catch { /* ignore */ }
    try { await externalChannel?.hangup(); } catch { /* ignore */ }
    try { await channel.hangup(); } catch { /* ignore */ }
    try { await bridge?.destroy(); } catch { /* ignore */ }

    // Aufnahme in GridFS ablegen (best effort), danach die temporäre WAV löschen.
    if (recording) {
      try {
        const gridFsId = await uploadRecording(recording.filePath, `${requestId}.wav`, { requestId });
        const durationSec = await wavDurationSec(recording.filePath).catch(() => 0);
        await repo.setRecording(requestId, { gridFsId, filename: `${requestId}.wav`, durationSec });
        await rm(recording.filePath, { force: true });
      } catch (err) {
        log.warn("GridFS-Upload fehlgeschlagen", { err: String(err) });
      }
    }

    await repo.finalizeRequest(requestId, status);

    // Post-Call-Summary (asynchron, blockiert nicht).
    if (status === "completed" && agent.summary.enabled) {
      void runPostCallSummary(requestId, agent, log);
    }
  };

  try {
    await channel.answer();

    bridge = await client.bridges.create({ type: "mixing" });
    await bridge.addChannel({ channel: channel.id });

    // externalMedia-Kanal: Asterisk streamt Audio (AudioSocket/TCP oder RTP) an uns.
    const uuid = randomUUID();
    media = createMedia(channel.id, uuid);
    await media.start();

    externalChannel = await createExternalMedia(client, uuid);
    await bridge.addChannel({ channel: externalChannel.id });

    // Deepgram-Session aufbauen.
    const functions = buildFunctionDefinitions(agent.tools);
    const settings = buildSettings(agent, functions);
    session = new AgentSession(settings, channel.id);

    const toolCtx: ToolContext = {
      callId: requestId,
      ...(meta.callerNumber ? { callerNumber: meta.callerNumber } : {}),
      requestTransfer: async (target: string) => {
        // Klingel-Phase: Agent hört nicht mehr auf den Anrufer (reagiert nicht), ABER die bereits
        // begonnene Ansage ("Einen Moment bitte…") darf noch ausgespielt werden (kein flush, Output offen).
        // Das Zieltelefon klingelt parallel.
        transferRinging = true;
        await repo.setTransfer(requestId, { attempted: true, target });
        const result = await transferIntoBridge(client, bridge, target);
        await repo.setTransfer(requestId, { attempted: true, target, connected: result.connected });
        transferRinging = false;
        if (result.connected) {
          // Mensch hat übernommen → Agent voll stumm, hört NICHT mit. Anruf läuft Anrufer ↔ Mitarbeiter.
          transferActive = true;
          calleeChannel = result.channel;
          // Legt der Mitarbeiter auf, endet der ganze Anruf (Caller-Hangup deckt cleanup ohnehin ab).
          client.on("ChannelDestroyed", onCalleeGone);
        } else {
          // Niemand erreichbar → Agent ist wieder voll aktiv und setzt den Kontext fort.
          session?.injectMessage("Ich konnte leider niemanden erreichen. Wir machen zusammen weiter.");
        }
        return result;
      },
      requestHangup: async () => {
        if (endRequested) return;
        endRequested = true;
        const startedAt = Date.now();
        log.info("Auflegen angefordert (end_call) — warte auf Ende des Abschieds");
        // Datengetrieben: auflegen, sobald das Agent-Audio aufgehört hat zu fließen UND der
        // Playout-Puffer leer ist. Der Abschied kann als TTS-Audio erst NACH dem (textbasierten)
        // end_call eintreffen → wir geben ihm eine Anlaufzeit (Grace), falls noch nichts kam.
        drainInterval = setInterval(() => {
          if (cleaned) { if (drainInterval) clearInterval(drainInterval); return; }
          const now = Date.now();
          const pending = media && "pendingMs" in media ? media.pendingMs() : 0;
          const idleAudio = now - lastAudioAt;
          if (pending >= 120 || idleAudio <= 800) return; // spielt noch / Audio kam gerade
          // Puffer leer und seit >800 ms kein Audio mehr:
          if (audioSinceEnd || now - startedAt > 3_500) void hangup(); // Abschied gespielt ODER keiner kam
        }, 150);
        // Absolute Obergrenze.
        hangupTimer = setTimeout(() => void hangup(), 20_000);
      },
    };

    const hangup = async () => {
      if (hangupTimer) { clearTimeout(hangupTimer); hangupTimer = undefined; }
      if (drainInterval) { clearInterval(drainInterval); drainInterval = undefined; }
      try { await channel.hangup(); } catch { /* ignore */ }
    };

    // ── Audio-Bridging ──────────────────────────────────────────────────────
    media.on("audio", (pcm) => {
      // Anrufer-Audio NICHT an Deepgram während Transfer (voll) oder Klingelphase (Agent hört nicht zu).
      if (!transferActive && !transferRinging) session?.sendAudio(pcm);
    });
    session.on("audio", (chunk) => {
      if (transferActive) return;
      lastAudioAt = Date.now();
      if (endRequested) audioSinceEnd = true; // der Abschied nach end_call fließt
      media?.sendAudio(chunk);
    });

    // ── Deepgram-Events ──────────────────────────────────────────────────────
    session.on("welcome", (rid) => log.info("Deepgram Welcome", { rid }));
    session.on("userStartedSpeaking", () => media?.flush()); // Barge-in
    session.on("conversationText", (ev) => {
      const speaker = ev.role === "assistant" ? "agent" : "caller";
      void repo.appendTranscript(requestId, { t: elapsed(), speaker, text: ev.content });
    });
    session.on("agentStartedSpeaking", (lat) => log.debug("AgentStartedSpeaking", lat));
    session.on("functionCallRequest", async (ev) => {
      for (const fn of ev.functions) {
        if (!fn.client_side) continue;
        log.info("FunctionCall", { name: fn.name, args: fn.arguments });
        const requestedAt = new Date();
        const result = await dispatchTool(fn.name, fn.arguments, toolCtx);
        // Bei end_call (setzt endRequested) KEINE FunctionCallResponse senden — sonst startet
        // Deepgram eine zweite Abschiedsrunde (doppeltes "Auf Wiederhören"). Der Abschied ist
        // bereits vor dem Tool-Aufruf gesprochen worden; danach wird aufgelegt.
        if (!endRequested) session?.sendFunctionResponse(fn.id, fn.name, result);
        void repo.appendFunctionCall(requestId, {
          name: fn.name,
          arguments: safeParse(fn.arguments),
          result,
          status: "ok",
          requestedAt,
          completedAt: new Date(),
        });
      }
    });
    session.on("error", (desc) => log.error("Deepgram-Fehler", { desc }));

    // Aufnahme starten (best effort).
    recording = await startBridgeRecording(bridge, requestId);

    // ── Hangup-Handling ──────────────────────────────────────────────────────
    client.on("StasisEnd", onEnd);
    channel.on("ChannelDestroyed", () => void cleanup("completed"));
  } catch (err) {
    log.error("Fehler im Anrufaufbau", { err: String(err) });
    await cleanup("failed");
    try { await channel.hangup(); } catch { /* ignore */ }
  }
}

function safeParse(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}
