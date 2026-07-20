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
  agentId?: Types.ObjectId;
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
    agentId: input.agentId,
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
  /** Answer → erstes TTS-Audio (Begrüßung), in Millisekunden. */
  timeToFirstAudioMs?: number;
  bargeIns: number;
  toolCalls: number;
  toolErrors: number;
  voiceProvider?: string;
  sttModel?: string;
}

export async function finalizeRequest(
  id: string,
  status: "completed" | "failed",
  metrics?: CallMetrics,
): Promise<void> {
  const endedAt = new Date();
  // Anruflänge aus startedAt ableiten (immer, auch ohne Aufnahme — für Abrechnung/Statistik).
  const doc = await RequestModel.findById(id, { startedAt: 1 }).lean();
  const set: Record<string, unknown> = { status, endedAt };
  if (doc?.startedAt) {
    set.durationSec = Math.max(0, Math.round((endedAt.getTime() - new Date(doc.startedAt).getTime()) / 1000));
  }
  if (metrics) set.metrics = metrics;
  await RequestModel.updateOne({ _id: id }, { $set: set });
}

export async function getTranscript(id: string): Promise<TranscriptTurn[]> {
  const doc = await RequestModel.findById(id, { transcript: 1 }).lean();
  return (doc?.transcript as TranscriptTurn[] | undefined) ?? [];
}
