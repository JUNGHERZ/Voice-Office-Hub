/**
 * Orchestriert einen einzelnen Anruf (Modus "agent"):
 *   answer → Bridge → externalMedia → Voice-Session (Provider laut Agent) → Audio-Bridging →
 *   Events → Teardown.
 *
 * Bei Modus "passthrough" wird an das passthrough-Modul delegiert.
 */
import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";

import type { AriChannel, AriClient } from "ari-client";

import { config } from "../config.js";
import * as repo from "../db/repository.js";
import { uploadRecording } from "../db/gridfs.js";
import { runPostCallSummary } from "../llm/summarize.js";
import { buildCallToolset, type CallToolset, type ToolContext } from "../tools/index.js";
import type { ResolvedAgent } from "../types.js";
import { logger } from "../util/logger.js";
import { createVoiceAgentSession } from "../voice/factory.js";
import type { VoiceAgentSession } from "../voice/types.js";
import { findAgent, defaultAgent } from "./agentResolver.js";
import { MediaBridge } from "./media.js";
import { audioSocketServer } from "./audiosocketServer.js";
import { startBridgeRecording, wavDurationSec, type ActiveRecording } from "./recording.js";
import { resolveOutboundTransfer, transferIntoBridge } from "./transfer.js";
import { handlePassthrough } from "./passthrough.js";

/**
 * Dedup gegen Doppel-INVITEs: SIP-Trunks (z. B. sipgate) stellen denselben Anruf
 * teils als zwei parallele Dialoge zu (Call-IDs unterscheiden sich nur minimal).
 * Wir merken uns je Anrufer→Ziel-Kombination den letzten Eingang; ein zweiter
 * innerhalb des Fensters wird aufgelegt, bevor eine zweite Session entsteht.
 */
const recentCalls = new Map<string, number>();

function isDuplicateCall(
  callerNumber: string | undefined,
  targetNumber: string | undefined,
  now: number,
): boolean {
  const window = config.callDedupWindowMs;
  if (window <= 0) return false;
  // Abgelaufene Einträge aufräumen (klein halten).
  for (const [k, ts] of recentCalls) if (now - ts > window) recentCalls.delete(k);
  const key = `${callerNumber ?? "?"}->${targetNumber ?? "?"}`;
  const prev = recentCalls.get(key);
  recentCalls.set(key, now);
  return prev !== undefined && now - prev <= window;
}

/** Nur für Tests: Dedup-Zustand zwischen Fällen zurücksetzen. */
export function resetCallDedup(): void {
  recentCalls.clear();
}

/** Der vom callHandler genutzte Ausschnitt der Repository-API (Fake-freundlich). */
export type CallRepo = Pick<
  typeof repo,
  "createRequest" | "appendTranscript" | "appendFunctionCall" | "setTransfer" | "setRecording" | "finalizeRequest"
>;

/**
 * Injizierbare Abhängigkeiten des Call-Pfads. Produktion nutzt `defaultDeps`;
 * Tests reichen über den optionalen 4. Parameter von `handleStasisStart` Fakes ein.
 */
export interface CallHandlerDeps {
  findAgent: typeof findAgent;
  defaultAgent: typeof defaultAgent;
  handlePassthrough: typeof handlePassthrough;
  createMedia: (callId: string, uuid: string) => CallMedia;
  createSession: typeof createVoiceAgentSession;
  buildCallToolset: typeof buildCallToolset;
  repo: CallRepo;
  startBridgeRecording: typeof startBridgeRecording;
  uploadRecording: typeof uploadRecording;
  runPostCallSummary: typeof runPostCallSummary;
  resolveOutboundTransfer: typeof resolveOutboundTransfer;
  transferIntoBridge: typeof transferIntoBridge;
  now: () => number;
}

export const defaultDeps: CallHandlerDeps = {
  findAgent,
  defaultAgent,
  handlePassthrough,
  createMedia,
  createSession: createVoiceAgentSession,
  buildCallToolset,
  repo,
  startBridgeRecording,
  uploadRecording,
  runPostCallSummary,
  resolveOutboundTransfer,
  transferIntoBridge,
  now: () => Date.now(),
};

export async function handleStasisStart(
  client: AriClient,
  channel: AriChannel,
  args: string[],
  depsOverride?: Partial<CallHandlerDeps>,
): Promise<void> {
  const deps: CallHandlerDeps = depsOverride ? { ...defaultDeps, ...depsOverride } : defaultDeps;
  const targetNumber = args[0] || undefined;
  const callerNumber = args[1] || undefined;
  const log = logger.child({ mod: "call", channel: channel.id });
  log.info("StasisStart", { targetNumber, callerNumber, echoTest: config.echoTest });

  // Doppel-INVITE des Trunks verwerfen (siehe isDuplicateCall).
  if (isDuplicateCall(callerNumber, targetNumber, deps.now())) {
    log.warn("Doppelter Anruf verworfen (Trunk-Duplikat)", { targetNumber, callerNumber });
    try { await channel.hangup(); } catch { /* ignore */ }
    return;
  }

  // Spike/Diagnose: externalMedia-Pfad ohne Voice-Provider verifizieren.
  if (config.echoTest) {
    await runEchoTest(client, channel, log);
    return;
  }

  let agent = await deps.findAgent(targetNumber);

  // Keine DDI-Zuordnung → konfiguriertes Verhalten (Default: ablehnen). Verhindert, dass
  // Scanner-/Fehlanrufe eine kostenpflichtige Default-Agent-Session + Logeintrag auslösen.
  if (!agent) {
    if (config.unknownNumber.behavior === "agent") {
      log.info("Kein Agent für DDI — Default-Agent (Dev)", { targetNumber });
      agent = deps.defaultAgent();
    } else {
      await handleUnknownNumber(client, channel, { targetNumber, callerNumber, log });
      return;
    }
  }

  if (agent.mode === "passthrough") {
    await deps.handlePassthrough(client, channel, agent, { targetNumber, callerNumber });
    return;
  }

  await runAgentCall(client, channel, agent, { targetNumber, callerNumber, log }, deps);
}

/**
 * Behandelt einen Anruf an eine NICHT zugeordnete Nummer ohne Agent/LLM:
 *   - "announce": kurz answern, Ansage abspielen, auflegen (kein Deepgram, minimal Kosten).
 *   - sonst ("reject"): VOR dem Answer mit 404 "unallocated" ablehnen → das Netz des
 *     Anrufers spielt die Standardansage ("kein Anschluss"). 0 Kosten, kein Logeintrag.
 * In beiden Fällen wird bewusst KEIN `requests`-Dokument angelegt (kein Log-Spam).
 */
async function handleUnknownNumber(
  client: AriClient,
  channel: AriChannel,
  meta: CallMeta,
): Promise<void> {
  const { log } = meta;
  const behavior = config.unknownNumber.behavior;
  log.warn("Unbekannte Nummer — kein Agent", { targetNumber: meta.targetNumber, behavior });

  if (behavior === "announce") {
    try {
      await channel.answer();
      const media = config.unknownNumber.announcement;
      const playback = await channel.play({ media });
      // Auf das Ende der Ansage warten (mit Sicherheits-Timeout), dann auflegen.
      await new Promise<void>((resolve) => {
        let done = false;
        const finish = () => { if (done) return; done = true; client.removeListener("PlaybackFinished", onFinished); resolve(); };
        const onFinished = (_ev: unknown, pb: any) => { if (pb?.id === playback.id) finish(); };
        client.on("PlaybackFinished", onFinished);
        setTimeout(finish, 15_000);
      });
    } catch (err) {
      log.warn("Ansage fehlgeschlagen", { err: String(err) });
    }
    try { await channel.hangup(); } catch { /* ignore */ }
    return;
  }

  // reject: ohne Answer mit "unallocated" (Q.850 #1) ablehnen → Netz-Standardansage.
  try {
    await channel.hangup({ reason: "unallocated" });
  } catch {
    try { await channel.hangup(); } catch { /* ignore */ }
  }
}

/**
 * Transportneutraler Media-Kontrakt — die Naht, an der Fakes (Tests) und künftige
 * Ingress-Varianten (z. B. ein WebRTC-Media-Adapter) andocken. `MediaSession`
 * (AudioSocket) und `MediaBridge` (RTP) erfüllen ihn strukturell.
 */
export interface CallMedia {
  start(): Promise<void>;
  on(event: "audio", listener: (pcm: Buffer) => void): unknown;
  sendAudio(pcm: Buffer): void;
  flush(): void;
  close(): void;
  enableRawEcho(): void;
  /** Noch nicht ausgespielte Audiozeit in ms (nur AudioSocket-Transport vorhanden). */
  pendingMs?(): number;
}

/**
 * Transport-abhängige Media-Anbindung erzeugen.
 *  - audiosocket: Session am geteilten Server registrieren (UUID-Zuordnung)
 *  - rtp: per-Anruf UDP-Bridge
 */
function createMedia(callId: string, uuid: string): CallMedia {
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
  let media: CallMedia | undefined;
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
  deps: CallHandlerDeps,
): Promise<void> {
  const { log } = meta;
  const startTime = Date.now();
  const elapsed = () => (Date.now() - startTime) / 1000;

  const requestId = await deps.repo.createRequest({
    channelId: channel.id,
    mode: "agent",
    callerNumber: meta.callerNumber,
    targetNumber: meta.targetNumber,
    ...(agent.id ? { agentId: agent.id as unknown as never } : {}),
  });

  let bridge: any;
  let externalChannel: any;
  let media: CallMedia | undefined;
  let session: VoiceAgentSession | undefined;
  let toolset: CallToolset | undefined;
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
    try { await toolset?.close(); } catch { /* ignore */ }
    // Beide Beine + Medienkanal beenden (durchgeschaltete Beendigung).
    try { await calleeChannel?.hangup(); } catch { /* ignore */ }
    try { await externalChannel?.hangup(); } catch { /* ignore */ }
    try { await channel.hangup(); } catch { /* ignore */ }
    try { await bridge?.destroy(); } catch { /* ignore */ }

    // Aufnahme in GridFS ablegen (best effort), danach die temporäre WAV löschen.
    if (recording) {
      try {
        const gridFsId = await deps.uploadRecording(recording.filePath, `${requestId}.wav`, { requestId });
        const durationSec = await wavDurationSec(recording.filePath).catch(() => 0);
        await deps.repo.setRecording(requestId, { gridFsId, filename: `${requestId}.wav`, durationSec });
        await rm(recording.filePath, { force: true });
      } catch (err) {
        log.warn("GridFS-Upload fehlgeschlagen", { err: String(err) });
      }
    }

    await deps.repo.finalizeRequest(requestId, status);

    // Post-Call-Summary (asynchron, blockiert nicht).
    if (status === "completed" && agent.summary.enabled) {
      void deps.runPostCallSummary(requestId, agent, log);
    }
  };

  try {
    await channel.answer();

    bridge = await client.bridges.create({ type: "mixing" });
    await bridge.addChannel({ channel: channel.id });

    // externalMedia-Kanal: Asterisk streamt Audio (AudioSocket/TCP oder RTP) an uns.
    const uuid = randomUUID();
    media = deps.createMedia(channel.id, uuid);
    await media.start();

    externalChannel = await createExternalMedia(client, uuid);
    await bridge.addChannel({ channel: externalChannel.id });

    // Toolset für diesen Anruf: eingebaute Tools (agent.tools) + Custom-HTTP-Tools des Agenten.
    toolset = await deps.buildCallToolset(agent);
    const callToolset = toolset; // non-optionale Bindung für die Event-Handler unten

    // Voice-Session aufbauen (Provider laut agent.voiceProvider; Settings baut der Adapter).
    // Konstruktion ist inert — verbunden wird erst per session.start() nach der Verdrahtung.
    session = deps.createSession(agent, { callId: channel.id, functions: callToolset.definitions });

    const toolCtx: ToolContext = {
      callId: requestId,
      ...(meta.callerNumber ? { callerNumber: meta.callerNumber } : {}),
      ...(agent.id ? { agentId: agent.id } : {}),
      ...(meta.targetNumber ? { targetNumber: meta.targetNumber } : {}),
      requestTransfer: async (target: string) => {
        // Klingel-Phase: Agent hört nicht mehr auf den Anrufer (reagiert nicht), ABER die bereits
        // begonnene Ansage ("Einen Moment bitte…") darf noch ausgespielt werden (kein flush, Output offen).
        // Das Zieltelefon klingelt parallel.
        transferRinging = true;
        // Intern vs. extern (über den Trunk) auflösen + Absender-CLI bestimmen.
        const dial = deps.resolveOutboundTransfer(agent, target, meta.callerNumber);
        if (dial.callerId) log.info("Externer Transfer über Trunk", { target, callerId: dial.callerId });
        await deps.repo.setTransfer(requestId, { attempted: true, target });
        const result = await deps.transferIntoBridge(client, bridge, dial.target, { callerId: dial.callerId });
        await deps.repo.setTransfer(requestId, { attempted: true, target, connected: result.connected });
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
          const pending = media?.pendingMs?.() ?? 0;
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
      // Anrufer-Audio NICHT an die Session während Transfer (voll) oder Klingelphase (Agent hört nicht zu).
      if (!transferActive && !transferRinging) session?.sendAudio(pcm);
    });
    session.on("audio", (chunk) => {
      if (transferActive) return;
      lastAudioAt = Date.now();
      if (endRequested) audioSinceEnd = true; // der Abschied nach end_call fließt
      media?.sendAudio(chunk);
    });

    // ── Session-Events ───────────────────────────────────────────────────────
    session.on("welcome", (rid) => log.info("Voice-Session Welcome", { rid }));
    session.on("userStartedSpeaking", () => media?.flush()); // Barge-in
    session.on("conversationText", (ev) => {
      const speaker = ev.role === "assistant" ? "agent" : "caller";
      void deps.repo.appendTranscript(requestId, { t: elapsed(), speaker, text: ev.content });
    });
    session.on("agentStartedSpeaking", (lat) => log.debug("AgentStartedSpeaking", { ...lat }));
    session.on("functionCallRequest", async (ev) => {
      for (const fn of ev.functions) {
        if (!fn.clientSide) continue;
        log.info("FunctionCall", { name: fn.name, args: fn.argumentsJson });
        const requestedAt = new Date();
        const { ok, result } = await callToolset.dispatch(fn.name, fn.argumentsJson, toolCtx);
        // Bei end_call (setzt endRequested) KEINE FunctionCallResponse senden — sonst startet
        // der Provider eine zweite Abschiedsrunde (doppeltes "Auf Wiederhören"). Der Abschied ist
        // bereits vor dem Tool-Aufruf gesprochen worden; danach wird aufgelegt.
        if (!endRequested) session?.sendFunctionResponse(fn.id, fn.name, result);
        void deps.repo.appendFunctionCall(requestId, {
          name: fn.name,
          arguments: safeParse(fn.argumentsJson),
          result,
          status: ok ? "ok" : "error",
          requestedAt,
          completedAt: new Date(),
        });
      }
    });
    session.on("error", (desc) => log.error("Voice-Session-Fehler", { desc }));

    // Aufnahme starten (best effort).
    recording = await deps.startBridgeRecording(bridge, requestId);

    // ── Hangup-Handling ──────────────────────────────────────────────────────
    client.on("StasisEnd", onEnd);
    channel.on("ChannelDestroyed", () => void cleanup("completed"));

    // Verbindung zum Voice-Provider erst NACH kompletter Verdrahtung aufbauen — so gehen keine
    // frühen Events verloren, und ein Connect-Fehler läuft in den catch → cleanup("failed")
    // (vorher blieb der Anruf bei WS-Connect-Fehlern stumm hängen).
    await session.start();
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
