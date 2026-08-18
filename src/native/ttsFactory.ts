/**
 * TTS-Provider-Matrix der NativeSession: aus agent.speak.provider wird der
 * passende Streaming-Client gebaut.
 *
 * Aufbau bewusst als Tabelle statt als if/else-Kette — sechs Zweige mit
 * identischer Form (Konfiguration prüfen → bauen → sonst Fallback) sind eine
 * Matrix. Der FALLBACK bleibt imperativ außerhalb der Tabelle, denn er ist die
 * eigentliche Zusage dieses Moduls: unvollständige oder unbekannte Konfiguration
 * fällt mit Warnung auf Aura zurück — ein Anruf scheitert nie an der TTS-Auswahl.
 *
 * Jeder Builder prüft seinen eigenen Modellstring. Neue `startsWith`-Heuristiken
 * über Providergrenzen hinweg gehören NICHT hierher (die alte Regel
 * `!model.startsWith("aura")` war genau das und ist damit überflüssig).
 */
import { supportsResample } from "../audio/resample.js";
import { config } from "../config.js";
import type { ResolvedAgent } from "../types.js";
import { logger } from "../util/logger.js";
import { ElevenLabsTtsStream } from "./ttsElevenLabs.js";
import { MistralTtsStream, MISTRAL_DEFAULT_MODEL, MISTRAL_SAMPLE_RATE } from "./ttsMistral.js";
import { AuraTtsStream } from "./ttsStream.js";
import type { TtsStreamLike } from "./types.js";

type Log = ReturnType<typeof logger.child>;

/** undefined = Konfiguration unvollständig → der Aufrufer fällt auf Aura zurück. */
type TtsBuilder = (agent: ResolvedAgent, callId: string, log: Log) => TtsStreamLike | undefined;

function buildAura(agent: ResolvedAgent, callId: string): AuraTtsStream {
  const model =
    agent.speak.model && agent.speak.model.startsWith("aura")
      ? agent.speak.model
      : config.defaultAgent.speakModel;
  return new AuraTtsStream(
    {
      url: config.native.ttsUrl,
      apiKey: config.deepgram.apiKey,
      model,
      encoding: config.audio.encoding,
      sampleRate: config.audio.sampleRate,
    },
    callId,
  );
}

const buildEleven: TtsBuilder = (agent, callId, log) => {
  const apiKey = config.elevenlabs.apiKey;
  const voiceId = agent.speak.voice?.trim();
  if (!apiKey || !voiceId) {
    log.warn("ElevenLabs-TTS unvollständig (ELEVENLABS_API_KEY oder Voice-ID fehlt)", {
      hasKey: Boolean(apiKey),
      hasVoice: Boolean(voiceId),
    });
    return undefined;
  }
  const modelId =
    agent.speak.model && agent.speak.model.startsWith("eleven")
      ? agent.speak.model
      : "eleven_flash_v2_5";
  const { stability, similarityBoost, speed } = agent.speak;
  const hasVoiceSettings =
    stability !== undefined || similarityBoost !== undefined || speed !== undefined;
  return new ElevenLabsTtsStream(
    {
      baseUrl: config.elevenlabs.baseUrl,
      apiKey,
      voiceId,
      modelId,
      outputFormat: `pcm_${config.audio.sampleRate}`,
      ...(hasVoiceSettings ? { voiceSettings: { stability, similarityBoost, speed } } : {}),
    },
    callId,
  );
};

const buildMistral: TtsBuilder = (agent, callId, log) => {
  const apiKey = config.mistral.apiKey;
  if (!apiKey) {
    log.warn("Mistral-TTS unvollständig (MISTRAL_API_KEY fehlt)");
    return undefined;
  }
  // Voxtral gibt fest 24 kHz aus; ohne unterstütztes Ratenpaar gäbe es nur Rauschen.
  if (!supportsResample(MISTRAL_SAMPLE_RATE, config.audio.sampleRate)) {
    log.warn("Mistral-TTS: Resampling nicht unterstützt", {
      from: MISTRAL_SAMPLE_RATE,
      to: config.audio.sampleRate,
    });
    return undefined;
  }
  const voiceId = agent.speak.voice?.trim();
  return new MistralTtsStream(
    {
      baseUrl: config.native.mistralUrl,
      apiKey,
      model:
        agent.speak.model && agent.speak.model.startsWith("voxtral")
          ? agent.speak.model
          : MISTRAL_DEFAULT_MODEL,
      ...(voiceId ? { voiceId } : {}),
      targetRate: config.audio.sampleRate,
      concurrency: config.native.httpTtsConcurrency,
    },
    callId,
  );
};

/** Schlüssel = agent.speak.provider (Enum aus tts/catalog.ts). */
const BUILDERS: Record<string, TtsBuilder> = {
  deepgram: (agent, callId) => buildAura(agent, callId),
  eleven_labs: buildEleven,
  mistral: buildMistral,
};

export function buildNativeTts(agent: ResolvedAgent, callId: string): TtsStreamLike {
  const log = logger.child({ mod: "native", callId });
  const provider = agent.speak.provider;
  const build = BUILDERS[provider];
  if (!build) {
    log.warn("Unbekannter speak.provider — Fallback auf Aura", { provider });
    return buildAura(agent, callId);
  }
  const tts = build(agent, callId, log);
  if (tts) return tts;
  log.warn("TTS-Konfiguration unvollständig — Fallback auf Aura", { provider });
  return buildAura(agent, callId);
}
