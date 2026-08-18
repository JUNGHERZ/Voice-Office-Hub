/**
 * Speechify-Simba-Client (HTTP chunked) als HTTP-Variante hinter TtsStreamLike.
 * Pro Satz ein POST /v1/audio/stream; Reihenfolge, Flush- und Barge-in-Semantik
 * liefert HttpTtsStream.
 *
 * Wire-Format (Doku-Stand 2026-08-18, NICHT live gegengeprüft — kein Schlüssel
 * vorhanden):
 *   POST {baseUrl}/audio/stream   Authorization: Bearer <key>
 *   {"input":"…","voice_id":"…","model":"simba-3.0","language":"de-DE",
 *    "output_format":"pcm_8000"}
 *   ← rohe Audio-Bytes, chunked
 *
 * MODELLWAHL: Default ist `simba-3.0`, nicht das neuere `simba-3.2` — nur 3.0
 * spricht Deutsch (dazu en, es, fr, it, pt-BR). 3.2 ist streaming-nativ und
 * schneller, aber englisch-only.
 *
 * STIMMEN: Die dokumentierten `*_32`-Stimmen gehören zu simba-3.2 und damit zu
 * Englisch. Für 3.0 gibt es keine öffentliche Liste; die IDs kommen aus
 * `GET /v1/voices?model=simba-3.0&locale=de-DE`. Deshalb steht im Katalog keine
 * deutsche Stimme — das Freitextfeld trägt, bis jemand mit Schlüssel die Liste
 * abruft.
 *
 * Kein SSML: Emotion und Tempo gingen bei Speechify nur über SSML-Markup, das
 * das LLM erzeugen müsste. Der Satz-Chunker schneidet aber an `.`/`!`/`?` — also
 * mitten durch ein Tag —, und das Markup landete im DB-Transkript und im
 * Sprach-Scorer. Großer Radius für einen kosmetischen Gewinn.
 */
import { logger } from "../util/logger.js";
import { HttpTtsStream } from "./ttsHttp.js";
import type { TtsUsage } from "./types.js";

/** Ausgabeformate mit nativer Rate; sonst 24 kHz + Resampling. */
const NATIVE_FORMATS: Record<number, string> = {
  8000: "pcm_8000",
  16000: "pcm_16000",
  22050: "pcm_22050",
  24000: "pcm_24000",
  44100: "pcm_44100",
  48000: "pcm_48000",
};
const FALLBACK_RATE = 24000;

export function pickSpeechifyFormat(targetRate: number): { format: string; sourceRate: number } {
  const native = NATIVE_FORMATS[targetRate];
  if (native) return { format: native, sourceRate: targetRate };
  return { format: NATIVE_FORMATS[FALLBACK_RATE] as string, sourceRate: FALLBACK_RATE };
}

export function speechifyCanServe(targetRate: number): boolean {
  return Boolean(NATIVE_FORMATS[targetRate]);
}

/**
 * Ein vorangestellter RIFF/WAVE-Header wird abgeschnitten. Die Doku sagt "pcm",
 * aber wenn der Dienst doch einen Container liefert, wären die ersten 44 Byte
 * Kopfdaten — im Sprachkanal ein hörbarer Knacks am Satzanfang. Die Prüfung
 * kostet nichts und entfällt still, wenn kein Header kommt.
 */
export function stripRiffHeader(buf: Buffer): Buffer {
  if (buf.length < 12) return buf;
  if (buf.toString("ascii", 0, 4) !== "RIFF" || buf.toString("ascii", 8, 12) !== "WAVE") return buf;
  // Chunks durchgehen, bis "data" kommt.
  let off = 12;
  while (off + 8 <= buf.length) {
    const id = buf.toString("ascii", off, off + 4);
    const size = buf.readUInt32LE(off + 4);
    if (id === "data") return buf.subarray(off + 8);
    off += 8 + size + (size % 2);
  }
  return buf;
}

export interface SpeechifyTtsOptions {
  /** Basis bis /v1. */
  baseUrl: string;
  apiKey: string;
  voiceId: string;
  /** simba-3.0 (Default, kann Deutsch) | simba-3.2 (nur en) | simba-multilingual */
  model: string;
  /** Locale wie "de-DE"; leer = Speechify entscheidet. */
  language?: string;
  targetRate: number;
  concurrency: number;
}

export class SpeechifyTtsStream extends HttpTtsStream {
  private readonly format: string;
  /** Header nur am Anfang eines Auftrags prüfen. */
  private headerChecked = false;

  constructor(
    private readonly opts: SpeechifyTtsOptions,
    callId: string,
  ) {
    const { format, sourceRate } = pickSpeechifyFormat(opts.targetRate);
    super(
      { sourceRate, targetRate: opts.targetRate, concurrency: opts.concurrency },
      logger.child({ mod: "native-tts-speechify", callId }),
    );
    this.format = format;
  }

  buildUrl(): string {
    return `${this.opts.baseUrl.replace(/\/$/, "")}/audio/stream`;
  }

  buildBody(text: string): Record<string, unknown> {
    return {
      input: text,
      voice_id: this.opts.voiceId,
      model: this.opts.model,
      ...(this.opts.language ? { language: this.opts.language } : {}),
      output_format: this.format,
    };
  }

  protected async synthesize(
    text: string,
    signal: AbortSignal,
    onPcm: (pcm: Buffer) => void,
  ): Promise<void> {
    this.headerChecked = false;
    const res = await fetch(this.buildUrl(), {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.opts.apiKey}`,
        "Content-Type": "application/json",
        Accept: "audio/pcm",
      },
      body: JSON.stringify(this.buildBody(text)),
      signal,
    });

    if (!res.ok || !res.body) {
      const detail = await res.text().catch(() => "");
      throw new Error(`Speechify-TTS HTTP ${res.status}: ${detail.slice(0, 200)}`);
    }

    const reader = res.body.getReader();
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      if (!value?.length) continue;
      let chunk = Buffer.from(value);
      if (!this.headerChecked) {
        this.headerChecked = true;
        chunk = stripRiffHeader(chunk);
      }
      if (chunk.length) onPcm(chunk);
    }
  }

  /** Speechify rechnet pro Zeichen ab ($6–10 / 1 Mio. je Tarif). */
  usage(): TtsUsage {
    return { provider: "speechify", model: this.opts.model, characters: this.charactersSent };
  }
}

export const SPEECHIFY_DEFAULT_MODEL = "simba-3.0";
