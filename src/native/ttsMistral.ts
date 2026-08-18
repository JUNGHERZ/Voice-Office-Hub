/**
 * Mistral-Voxtral-TTS-Client als HTTP/SSE-Variante hinter TtsStreamLike.
 * Anders als Aura/ElevenLabs gibt es hier keinen dauerhaften Socket: pro Satz
 * ein POST /v1/audio/speech mit stream:true, das Audio kommt als SSE-Deltas.
 * Reihenfolge, Flush- und Barge-in-Semantik liefert HttpTtsStream.
 *
 * Wire-Format (Doku-Stand 2026-08-17, nicht live gegengeprüft — siehe unten):
 *   POST {baseUrl}/audio/speech   Authorization: Bearer <key>
 *   {"model":"voxtral-mini-tts-latest","input":"…","voice_id":"de_female",
 *    "response_format":"pcm","stream":true}
 *   ← event: speech.audio.delta
 *     data: {"type":"speech.audio.delta","audio_data":"<base64 float32 LE, 24 kHz>"}
 *
 * Voxtral gibt IMMER 24 kHz aus; die Umsetzung auf die System-Rate (8 kHz)
 * übernimmt der Resampler der Basisklasse.
 *
 * PCM-BREITE: float32 LE (live gegengeprüft 2026-08-18). Die öffentliche
 * Quellenlage war widersprüchlich — manche Beschreibungen nannten 16-Bit-LE —,
 * deshalb bleibt die Erkennung am ersten Chunk mit Signal stehen (detectWidth):
 * falsch geraten klingt reines Rauschen, und die Erkennung kostet nichts.
 */
import { config } from "../config.js";
import { logger } from "../util/logger.js";
import { createSseParser } from "./llmStream.js";
import { HttpTtsStream } from "./ttsHttp.js";
import type { TtsUsage } from "./types.js";

/** Voxtral synthetisiert fest auf 24 kHz. */
export const MISTRAL_SAMPLE_RATE = 24000;

export interface MistralTtsOptions {
  /** Basis-URL bis /v1 (Default produktiv; Tests zeigen auf den Loopback-Server). */
  baseUrl: string;
  apiKey: string;
  model: string;
  /** Preset- oder geklonte Voice-ID; leer = Modell-Default. */
  voiceId?: string;
  /** System-Sample-Rate (Ziel des Resamplings). */
  targetRate: number;
  concurrency: number;
}

type PcmWidth = "f32" | "i16";

/**
 * Erkennt die PCM-Breite an einem Chunk mit Signal. Als float32 gelesenes Audio
 * liegt in [−1, 1]; als float32 gelesenes int16-PCM ergibt entweder denormale
 * Winzigkeiten oder absurd große Werte bzw. NaN. Reine Stille lässt keine
 * Entscheidung zu (beide Deutungen sind still) — dann undefined, und der nächste
 * Chunk entscheidet.
 */
export function detectWidth(buf: Buffer): PcmWidth | undefined {
  if (buf.length % 4 !== 0) return "i16"; // float32 käme nie mit ungerader Wortzahl
  let max = 0;
  for (let i = 0; i + 4 <= buf.length; i += 4) {
    const v = buf.readFloatLE(i);
    if (!Number.isFinite(v)) return "i16";
    const a = Math.abs(v);
    if (a > max) max = a;
  }
  if (max === 0) return undefined; // Stille — noch nicht entscheidbar
  // Ein plausibler float32-Pegel liegt bei ≤ ~1; alles darüber (oder denormal
  // winzig) spricht für fehlinterpretiertes int16.
  if (max <= 4 && max > 1e-6) return "f32";
  return "i16";
}

/** float32 [−1,1] → linear16 LE. */
function floatToInt16(buf: Buffer): Buffer {
  const samples = Math.floor(buf.length / 4);
  const out = Buffer.alloc(samples * 2);
  for (let i = 0; i < samples; i++) {
    const v = buf.readFloatLE(i * 4);
    const s = Math.round(v * 32767);
    out.writeInt16LE(s < -32768 ? -32768 : s > 32767 ? 32767 : s, i * 2);
  }
  return out;
}

interface AudioDelta {
  type?: string;
  /** Feldname der realen API (gegengeprüft 2026-08-18). */
  audio_data?: string;
  /** Ältere Doku nennt `delta` — tolerant beides lesen. */
  delta?: string;
}

export class MistralTtsStream extends HttpTtsStream {
  /** Einmal erkannt, gilt für die ganze Sitzung. */
  private width?: PcmWidth;

  constructor(
    private readonly opts: MistralTtsOptions,
    callId: string,
  ) {
    super(
      {
        sourceRate: MISTRAL_SAMPLE_RATE,
        targetRate: opts.targetRate,
        concurrency: opts.concurrency,
      },
      logger.child({ mod: "native-tts-mistral", callId }),
    );
  }

  buildUrl(): string {
    return `${this.opts.baseUrl.replace(/\/$/, "")}/audio/speech`;
  }

  buildBody(text: string): Record<string, unknown> {
    return {
      model: this.opts.model,
      input: text,
      ...(this.opts.voiceId ? { voice_id: this.opts.voiceId } : {}),
      // "pcm" ist das einzige Format ohne Container-Overhead — mp3 kostet laut
      // Mistral ~3 s Time-to-First-Audio statt ~0,8 s.
      response_format: "pcm",
      stream: true,
    };
  }

  protected async synthesize(
    text: string,
    signal: AbortSignal,
    onPcm: (pcm: Buffer) => void,
  ): Promise<void> {
    const res = await fetch(this.buildUrl(), {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.opts.apiKey}`,
        "Content-Type": "application/json",
        Accept: "text/event-stream",
      },
      body: JSON.stringify(this.buildBody(text)),
      signal,
    });

    if (!res.ok || !res.body) {
      const detail = await res.text().catch(() => "");
      throw new Error(`Mistral-TTS HTTP ${res.status}: ${detail.slice(0, 200)}`);
    }

    const parse = createSseParser((payload) => {
      if (!payload || payload === "[DONE]") return;
      let msg: AudioDelta;
      try {
        msg = JSON.parse(payload) as AudioDelta;
      } catch {
        return; // Kommentar-/Keepalive-Zeilen tolerieren
      }
      const b64 = msg.audio_data ?? msg.delta;
      if (typeof b64 !== "string" || !b64.length) return;
      const raw = Buffer.from(b64, "base64");
      if (!raw.length) return;

      this.width ??= detectWidth(raw);
      if (this.width === undefined) return; // reine Stille — verwerfen, nichts verloren
      onPcm(this.width === "f32" ? floatToInt16(raw) : raw);
    });

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      parse(decoder.decode(value, { stream: true }));
    }
  }

  /** Mistral rechnet pro Zeichen ab ($0,016 / 1k). */
  usage(): TtsUsage {
    return {
      provider: "mistral",
      model: this.opts.model,
      characters: this.charactersSent,
    };
  }
}

/** Default-Modell, wenn agent.speak.model leer ist oder zu einem anderen Provider gehört. */
export const MISTRAL_DEFAULT_MODEL = "voxtral-mini-tts-latest";

export function buildMistralOptions(model: string | undefined, voice: string | undefined): Omit<MistralTtsOptions, "apiKey"> {
  return {
    baseUrl: config.native.mistralUrl,
    model: model && model.startsWith("voxtral") ? model : MISTRAL_DEFAULT_MODEL,
    ...(voice ? { voiceId: voice } : {}),
    targetRate: config.audio.sampleRate,
    concurrency: config.native.httpTtsConcurrency,
  };
}
