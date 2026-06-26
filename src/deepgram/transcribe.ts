/**
 * Batch-/Pre-recorded-Transkription (für den Passthrough-Modus, spätere Ausbaustufe).
 * Schickt eine WAV-Datei an die Deepgram Pre-recorded API mit Diarization und überführt
 * das Ergebnis in unser JSON-Transkriptformat ({ t, end, speaker, text }).
 *
 * Sprecher-Mapping: Diarization liefert speaker 0/1; wir mappen auf caller/callee
 * (Konvention: erster Sprecher = caller / die initiierende Bridge-Seite).
 */
import { readFile } from "node:fs/promises";

import { config } from "../config.js";
import type { TranscriptTurn } from "../db/repository.js";
import { logger } from "../util/logger.js";

const log = logger.child({ mod: "dg-transcribe" });
const PRERECORDED_URL = "https://api.deepgram.com/v1/listen";

export async function transcribeRecording(localPath: string): Promise<TranscriptTurn[]> {
  const audio = await readFile(localPath);
  const params = new URLSearchParams({
    model: "nova-3",
    diarize: "true",
    punctuate: "true",
    utterances: "true",
    detect_language: "true",
  });

  const res = await fetch(`${PRERECORDED_URL}?${params.toString()}`, {
    method: "POST",
    headers: {
      Authorization: `Token ${config.deepgram.apiKey}`,
      "Content-Type": "audio/wav",
    },
    body: audio,
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    log.error("Pre-recorded Transkription fehlgeschlagen", { status: res.status, body });
    throw new Error(`Deepgram pre-recorded ${res.status}`);
  }

  const json = (await res.json()) as PrerecordedResponse;
  return mapUtterances(json);
}

function mapUtterances(json: PrerecordedResponse): TranscriptTurn[] {
  const utterances = json.results?.utterances ?? [];
  return utterances.map((u) => ({
    t: u.start,
    end: u.end,
    speaker: u.speaker === 0 ? "caller" : "callee",
    text: u.transcript,
  }));
}

interface PrerecordedResponse {
  results?: {
    utterances?: Array<{ start: number; end: number; speaker: number; transcript: string }>;
  };
}
