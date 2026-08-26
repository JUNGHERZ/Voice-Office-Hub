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

import { createAmbienceMixer } from "../audio/ambience.js";
import { config } from "../config.js";
import { callRepo } from "../db/callRepo.js";
import * as repo from "../db/repository.js";
import { uploadRecording } from "../db/gridfs.js";
import { CallLocalizer, type CallLocalizerLike } from "../llm/callLocalizer.js";
import { lookupLanguage, rememberLanguage } from "../llm/callerProfile.js";
import { generateGreeting } from "../llm/greetingPrompt.js";
import { runPostCallSummary } from "../llm/summarize.js";
import { ensureTranslations, loadUsable } from "../llm/translationStore.js";
import { buildCallToolset, type CallToolset, type ToolContext } from "../tools/index.js";
import type { ResolvedAgent, ResolvedAmbience } from "../types.js";
import { logger } from "../util/logger.js";
import { createVoiceAgentSession } from "../voice/factory.js";
import type { VoiceAgentSession } from "../voice/types.js";
import { consumeWidgetSession } from "../db/widgetSessions.js";
import { findAgent, defaultAgent } from "./agentResolver.js";
import { isChannelGone } from "./ariErrors.js";
import { resolveOverlay } from "./callResolver.js";
import { IdleWatcher } from "./idleWatcher.js";
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

/**
 * Toleranz, innerhalb derer frisch geflossenes Agent-Audio noch als "hörbar" gilt — überbrückt
 * die Lücken zwischen TTS-Chunks. Gilt für die Barge-in-Zählung und den Stille-Wächter.
 */
const AGENT_AUDIBLE_GRACE_MS = 1500;
/** Takt des Stille-Wächters. Feiner als nötig, aber vernachlässigbar billig. */
const IDLE_TICK_MS = 250;
/** Grobe Sprechgeschwindigkeit (Zeichen/s) — dieselbe Schätzung wie beim Timer-Filler. */
const SPEECH_CHARS_PER_SEC = 14;

/** Geschätzte Sprechdauer eines Ansage-/Antworttexts in ms. */
function estimateSpeechMs(text: string): number {
  return Math.ceil((text.length / SPEECH_CHARS_PER_SEC) * 1000);
}

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
  | "createRequest"
  | "appendTranscript"
  | "truncateLastAgentTranscript"
  | "appendFunctionCall"
  | "setTransfer"
  | "setRecording"
  | "setLanguage"
  | "setGreetingText"
  | "finalizeRequest"
>;

/**
 * Injizierbare Abhängigkeiten des Call-Pfads. Produktion nutzt `defaultDeps`;
 * Tests reichen über den optionalen 4. Parameter von `handleStasisStart` Fakes ein.
 */
export interface CallHandlerDeps {
  findAgent: typeof findAgent;
  defaultAgent: typeof defaultAgent;
  /**
   * Konfigurations-Overlay pro Anruf (0.9.0). Bewusst eine eigene Naht NEBEN findAgent:
   * so lassen sich „vom Hook abgelehnt" und „keine DDI-Zuordnung" nicht verwechseln — ein
   * abgelehnter Anruf darf auch mit UNKNOWN_NUMBER_BEHAVIOR=agent nicht doch beantwortet
   * werden. Ohne RESOLVER_URL ist der Hook inert und reicht den Agenten unverändert durch.
   */
  resolveOverlay: typeof resolveOverlay;
  /**
   * Einlösen der Widget-Sitzung (0.11.0) — entscheidet, ob ein Web-INVITE überhaupt zu
   * einem Anruf wird. Eigene Naht, weil sie VOR dem Overlay-Hook und vor jedem Schreibvorgang
   * greift: Ein Anruf ohne Sitzung soll weder Hook-Aufruf noch Gesprächsdatensatz kosten.
   */
  consumeWidgetSession: typeof consumeWidgetSession;
  handlePassthrough: typeof handlePassthrough;
  createMedia: (callId: string, uuid: string, ambience?: ResolvedAmbience) => CallMedia;
  createSession: typeof createVoiceAgentSession;
  createLocalizer: (agent: ResolvedAgent, requestId: string) => CallLocalizerLike;
  buildCallToolset: typeof buildCallToolset;
  repo: CallRepo;
  startBridgeRecording: typeof startBridgeRecording;
  uploadRecording: typeof uploadRecording;
  runPostCallSummary: typeof runPostCallSummary;
  resolveOutboundTransfer: typeof resolveOutboundTransfer;
  transferIntoBridge: typeof transferIntoBridge;
  now: () => number;
  /** Jitter-Quelle des Stille-Wächters (Tests reichen eine feste Zahl ein). */
  random: () => number;
  /** Bekannte Sprache dieser Rufnummer (Anrufer-Gedächtnis) — steuert die Begrüßung. */
  lookupLanguage: typeof lookupLanguage;
  /** Begrüßung aus `agent.greetingPrompt` erzeugen (0.10.0). Inert ohne gesetzten Prompt. */
  generateGreeting: typeof generateGreeting;
  /** Vorübersetzte Ansagen einer Sprache, nur soweit ihr Original unverändert ist. */
  loadTranslations: typeof loadUsable;
  /** Nach dem Gespräch: Sprache im Anrufer-Profil festhalten. */
  rememberLanguage: typeof rememberLanguage;
  /** Nach dem Gespräch: fehlende Übersetzungen der gesprochenen Sprache nachziehen. */
  ensureTranslations: typeof ensureTranslations;
}

export const defaultDeps: CallHandlerDeps = {
  findAgent,
  defaultAgent,
  resolveOverlay,
  consumeWidgetSession,
  handlePassthrough,
  createMedia,
  createSession: createVoiceAgentSession,
  createLocalizer: (agent, requestId) => new CallLocalizer(agent, requestId),
  buildCallToolset,
  // Gekapseltes Repo: identische API plus Ereignis-Zustellung (0.9.0). Ohne WEBHOOK_URL
  // ist es dasselbe Modul.
  repo: callRepo,
  startBridgeRecording,
  uploadRecording,
  runPostCallSummary,
  resolveOutboundTransfer,
  transferIntoBridge,
  lookupLanguage,
  generateGreeting,
  loadTranslations: loadUsable,
  rememberLanguage,
  ensureTranslations,
  now: () => Date.now(),
  random: () => Math.random(),
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
  // Drittes Stasis-Arg: Widget-Token aus dem [webrtc-inbound]-Dialplan (leer bei Telefonie).
  const widgetToken = args[2] || undefined;
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
  // Ohne konfigurierten Hook bleibt es bei diesen Vorgaben — der Anruf wird protokolliert
  // und normal geführt, exakt wie bisher.
  let overlay: OverlayDecision = { report: true, announce: false };

  if (agent) {
    // Widget-Sitzung einlösen (0.11.0), noch vor dem Overlay-Hook und vor jedem Schreiben.
    // Web-Anrufe erkennt der Dialplan-erzwungene Caller-ID-Präfix — im [webrtc-inbound]-
    // Kontext setzt er `web-<uniqueid>`, der Client hat darauf keinen Einfluss.
    if (config.widget.requireSession && callerNumber?.startsWith("web-")) {
      const admission = await deps.consumeWidgetSession(widgetToken, agent.id);
      if (!admission.ok) {
        // Bewusst `info` und nicht stumm: Ohne diese Zeile sähe ein falsch konfiguriertes
        // Widget exakt wie „Anrufer legen sofort auf" aus. Ein Gesprächsdatensatz entsteht
        // richtigerweise nicht — deshalb ist das Log die einzige Spur.
        log.info("Web-Anruf ohne gültige Sitzung abgewiesen", {
          grund: admission.reason,
          exten: targetNumber,
          agent: agent.name,
        });
        try {
          await channel.hangup({ reason: "unallocated" });
        } catch {
          try { await channel.hangup(); } catch { /* ignore */ }
        }
        return;
      }
    }

    // Overlay-Hook auf dem Klingelpfad: läuft NUR auf einem DB-Treffer und VOR dem Answer.
    const decision = await deps.resolveOverlay(agent, {
      channel: widgetToken ? "web" : "phone",
      channelId: channel.id,
      targetNumber,
      callerNumber,
      ...(widgetToken ? { widgetToken } : {}),
    });
    if (decision.kind === "reject") {
      // Ablehnung geht ausdrücklich VOR UNKNOWN_NUMBER_BEHAVIOR: kein Answer, kein
      // requests-Dokument, kein Default-Agent. Das Netz des Anrufers spielt die Standardansage.
      log.info("Anruf vom Overlay-Hook abgelehnt", { targetNumber, callerNumber });
      try {
        await channel.hangup({ reason: "unallocated" });
      } catch {
        try { await channel.hangup(); } catch { /* ignore */ }
      }
      return;
    }
    agent = decision.agent;
    overlay = decision;
  } else if (config.unknownNumber.behavior === "agent") {
    // Keine DDI-Zuordnung → konfiguriertes Verhalten (Default: ablehnen). Verhindert, dass
    // Scanner-/Fehlanrufe eine kostenpflichtige Default-Agent-Session + Logeintrag auslösen.
    log.info("Kein Agent für DDI — Default-Agent (Dev)", { targetNumber });
    agent = deps.defaultAgent();
  } else {
    await handleUnknownNumber(client, channel, { targetNumber, callerNumber, log });
    return;
  }

  if (agent.mode === "passthrough") {
    // Durchleitung kennt weder Prompt noch Ansage — vom Overlay bleiben nur die beiden
    // Kennzeichen am Request. `report:false` wäre hier ein Widerspruch (eine Durchleitung
    // ist genau der Mitschnitt) und wird deshalb nicht ausgewertet.
    await deps.handlePassthrough(client, channel, agent, {
      targetNumber,
      callerNumber,
      ...(overlay.agentRef ? { agentRef: overlay.agentRef } : {}),
      ...(overlay.resolverStatus ? { resolverStatus: overlay.resolverStatus } : {}),
    });
    return;
  }

  await runAgentCall(
    client,
    channel,
    agent,
    { targetNumber, callerNumber, widgetToken, log, ...overlay },
    deps,
  );
}

/**
 * Behandelt einen Anruf an eine NICHT zugeordnete Nummer ohne Agent/LLM:
 *   - "announce": kurz answern, Ansage abspielen, auflegen (kein Deepgram, minimal Kosten).
 *   - sonst ("reject"): VOR dem Answer mit 404 "unallocated" ablehnen → das Netz des
 *     Anrufers spielt die Standardansage ("kein Anschluss"). 0 Kosten, kein Logeintrag.
 * In beiden Fällen wird bewusst KEIN `requests`-Dokument angelegt (kein Log-Spam).
 */
/**
 * Median einer Latenzreihe in Millisekunden (Eingabe in Sekunden, wie die
 * Provider sie melden). Median statt Mittelwert: einzelne Ausreißer — Tool-Runden,
 * ein Reconnect — sollen die Provider-Bewertung nicht verzerren.
 */
function medianMs(values: Array<number | undefined>): number | undefined {
  const xs = values.filter((v): v is number => typeof v === "number" && Number.isFinite(v)).sort((a, b) => a - b);
  if (!xs.length) return undefined;
  const mid = Math.floor(xs.length / 2);
  const sec = xs.length % 2 ? (xs[mid] as number) : ((xs[mid - 1] as number) + (xs[mid] as number)) / 2;
  return Math.round(sec * 1000);
}

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
  /** Ambience pausieren/fortsetzen (nur AudioSocket-Transport vorhanden). */
  setAmbiencePaused?(paused: boolean): void;
}

/**
 * Transport-abhängige Media-Anbindung erzeugen.
 *  - audiosocket: Session am geteilten Server registrieren (UUID-Zuordnung)
 *  - rtp: per-Anruf UDP-Bridge (ohne Playout-Takt → keine Ambience-Unterstützung)
 */
let rtpAmbienceWarned = false; // Hinweis nur einmal pro Prozess
function createMedia(callId: string, uuid: string, ambience?: ResolvedAmbience): CallMedia {
  if (config.audio.transport === "rtp") {
    if (ambience?.enabled && !rtpAmbienceWarned) {
      rtpAmbienceWarned = true;
      logger.child({ mod: "call" }).warn(
        "Ambience wird nur beim AudioSocket-Transport unterstützt — übersprungen (MEDIA_TRANSPORT=rtp)",
      );
    }
    return new MediaBridge(config.audio.externalMediaPort, callId);
  }
  return audioSocketServer.register(uuid, callId, createAmbienceMixer(ambience, callId));
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

/** Obergrenze für den Profil-/Übersetzungs-Lookup vor dem Session-Aufbau. */
const PRIOR_LOOKUP_TIMEOUT_MS = 200;
/**
 * Obergrenze für die Erzeugung der Begrüßung. Großzügiger als der Profil-Lookup, weil hier
 * ein Modell antwortet (gemessen 300–800 ms) — aber hart, weil der Anrufer währenddessen
 * klingeln hört. Danach gilt der statische Text.
 */
const GREETING_TIMEOUT_MS = 4000;

/** Ergebnis der Begrüßungs-Auflösung: der Agent für die Session + der Satz, der fällt. */
interface ResolvedGreeting {
  agent: ResolvedAgent;
  text?: string;
}

/**
 * Begrüßung für diesen Anruf bestimmen. Zwei Quellen, in dieser Reihenfolge:
 *
 *  1. **Anrufer-Gedächtnis** (0.7.0): Kennen wir die Nummer, steht die Sprache schon VOR dem
 *     ersten Wort fest — die Laufzeit-Erkennung käme fürs Greeting immer zu spät. Die
 *     vorübersetzten Ansagen wärmen zugleich den Localizer vor.
 *  2. **Begrüßungs-Prompt** (0.10.0): Ist `greetingPrompt` gesetzt, wird der Satz in der
 *     Sprache aus (1) ERZEUGT statt nachgeschlagen. Nur die Begrüßung — `transferFailed`,
 *     Filler- und Stille-Ansagen kommen weiterhin aus dem Übersetzungs-Cache.
 *
 * Beide Wege sind Komfortgewinne, keiner darf den Anruf kosten: Jeder Fehlschlag endet beim
 * gespeicherten Text. Beide Provider bauen ihre Begrüßung aus dem übergebenen Agenten
 * (nativeSession.start() bzw. deepgram/settings.ts), ein getauschtes `greeting` wirkt
 * deshalb ohne Provider-Code.
 *
 * `signal` bricht die Erzeugung ab, wenn der Anrufer noch im Rufton auflegt.
 */
async function resolveGreeting(
  agent: ResolvedAgent,
  meta: CallMeta,
  localizer: CallLocalizerLike,
  metrics: repo.CallMetrics,
  log: ReturnType<typeof logger.child>,
  deps: CallHandlerDeps,
  signal: AbortSignal,
): Promise<ResolvedGreeting> {
  let sessionAgent = agent;
  // Sprache, in der gesprochen wird: bis auf Weiteres die Katalogsprache des Agenten.
  let lang = agent.contentLanguage;
  const generated = !!agent.greetingPrompt;

  try {
    const prior = await withTimeout(
      deps.lookupLanguage(agent, meta.callerNumber),
      PRIOR_LOOKUP_TIMEOUT_MS,
    );
    if (prior && prior.lang !== agent.contentLanguage) {
      const phrases =
        (await withTimeout(deps.loadTranslations(agent, prior.lang), PRIOR_LOOKUP_TIMEOUT_MS)) ?? {};
      // Ohne gültige Übersetzung der Begrüßung bleibt es bei der Standardsprache: lieber
      // deutsch als eine veraltete englische Fassung (translationStore.ts prüft den
      // Quelltext-Hash). Wird die Begrüßung ohnehin erzeugt, trägt der Prior trotzdem die
      // Sprache — und die übrigen Ansagen sind trotzdem vorzuladen.
      if (phrases.greeting || (generated && Object.keys(phrases).length)) {
        localizer.preload(prior.lang, phrases);
      }
      if (phrases.greeting || generated) {
        lang = prior.lang;
        metrics.greetingLanguage = prior.lang;
        metrics.priorSource = prior.source;
        if (phrases.greeting) sessionAgent = { ...agent, greeting: phrases.greeting };
        log.info("Begrüßung aus Anrufer-Profil", {
          lang: prior.lang,
          ansagen: Object.keys(phrases).length,
        });
      }
    }
  } catch (err) {
    log.warn("Sprach-Prior übersprungen", { err: String(err) });
  }

  if (generated) {
    try {
      const text = await deps.generateGreeting(agent.greetingPrompt as string, lang, {
        // Zwei Abbruchgründe in einem Signal: der Anrufer legt auf, oder es dauert zu lange.
        signal: AbortSignal.any([signal, AbortSignal.timeout(GREETING_TIMEOUT_MS)]),
      });
      if (text) {
        sessionAgent = { ...sessionAgent, greeting: text };
        log.info("Begrüßung erzeugt", { lang, zeichen: text.length });
      } else {
        log.warn("Begrüßung leer — statischer Text gilt", { lang });
      }
    } catch (err) {
      // Zwei sehr verschiedene Gründe, dieselbe Ausnahme: Hat der Anrufer aufgelegt, ist
      // nichts schiefgegangen — der Abbruch ist genau das Gewollte und keine Warnung wert.
      // Nur Zeitüberschreitung und Modellfehler sind eine.
      if (signal.aborted) log.info("Begrüßung abgebrochen — Anrufer hat aufgelegt");
      // Genau dafür bleibt `greeting` Pflichtfeld: Es ist nicht mehr der Normalfall,
      // aber das Netz darunter.
      else log.warn("Begrüßung nicht erzeugt — statischer Text gilt", { err: String(err) });
    }
  }

  return { agent: sessionAgent, text: sessionAgent.greeting };
}

/** Rennen gegen die Uhr; bei Zeitüberschreitung `undefined` statt eines hängenden Anrufaufbaus. */
function withTimeout<T>(p: Promise<T>, ms: number): Promise<T | undefined> {
  return Promise.race([
    p,
    new Promise<undefined>((resolve) => {
      const t = setTimeout(() => resolve(undefined), ms);
      t.unref?.();
    }),
  ]);
}

/** Was der Overlay-Hook (0.9.0) über den gespeicherten Agenten hinaus entschieden hat. */
interface OverlayDecision {
  /** Opake Kennung des Aufrufers; landet am Request und in allen Ereignissen. */
  agentRef?: string;
  /** Fehlt, wenn kein Hook konfiguriert ist. */
  resolverStatus?: "ok" | "unavailable";
  /** false = dieser Anruf hinterlässt keine Spur (kein Dokument, keine Aufnahme, keine Ereignisse). */
  report: boolean;
  /** true = nur die Begrüßung ausspielen, danach auflegen. */
  announce: boolean;
}

interface CallMeta extends Partial<OverlayDecision> {
  targetNumber?: string;
  callerNumber?: string;
  /** Vom Web-Widget pro Anruf generiertes Token (SIP-Header → Dialplan → Stasis-Arg 3). */
  widgetToken?: string;
  log: ReturnType<typeof logger.child>;
}

/**
 * Repo-Attrappe für Anrufe, die laut Overlay-Hook nicht protokolliert werden (report:false).
 * Statt den ganzen Anrufpfad mit Bedingungen zu durchziehen, bekommt er ein Repo, das nichts
 * schreibt. Die Korrelations-ID ist absichtlich KEINE ObjectId-Form — sie taucht in Logs und
 * im Tool-Envelope auf und soll dort nicht für eine Request-ID gehalten werden.
 */
function nullRepo(channelId: string): CallRepo {
  return {
    createRequest: async () => `unreported:${channelId}`,
    appendTranscript: async () => {},
    truncateLastAgentTranscript: async () => {},
    appendFunctionCall: async () => {},
    setTransfer: async () => {},
    setRecording: async () => {},
    setLanguage: async () => {},
    setGreetingText: async () => {},
    finalizeRequest: async () => {},
  };
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
  // Zeitpunkt des Answers. Getrennt von `startTime`, seit die Begrüßung VOR dem Answer
  // entsteht (0.10.0): `timeToFirstAudioMs` soll die Stille messen, die der Anrufer NACH
  // dem Abheben erlebt — die Wartezeit davor hört er als Rufton, nicht als Loch.
  let answeredAt = 0;

  // report:false → nichts schreiben, nichts aufnehmen, nichts nacharbeiten.
  const reported = meta.report !== false;
  const store: CallRepo = reported ? deps.repo : nullRepo(channel.id);

  const requestId = await store.createRequest({
    channelId: channel.id,
    mode: "agent",
    callerNumber: meta.callerNumber,
    targetNumber: meta.targetNumber,
    ...(meta.widgetToken ? { widgetToken: meta.widgetToken } : {}),
    ...(agent.id ? { agentId: agent.id as unknown as never } : {}),
    ...(agent.externalRef ? { externalRef: agent.externalRef } : {}),
    ...(meta.agentRef ? { agentRef: meta.agentRef } : {}),
    ...(meta.resolverStatus ? { resolverStatus: meta.resolverStatus } : {}),
  });

  // Laufzeit-Lokalisierung der Filler-/System-Ansagen (aktiv nur bei mehrsprachigem Agent;
  // sonst inert → Default-Sprache). Eigentümer des Anrufs, beide Provider.
  const localizer = deps.createLocalizer(agent, requestId);

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
  // Warum der Anruf endet. Gesetzt wird er dort, wo die Engine selbst auflegt; bleibt er
  // leer, hat der Anrufer aufgelegt (oder ein durchgestelltes Gespräch endete, s. u.).
  let hangupReason: string | undefined;
  let maxDurationTimer: NodeJS.Timeout | undefined;
  // Bricht die Begrüßungs-Erzeugung ab, sobald der Kanal weg ist (auch schon im Rufton).
  const greetingAbort = new AbortController();
  const abortGreeting = () => greetingAbort.abort();
  // Der Anrufer ist während des Aufbaus verschwunden. Das Flag ist nötig, weil in diesem
  // Fenster noch KEIN cleanup-Handler hängt (onEnd wird erst nach der Verdrahtung
  // registriert) — ohne es liefe der Aufbau weiter und liefe in einen ARI-Fehler.
  let channelGone = false;
  const onEarlyEnd = (_ev: unknown, ch: AriChannel) => {
    if (ch?.id !== channel.id) return;
    channelGone = true;
    abortGreeting();
  };
  const onEarlyDestroyed = () => {
    channelGone = true;
    abortGreeting();
  };
  // Transkript-Schreibvorgänge laufen offen (fire-and-forget); die Sprechuhr-Korrektur
  // muss sich hinter den Eintrag ketten, den sie korrigiert.
  let transcriptWrites: Promise<unknown> = Promise.resolve();
  let lastAudioAt = 0; // Zeitpunkt des zuletzt empfangenen Agent-Audios (für Drain-Erkennung)
  // Geschätztes Ende der Agent-Sprache aus der Textlänge. Nötig, weil nur der AudioSocket einen
  // Playout-Puffer (pendingMs) führt — die RTP-Bridge feuert alles sofort raus (media.ts:sendAudio),
  // dort wird lastAudioAt stale, während der Anrufer noch hört. Verzögert nur, verfrüht nie.
  let agentSpeechUntil = 0;
  // An den Sprach-Provider gestreamte Anrufer-Bytes → Abrechnungsgrundlage der STT-Seite.
  // Hier und nicht im Adapter: Es ist die eine Stelle, an der Audio in die Session geht,
  // und die Transfer-Stummschaltung wird dadurch automatisch mitgezählt (bzw. eben nicht).
  let callerAudioBytes = 0;
  let toolsInFlight = 0; // läuft gerade ein Tool-Dispatch? (Stille-Ansage muss dann schweigen)
  // Per-Call-Metriken — lokal gesammelt, EIN Write beim Finalisieren (cleanup).
  const metrics: repo.CallMetrics = {
    bargeIns: 0,
    toolCalls: 0,
    toolErrors: 0,
    voiceProvider: agent.voiceProvider,
    sttModel: agent.listen.model,
  };
  /**
   * Turn-Latenzen aller Agenten-Turns (Sekunden, wie vom Provider gemeldet).
   * Der Median wandert beim Finalisieren in die Metriken — ein Mittelwert würde
   * von einzelnen Ausreißern (Tool-Runden, Reconnects) verzerrt.
   */
  const turnLatencies: Array<{ total?: number; ttt?: number; tts?: number }> = [];
  let audioSinceEnd = false; // kam nach end_call noch Audio (der Abschied)?
  let drainInterval: NodeJS.Timeout | undefined;
  let hangupTimer: NodeJS.Timeout | undefined;
  let idleInterval: NodeJS.Timeout | undefined;
  let cleaned = false;

  const onEnd = (_ev: unknown, ch: AriChannel) => {
    if (ch.id === channel.id) void cleanup("completed");
  };
  const onChannelDestroyed = () => void cleanup("completed");

  // Durchgeschaltete Beendigung: legt der durchverbundene Mitarbeiter (Ziel) auf, endet der Anruf.
  const onCalleeGone = (_ev: unknown, ch: AriChannel) => {
    if (calleeChannel && ch?.id === calleeChannel.id) void cleanup("completed");
  };

  const cleanup = async (status: repo.CallEndStatus) => {
    if (cleaned) return;
    cleaned = true;
    log.info("Teardown", { status });
    if (hangupTimer) clearTimeout(hangupTimer);
    if (maxDurationTimer) clearTimeout(maxDurationTimer);
    if (drainInterval) clearInterval(drainInterval);
    if (idleInterval) clearInterval(idleInterval);
    client.removeListener("StasisEnd", onEnd);
    client.removeListener("ChannelDestroyed", onCalleeGone);
    try {
      if (recording) await recording.stop();
    } catch { /* ignore */ }
    // TTS-Verbrauch VOR dem Schließen abgreifen (Pro-Anruf-Kostenrechnung, nur native).
    const usage = session?.getUsage?.();
    if (usage?.ttsCharacters) {
      metrics.ttsProvider = usage.ttsProvider;
      metrics.ttsModel = usage.ttsModel;
      metrics.ttsCharacters = usage.ttsCharacters;
      if (usage.ttsCredits !== undefined) metrics.ttsCredits = usage.ttsCredits;
    }
    // LLM-Mengen kennt nur die native Kaskade — beim gebündelten Provider denkt der
    // Anbieter selbst und meldet keine Token.
    if (usage?.llmRequests) {
      metrics.llmModel = usage.llmModel;
      metrics.llmPromptTokens = usage.llmPromptTokens;
      metrics.llmCachedPromptTokens = usage.llmCachedPromptTokens;
      metrics.llmCompletionTokens = usage.llmCompletionTokens;
      metrics.llmRequests = usage.llmRequests;
    }
    // 16 Bit mono → 2 Bytes je Sample. Provider-neutral, deshalb immer gesetzt.
    if (callerAudioBytes > 0) {
      metrics.sttSeconds = Math.round(callerAudioBytes / (config.audio.sampleRate * 2));
    }
    if (turnLatencies.length) {
      metrics.turns = turnLatencies.length;
      metrics.turnLatencyMs = medianMs(turnLatencies.map((l) => l.total));
      metrics.turnThinkMs = medianMs(turnLatencies.map((l) => l.ttt));
      metrics.turnTtsMs = medianMs(turnLatencies.map((l) => l.tts));
    }
    abortGreeting(); // wirkungslos, wenn die Begrüßung längst steht
    client.removeListener("StasisEnd", onEarlyEnd);
    // Instanz-Listener MÜSSEN einzeln abgemeldet werden: ari-client hält sie in einer
    // Liste pro Ereignistyp, die es bei jedem ChannelDestroyed komplett durchläuft und
    // von sich aus nie kürzt — ohne das hier wüchse sie mit jedem Anruf weiter.
    channel.removeListener("ChannelDestroyed", onEarlyDestroyed);
    channel.removeListener("ChannelDestroyed", onChannelDestroyed);
    session?.close();
    localizer.close(); // laufende Sprach-Erkennung abbrechen, späte Ergebnisse verwerfen
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
        await store.setRecording(requestId, { gridFsId, filename: `${requestId}.wav`, durationSec });
        await rm(recording.filePath, { force: true });
      } catch (err) {
        log.warn("GridFS-Upload fehlgeschlagen", { err: String(err) });
      }
    }

    // Was der Anrufer tatsächlich gesprochen hat — erst nach dem Gespräch steht es fest.
    const lang = localizer.getLanguageState();
    if (lang.lang && lang.confirmed) {
      metrics.priorConfirmed = lang.priorLang ? lang.priorLang === lang.lang : undefined;
    }

    // Reihenfolge der Gründe: ein ausdrückliches Auflegen der Engine gewinnt; sonst
    // entscheidet, ob ein Mensch übernommen hatte. Eine Weiterleitung läuft NICHT über
    // requestHangup (beide Beine legen einfach auf) und sähe sonst aus wie ein Anrufer,
    // der auflegt — für die Auswertung der wichtigste Unterschied überhaupt.
    const endedReason =
      status === "abandoned"
        ? "abandoned"
        : hangupReason ?? (transferActive ? "transfer" : status === "failed" ? "failed" : "caller");
    await store.finalizeRequest(requestId, status, metrics, endedReason);

    // Post-Call-Arbeiten, alle asynchron — der Anruf ist zu diesem Zeitpunkt beendet.
    if (reported && status === "completed" && agent.summary.enabled) {
      void deps.runPostCallSummary(requestId, agent, log);
    }
    // Nur LLM-bestätigte Sprachen: Eine Scorer-Vermutung darf keine Begrüßung steuern.
    if (reported && status === "completed" && lang.lang && lang.confirmed) {
      void deps.rememberLanguage(agent, meta.callerNumber, lang.lang, lang.priorLang);
      // Fehlt die Vorübersetzung dieser Sprache noch, entsteht sie jetzt — ab dem nächsten
      // Anruf derselben Nummer sitzt damit auch die Begrüßung.
      void deps.ensureTranslations(agent, lang.lang);
    }
  };

  try {
    // Begrüßung VOR dem Answer bestimmen. Der Dialplan ruft Stasis() bewusst ohne
    // vorheriges Answer() auf — dieses Fenster ist RUFTON. Dieselbe Wartezeit hinter dem
    // Answer wäre Stille nach dem Abheben, und die ist ungleich unangenehmer als ein
    // Klingelton, der einen Moment länger läuft. Gemessen (native, Requesty): ~1,2 s.
    // Legt der Anrufer währenddessen auf, bricht `greetingAbort` den Modellaufruf ab —
    // sonst zahlte jeder Klingelabbrecher ein Modell für ein Gespräch, das nie stattfand.
    client.on("StasisEnd", onEarlyEnd);
    channel.on("ChannelDestroyed", onEarlyDestroyed);

    // 180 Ringing, damit aus dem Fenster echter RUFTON wird. Der Dialplan schickt vor
    // Stasis() bewusst keine Antwort (unbekannte DDIs sollen mit 404 abgelehnt werden
    // können) — bis 0.9.x folgte 1 ms später das 200 OK, seit 0.10.0 sind es 1,2–1,6 s.
    // Ohne dieses Ringing hört der Anrufer in der ganzen Zeit NICHTS: kein Klingeln, kein
    // Freizeichen, nur eine tote Leitung, die zum Auflegen einlädt. Best effort — ein
    // Kanal, der schon weg ist, wird zwei Zeilen weiter unten ohnehin abgefangen.
    try {
      await channel.ring();
    } catch (err) {
      log.debug("Rufton nicht gesetzt", { err: String(err) });
    }

    const greeting = await resolveGreeting(
      agent,
      meta,
      localizer,
      metrics,
      log,
      deps,
      greetingAbort.signal,
    );

    // Der Anrufer hat während der Begrüßung aufgelegt: hier aussteigen, statt abzuheben
    // und Bridge, Medienkanal und Voice-Session für ein Gespräch zu bauen, das es nicht
    // mehr gibt (jeder dieser ARI-Aufrufe scheiterte gleich darauf).
    if (channelGone) {
      log.info("Anrufer hat vor der Annahme aufgelegt", { nachMs: Date.now() - startTime });
      await cleanup("abandoned");
      return;
    }

    await channel.answer();
    answeredAt = Date.now();

    bridge = await client.bridges.create({ type: "mixing" });
    await bridge.addChannel({ channel: channel.id });

    // externalMedia-Kanal: Asterisk streamt Audio (AudioSocket/TCP oder RTP) an uns.
    const uuid = randomUUID();
    media = deps.createMedia(channel.id, uuid, agent.ambience);
    await media.start();

    externalChannel = await createExternalMedia(client, uuid);
    await bridge.addChannel({ channel: externalChannel.id });

    // Toolset für diesen Anruf: eingebaute Tools (agent.tools) + Custom-HTTP-Tools des Agenten.
    toolset = await deps.buildCallToolset(agent);
    const callToolset = toolset; // non-optionale Bindung für die Event-Handler unten

    // Steht bereits (vor dem Answer bestimmt, siehe oben).
    const sessionAgent = greeting.agent;
    // Was tatsächlich gesprochen wird, gehört ans Gespräch — nicht nur an den Agenten:
    // Beide werden zu verschiedenen Zeitpunkten gelesen, und ein später geändertes
    // `greeting` würde sonst rückwirkend einen Satz belegen, der nie fiel.
    if (greeting.text) void store.setGreetingText(requestId, greeting.text);

    // Voice-Session aufbauen (Provider laut agent.voiceProvider; Settings baut der Adapter).
    // Konstruktion ist inert — verbunden wird erst per session.start() nach der Verdrahtung.
    session = deps.createSession(sessionAgent, {
      callId: channel.id,
      functions: callToolset.definitions,
      localizer,
      // media steht hier bereits — die Sonde meldet, wie viel Agent-Audio noch
      // in der Playout-Queue liegt und damit NICHT gehört wurde.
      pendingPlayoutMs: () => media?.pendingMs?.() ?? 0,
      // Reine Ansage: nur sprechen, nicht zuhören.
      ...(meta.announce ? { listen: false } : {}),
    });

    /**
     * Abschied ausspielen lassen, dann auflegen. Nutzt end_call (Tool) genauso wie der
     * Stille-Wächter — beide brauchen exakt dieselbe Drain-Logik, damit der letzte Satz
     * nicht abgeschnitten wird. `endRequested` sperrt danach jede weitere Stille-Ansage.
     */
    const requestHangup = async (reason: string) => {
      if (endRequested) return;
      endRequested = true;
      // "end_call" ist der Tool-Name; nach außen heißt der Grund "agent" — es ist der
      // Assistent, der auflegt, unabhängig davon, wie das Tool intern heißt.
      hangupReason = reason === "end_call" ? "agent" : reason;
      const startedAt = Date.now();
      log.info("Auflegen angefordert — warte auf Ende des Abschieds", { reason });
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
    };

    // Harte Obergrenze: nach Ablauf regulär auflegen — über dieselbe Drain-Logik, damit
    // der laufende Satz nicht mitten im Wort abbricht.
    if (agent.maxDurationSec && agent.maxDurationSec > 0) {
      maxDurationTimer = setTimeout(() => {
        log.info("Gesprächsdauer erreicht — Auflegen", { maxDurationSec: agent.maxDurationSec });
        void requestHangup("maxDuration");
      }, agent.maxDurationSec * 1000);
    }

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
        await store.setTransfer(requestId, { attempted: true, target });
        const result = await deps.transferIntoBridge(client, bridge, dial.target, { callerId: dial.callerId });
        await store.setTransfer(requestId, { attempted: true, target, connected: result.connected });
        transferRinging = false;
        if (result.connected) {
          // Mensch hat übernommen → Agent voll stumm, hört NICHT mit. Anruf läuft Anrufer ↔ Mitarbeiter.
          transferActive = true;
          // Restansage sofort verwerfen: Das Audio-Gate blockt nur NEUE Frames — was beim
          // Connect noch im Playout-Puffer liegt ("…ich verbinde dich…"), würde sonst dem
          // frisch zugeschalteten Mitarbeiter in der Bridge vorgespielt (Sofortannahme!).
          media?.flush();
          media?.setAmbiencePaused?.(true); // Ambience gehört nicht ins durchgestellte Gespräch
          calleeChannel = result.channel;
          // Legt der Mitarbeiter auf, endet der ganze Anruf (Caller-Hangup deckt cleanup ohnehin ab).
          client.on("ChannelDestroyed", onCalleeGone);
        } else {
          // Niemand erreichbar → Agent ist wieder voll aktiv und setzt den Kontext fort.
          // Ansage in der Anrufersprache (Fallback: Config-Default in der Standardsprache).
          session?.injectMessage(localizer.resolve("transferFailed"));
        }
        return result;
      },
      requestHangup: () => requestHangup("end_call"),
    };

    const hangup = async () => {
      if (hangupTimer) { clearTimeout(hangupTimer); hangupTimer = undefined; }
      if (drainInterval) { clearInterval(drainInterval); drainInterval = undefined; }
      try { await channel.hangup(); } catch { /* ignore */ }
    };

    // ── Stille-Wächter (0.6.27) ─────────────────────────────────────────────
    // Der Detektor liegt hier und nicht in der Session: Nur der callHandler kennt das echte
    // Playout-Ende (pendingMs) und alle Sperrzustände — und über injectMessage funktioniert
    // er so für BEIDE Provider. Der Watcher selbst ist eine reine Zustandsmaschine.
    const idleWatcher = new IdleWatcher(
      agent.idlePrompts,
      {
        isAgentAudible: (now) =>
          (media?.pendingMs?.() ?? 0) > 0 ||
          now - lastAudioAt < AGENT_AUDIBLE_GRACE_MS ||
          now < agentSpeechUntil,
        isBlocked: () =>
          transferActive || transferRinging || endRequested || cleaned || toolsInFlight > 0 || !session,
        phrase: (stage) => localizer.resolve("idle", stage),
        speak: (text, stage) => {
          // stage 0-basiert → 1-basiert loggen, damit "1/2" ohne Umrechnen lesbar ist.
          log.info("Stille-Ansage", {
            stage: `${stage + 1}/${agent.idlePrompts.maxPrompts}`,
            text,
          });
          metrics.idlePrompts = (metrics.idlePrompts ?? 0) + 1;
          session?.injectMessage(text);
        },
        hangup: () => {
          metrics.idleHangup = true;
          const farewell = localizer.resolve("idleHangup");
          if (farewell) session?.injectMessage(farewell);
          void requestHangup("idle");
        },
      },
      deps.random,
    );
    if (agent.idlePrompts.enabled) {
      idleInterval = setInterval(() => {
        if (!cleaned) idleWatcher.tick(Date.now());
      }, IDLE_TICK_MS);
      idleInterval.unref?.();
    }

    // ── Audio-Bridging ──────────────────────────────────────────────────────
    media.on("audio", (pcm) => {
      // Anrufer-Audio NICHT an die Session während Transfer (voll) oder Klingelphase (Agent hört nicht zu).
      if (!transferActive && !transferRinging) {
        callerAudioBytes += pcm.length;
        session?.sendAudio(pcm);
      }
    });
    session.on("audio", (chunk) => {
      if (transferActive) return;
      if (metrics.timeToFirstAudioMs === undefined) {
        metrics.timeToFirstAudioMs = Date.now() - (answeredAt || startTime);
      }
      lastAudioAt = Date.now();
      if (endRequested) audioSinceEnd = true; // der Abschied nach end_call fließt
      media?.sendAudio(chunk);
    });

    // ── Session-Events ───────────────────────────────────────────────────────
    session.on("welcome", (rid) => log.info("Voice-Session Welcome", { rid }));
    session.on("userStartedSpeaking", () => {
      // Barge-in nur zählen, wenn der Agent gerade hörbar war (Puffer spielt noch oder
      // Audio kam eben) — sonst ist es schlicht der nächste reguläre Nutzer-Turn.
      const agentAudible =
        (media?.pendingMs?.() ?? 0) > 0 || Date.now() - lastAudioAt < AGENT_AUDIBLE_GRACE_MS;
      if (lastAudioAt > 0 && agentAudible) metrics.bargeIns += 1;
      media?.flush();
      idleWatcher.noteCallerActivity(Date.now());
    });
    session.on("conversationText", (ev) => {
      const speaker = ev.role === "assistant" ? "agent" : "caller";
      if (ev.replacesPrevious) {
        // Sprechuhr-Korrektur: Der Turn stand schon vollständig im Protokoll, gehört
        // wurde weniger. Hinter das offene Anhängen ketten — sonst überholt die
        // Korrektur den Schreibvorgang, den sie korrigieren soll.
        transcriptWrites = transcriptWrites
          .catch(() => {})
          .then(() => store.truncateLastAgentTranscript(requestId, ev.content));
        return;
      }
      transcriptWrites = transcriptWrites
        .catch(() => {})
        .then(() => store.appendTranscript(requestId, { t: elapsed(), speaker, text: ev.content }));
      // Sprach-/Register-Erkennung füttern (beide Rollen; Caller treibt Trigger, Agent = Register-Kontext).
      localizer.observeTurn(speaker, ev.content, ev.sttLanguage);
      if (speaker === "caller") {
        idleWatcher.noteCallerActivity(Date.now());
      } else {
        // Sprechdauer-Boden fortschreiben (deckt auch das Greeting ab, das als Assistant-Turn kommt).
        agentSpeechUntil = Math.max(agentSpeechUntil, Date.now() + estimateSpeechMs(ev.content));
      }
    });
    session.on("agentStartedSpeaking", (lat) => {
      log.debug("AgentStartedSpeaking", { ...lat });
      if (lat.total !== undefined) turnLatencies.push(lat);
    });
    session.on("functionCallRequest", async (ev) => {
      for (const fn of ev.functions) {
        if (!fn.clientSide) continue;
        log.info("FunctionCall", { name: fn.name, args: fn.argumentsJson });
        const requestedAt = new Date();
        // Während der Tool-Ausführung schweigt der Stille-Wächter — die Wartezeit gehört dem
        // Filler, nicht einem "Sind Sie noch da?" mitten in die CRM-Abfrage.
        toolsInFlight += 1;
        let ok: boolean;
        let result: unknown;
        try {
          ({ ok, result } = await callToolset.dispatch(fn.name, fn.argumentsJson, toolCtx));
        } finally {
          toolsInFlight -= 1;
        }
        metrics.toolCalls += 1;
        if (!ok) metrics.toolErrors += 1;
        // Die Dauer ist die Größe, an der fillers.delayMs ausgerichtet wird — ohne sie steht im
        // Log nur der Start und man rät, wie lange der Anrufer tatsächlich gewartet hat.
        log.info("FunctionCall fertig", {
          name: fn.name,
          ok,
          ms: Date.now() - requestedAt.getTime(),
        });
        // Bei end_call (setzt endRequested) KEINE FunctionCallResponse senden — sonst startet
        // der Provider eine zweite Abschiedsrunde (doppeltes "Auf Wiederhören"). Der Abschied ist
        // bereits vor dem Tool-Aufruf gesprochen worden; danach wird aufgelegt.
        if (!endRequested) session?.sendFunctionResponse(fn.id, fn.name, result);
        void store.appendFunctionCall(requestId, {
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

    // Aufnahme starten (best effort) — nicht bei report:false und nicht, wenn der Agent
    // dem Mitschnitt widerspricht. Ohne Aufnahme entfallen GridFS-Upload, `recording`-Block
    // am Request und das `recording.ready`-Ereignis von selbst.
    recording =
      reported && agent.recording.enabled
        ? await deps.startBridgeRecording(bridge, requestId)
        : null;

    // ── Hangup-Handling ──────────────────────────────────────────────────────
    client.on("StasisEnd", onEnd);
    channel.on("ChannelDestroyed", onChannelDestroyed);

    // Verbindung zum Voice-Provider erst NACH kompletter Verdrahtung aufbauen — so gehen keine
    // frühen Events verloren, und ein Connect-Fehler läuft in den catch → cleanup("failed")
    // (vorher blieb der Anruf bei WS-Connect-Fehlern stumm hängen).
    await session.start();

    // Reine Ansage (Overlay-Hook, verdict "announce"): Der Agent spricht seine Begrüßung und
    // legt danach auf. Bewusst kein eigener Ausspielweg — requestHangup wartet über dieselbe
    // Drain-Logik wie end_call, bis der Playout-Puffer leer ist. Ein zweiter Weg müsste genau
    // das neu lösen, und die abgeschnittene Schlusssilbe ist dort der klassische Fehler.
    if (meta.announce) void requestHangup("announce");
  } catch (err) {
    // Ein Kanal, der nicht mehr in Stasis ist, heißt: Der Anrufer ist weg. Das ist ein
    // regulärer Ausgang und keine Störung — sonst meldete jeder Klingelabbrecher dem
    // Betreiber einen Systemfehler und dem Empfänger ein gescheitertes Gespräch.
    if (channelGone || isChannelGone(err)) {
      log.info("Anrufer hat vor der Annahme aufgelegt", { nachMs: Date.now() - startTime });
      await cleanup("abandoned");
      return;
    }
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
