/**
 * Azure-Neural-TTS-Client (Speech Service, REST) als HTTP-Variante hinter
 * TtsStreamLike. Pro Satz ein POST auf /cognitiveservices/v1; Reihenfolge,
 * Flush- und Barge-in-Semantik liefert HttpTtsStream.
 *
 * Wire-Format (verifiziert gegen die Azure-REST-Referenz, 2026-08-18):
 *   POST https://{region}.tts.speech.microsoft.com/cognitiveservices/v1
 *   Ocp-Apim-Subscription-Key: <key>
 *   Content-Type: application/ssml+xml
 *   X-Microsoft-OutputFormat: raw-8khz-16bit-mono-pcm
 *   User-Agent: <Pflichtfeld laut Doku>
 *   <speak version='1.0' xml:lang='de-DE'><voice name='de-DE-KatjaNeural'>…</voice></speak>
 *   ← rohe PCM-Bytes, chunked
 *
 * Warum REST und nicht der WebSocket-v2-Endpunkt: Nur der kann Text streamen
 * (Tokens direkt in den Socket), aber Microsoft unterstützt das ausschließlich
 * in den SDKs für C#, C++ und Python — für Node gibt es kein SDK-Feature und
 * kein öffentlich dokumentiertes Wire-Format. Ein Nachbau wäre geraten, nicht
 * spezifiziert. Deshalb erst REST messen; lohnt die Zahl, kann man den v2-Pfad
 * immer noch angehen.
 *
 * 8 kHz und 16 kHz sind native Ausgabeformate — im Regelbetrieb wird also NICHT
 * resampelt (anders als bei Voxtral mit seinen festen 24 kHz).
 */
import { supportsResample } from "../audio/resample.js";
import { logger } from "../util/logger.js";
import { HttpTtsStream } from "./ttsHttp.js";
import type { TtsUsage } from "./types.js";

/** Native Ausgabeformate je System-Sample-Rate; sonst 24 kHz + Resampling. */
const NATIVE_FORMATS: Record<number, string> = {
  8000: "raw-8khz-16bit-mono-pcm",
  16000: "raw-16khz-16bit-mono-pcm",
  22050: "raw-22050hz-16bit-mono-pcm",
  24000: "raw-24khz-16bit-mono-pcm",
  44100: "raw-44100hz-16bit-mono-pcm",
  48000: "raw-48khz-16bit-mono-pcm",
};
const FALLBACK_RATE = 24000;
const FALLBACK_FORMAT = NATIVE_FORMATS[FALLBACK_RATE] as string;

/**
 * Ausgabeformat und Quell-Rate bestimmen. Trifft die System-Rate ein natives
 * Format, wird 1:1 geliefert; sonst 24 kHz und der Resampler übernimmt.
 */
export function pickOutputFormat(targetRate: number): { format: string; sourceRate: number } {
  const native = NATIVE_FORMATS[targetRate];
  if (native) return { format: native, sourceRate: targetRate };
  return { format: FALLBACK_FORMAT, sourceRate: FALLBACK_RATE };
}

/** Azure kann diese Rate bedienen — nativ oder über den Resampler. */
export function azureCanServe(targetRate: number): boolean {
  return Boolean(NATIVE_FORMATS[targetRate]) || supportsResample(FALLBACK_RATE, targetRate);
}

/**
 * XML-Escaping des Sprechtexts. Nicht optional: der Body ist SSML, und ein
 * kaufmännisches Und oder eine spitze Klammer aus der LLM-Antwort ("Meyer & Sohn",
 * "<Platzhalter>") würde das Dokument sonst zerreißen — Azure antwortet mit 400
 * und der Satz fiele stumm aus.
 */
export function escapeXml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/** Locale aus dem Stimmnamen ableiten: "de-DE-KatjaNeural" → "de-DE". */
export function localeFromVoice(voice: string): string {
  const m = /^([a-z]{2,3}-[A-Za-z]{2,4})-/.exec(voice);
  return m?.[1] ?? "en-US";
}

export interface AzureTtsOptions {
  /** Vollständige Synthese-URL (…/cognitiveservices/v1). */
  endpoint: string;
  apiKey: string;
  /** Azure-Stimmname, z. B. "de-DE-KatjaNeural". */
  voice: string;
  /** xml:lang; leer = aus dem Stimmnamen abgeleitet. */
  language?: string;
  targetRate: number;
  concurrency: number;
}

export class AzureTtsStream extends HttpTtsStream {
  private readonly format: string;

  constructor(
    private readonly opts: AzureTtsOptions,
    callId: string,
  ) {
    const { format, sourceRate } = pickOutputFormat(opts.targetRate);
    super(
      { sourceRate, targetRate: opts.targetRate, concurrency: opts.concurrency },
      logger.child({ mod: "native-tts-azure", callId }),
    );
    this.format = format;
  }

  buildSsml(text: string): string {
    const lang = this.opts.language?.trim() || localeFromVoice(this.opts.voice);
    return (
      `<speak version='1.0' xml:lang='${escapeXml(lang)}'>` +
      `<voice name='${escapeXml(this.opts.voice)}'>${escapeXml(text)}</voice>` +
      `</speak>`
    );
  }

  protected async synthesize(
    text: string,
    signal: AbortSignal,
    onPcm: (pcm: Buffer) => void,
  ): Promise<void> {
    const res = await fetch(this.opts.endpoint, {
      method: "POST",
      headers: {
        "Ocp-Apim-Subscription-Key": this.opts.apiKey,
        "Content-Type": "application/ssml+xml",
        "X-Microsoft-OutputFormat": this.format,
        // Laut Doku ein Pflicht-Header — ohne ihn droht 400/502.
        "User-Agent": "voice-office-hub",
      },
      body: this.buildSsml(text),
      signal,
    });

    if (!res.ok || !res.body) {
      const detail = await res.text().catch(() => "");
      throw new Error(`Azure-TTS HTTP ${res.status}: ${detail.slice(0, 200)}`);
    }

    const reader = res.body.getReader();
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      if (value?.length) onPcm(Buffer.from(value));
    }
  }

  /** Azure rechnet pro Zeichen ab ($16 / 1 Mio. Zeichen bei Neural). */
  usage(): TtsUsage {
    return { provider: "azure", model: this.opts.voice, characters: this.charactersSent };
  }
}

/** Regionale Basis-URL, wenn kein vollständiger Endpoint konfiguriert ist. */
export function azureEndpointFor(region: string): string {
  return `https://${region}.tts.speech.microsoft.com/cognitiveservices/v1`;
}

/** Stimmliste derselben Region (für den Admin-Proxy). */
export function azureVoicesUrlFor(region: string): string {
  return `https://${region}.tts.speech.microsoft.com/cognitiveservices/voices/list`;
}
