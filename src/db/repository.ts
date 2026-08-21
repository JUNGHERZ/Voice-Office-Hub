/**
 * Dünne Helfer rund um die `requests`-Collection: Anlegen, inkrementelles Anhängen
 * von Transkript-Turns und Tool-Aufrufen, Finalisieren. Hält die DB-Details aus dem
 * callHandler/agentSession heraus.
 */
import type { Types } from "mongoose";

import { RequestModel } from "./models/Request.js";

export interface NewRequestInput {
  channelId: string;
  mode: "agent" | "passthrough";
  callerNumber?: string;
  targetNumber?: string;
  /** Web-Widget: Token für das öffentliche Live-Transkript des Anrufs. */
  widgetToken?: string;
  agentId?: Types.ObjectId;
  /** Opake Kennung aus dem Overlay-Hook (0.9.0); wird in allen Ereignissen gespiegelt. */
  agentRef?: string;
  /** Kennung des anlegenden Systems, vom Agenten übernommen (0.10.0). */
  externalRef?: string;
  /** Ob das Overlay griff. Nur gesetzt, wenn ein Hook konfiguriert ist. */
  resolverStatus?: "ok" | "unavailable";
}

export interface TranscriptTurn {
  t: number;
  end?: number;
  speaker: string;
  text: string;
}

export interface FunctionCallRecord {
  name: string;
  arguments?: unknown;
  result?: unknown;
  status: "ok" | "error";
  requestedAt: Date;
  completedAt: Date;
}

export async function createRequest(input: NewRequestInput): Promise<string> {
  const doc = await RequestModel.create({
    channelId: input.channelId,
    mode: input.mode,
    callerNumber: input.callerNumber,
    targetNumber: input.targetNumber,
    widgetToken: input.widgetToken,
    agentId: input.agentId,
    agentRef: input.agentRef,
    externalRef: input.externalRef,
    resolverStatus: input.resolverStatus,
    startedAt: new Date(),
    status: "in_progress",
  });
  return doc.id;
}

export async function appendTranscript(id: string, turn: TranscriptTurn): Promise<void> {
  await RequestModel.updateOne({ _id: id }, { $push: { transcript: turn } });
}

export async function appendFunctionCall(id: string, call: FunctionCallRecord): Promise<void> {
  await RequestModel.updateOne({ _id: id }, { $push: { functionCalls: call } });
}

/** Der gesprochene Eröffnungssatz — siehe `greetingText` im Request-Schema. */
export async function setGreetingText(id: string, greetingText: string): Promise<void> {
  await RequestModel.updateOne({ _id: id }, { $set: { greetingText } });
}

export async function setLanguage(id: string, language: string): Promise<void> {
  await RequestModel.updateOne({ _id: id }, { $set: { language } });
}

export async function setTranscriptionStatus(
  id: string,
  status: "live" | "pending" | "done" | "failed",
): Promise<void> {
  await RequestModel.updateOne({ _id: id }, { $set: { transcriptionStatus: status } });
}

export async function setRecording(
  id: string,
  recording: { gridFsId: Types.ObjectId; filename: string; durationSec?: number; channels?: "mixed" | "separate" },
): Promise<void> {
  await RequestModel.updateOne({ _id: id }, { $set: { recording } });
}

export async function setTransfer(
  id: string,
  transfer: { attempted: boolean; target?: string; connected?: boolean },
): Promise<void> {
  await RequestModel.updateOne({ _id: id }, { $set: { transfer } });
}

export async function setSummary(
  id: string,
  summary: { text?: string; model?: string; status: "pending" | "done" | "failed"; createdAt?: Date },
): Promise<void> {
  await RequestModel.updateOne({ _id: id }, { $set: { summary } });
}

/** Per-Call-Metriken; der callHandler sammelt sie lokal und übergibt sie beim Finalisieren. */
export interface CallMetrics {
  /**
   * Answer → erstes TTS-Audio (Begrüßung), in Millisekunden — also die Stille, die der
   * Anrufer NACH dem Abheben erlebt. Eine vor dem Answer erzeugte Begrüßung (0.10.0) fällt
   * bewusst nicht hinein: Sie läuft im Rufton.
   */
  timeToFirstAudioMs?: number;
  /** Median der Turn-Latenz über alle Agenten-Turns (ms) — Basis für Provider-Vergleiche. */
  turnLatencyMs?: number;
  /** Median-Anteil bis zum ersten LLM-Token (ms). */
  turnThinkMs?: number;
  /** Median-Anteil ab dem ersten Satz bis zum ersten Audio (ms). */
  turnTtsMs?: number;
  /** Anzahl gemessener Turns (Aussagekraft des Medians). */
  turns?: number;
  bargeIns: number;
  toolCalls: number;
  toolErrors: number;
  voiceProvider?: string;
  sttModel?: string;
  /** TTS-Verbrauch (nur native: dort senden WIR den Text und kennen die Abrechnungsbasis). */
  ttsProvider?: string;
  ttsModel?: string;
  ttsCharacters?: number;
  /** Nur ElevenLabs (Credit-Modell): Zeichen × Modell-Multiplikator (Flash/Turbo 0,5). */
  ttsCredits?: number;
  /**
   * LLM-Verbrauch (nur native — der gebündelte Voice-Agent meldet keine Token). Mengen,
   * keine Beträge: Preise sind vertragsabhängig und gehören nicht in eine Appliance.
   * `llmModel` ist das tatsächlich benutzte Modell, nicht das Feld am Agenten.
   */
  llmModel?: string;
  llmPromptTokens?: number;
  llmCachedPromptTokens?: number;
  llmCompletionTokens?: number;
  llmRequests?: number;
  /**
   * An den Sprach-Provider gestreamte Audiodauer in Sekunden. Nahe an `durationSec`, aber
   * nicht identisch: Während eines durchgestellten Gesprächs fließt nichts mehr zur Session.
   */
  sttSeconds?: number;
  /** Wie oft der Agent bei Stille nachgefasst hat (0.6.27) — Tuning-Basis für idlePrompts.timeoutMs. */
  idlePrompts?: number;
  /** Der Anruf endete, weil die Stille-Leiter erschöpft war (idlePrompts.hangupAfter). */
  idleHangup?: boolean;
  /** Sprache der ausgespielten Begrüßung, wenn sie aus einem Prior kam (0.7.0). */
  greetingLanguage?: string;
  /** Woher der Prior stammte ("profile"). Fehlt, wenn wie bisher in Standardsprache begrüßt wurde. */
  priorSource?: string;
  /** Hat der Anrufer den Prior bestätigt? `false` = er sprach eine andere Sprache. */
  priorConfirmed?: boolean;
}

/**
 * Wie ein Anruf endet.
 *
 * `abandoned` (0.10.1) ist weder das eine noch das andere: Der Anrufer war vor dem
 * Zustandekommen wieder weg — kein Gespräch, aber auch kein Fehler. Ohne diesen Wert
 * müsste ein aufgelegter Klingelversuch entweder als `failed` (eine Falschmeldung, die
 * den Betreiber alarmiert) oder als `completed` (ein Gespräch, das nie stattfand, und
 * das jede Auswertung über `status` verfälscht) verbucht werden.
 */
export type CallEndStatus = "completed" | "failed" | "abandoned";

export async function finalizeRequest(
  id: string,
  status: CallEndStatus,
  metrics?: CallMetrics,
  /** Warum das Gespräch endete — freier String, siehe `endedReason` im Request-Schema. */
  endedReason?: string,
): Promise<void> {
  const endedAt = new Date();
  // Anruflänge aus startedAt ableiten (immer, auch ohne Aufnahme — für Abrechnung/Statistik).
  const doc = await RequestModel.findById(id, { startedAt: 1 }).lean();
  const set: Record<string, unknown> = { status, endedAt };
  if (doc?.startedAt) {
    set.durationSec = Math.max(0, Math.round((endedAt.getTime() - new Date(doc.startedAt).getTime()) / 1000));
  }
  if (metrics) set.metrics = metrics;
  if (endedReason) set.endedReason = endedReason;
  await RequestModel.updateOne({ _id: id }, { $set: set });
}

/**
 * Boot-Sweep der Engine: Requests, die beim Start noch in_progress sind, stammen
 * zwangsläufig von einer früheren Engine-Instanz (Absturz/Redeploy mitten im Anruf) —
 * diese Anrufe existieren nicht mehr. Als failed markieren, damit Live-Ansicht und
 * Statistik sauber bleiben. endedAt bleibt bewusst leer (die echte Endezeit ist
 * unbekannt; eine Dauer aus „jetzt" wäre um Tage falsch — UI zeigt dann „—").
 */
export async function failOrphanedRequests(): Promise<number> {
  const res = await RequestModel.updateMany(
    { status: "in_progress" },
    { $set: { status: "failed" } },
  );
  return res.modifiedCount ?? 0;
}

export async function getTranscript(id: string): Promise<TranscriptTurn[]> {
  const doc = await RequestModel.findById(id, { transcript: 1 }).lean();
  return (doc?.transcript as TranscriptTurn[] | undefined) ?? [];
}
