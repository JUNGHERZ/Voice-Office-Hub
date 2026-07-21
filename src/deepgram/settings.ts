/**
 * Baut die Deepgram-`Settings`-Nachricht aus einem aufgelösten Agent + Basis-Config.
 *
 * think.source steuert die LLM-Anbindung:
 *   - "requesty"  → provider.type "open_ai" + endpoint auf den Requesty-Router (BYO).
 *   - "deepgram"  → von Deepgram integriert gehostetes Modell (ohne endpoint).
 *
 * audio.* und flags kommen systemweit aus der Config (Telefonie: linear16/8000).
 */
import { config } from "../config.js";
import type { ResolvedAgent } from "../types.js";
import { logger } from "../util/logger.js";
import type { FunctionDefinition, SettingsMessage } from "./events.js";

const log = logger.child({ mod: "settings" });

export function buildSettings(agent: ResolvedAgent, functions: FunctionDefinition[]): SettingsMessage {
  const isFlux = agent.listen.model.startsWith("flux");
  const listenProvider: Record<string, unknown> = {
    type: "deepgram",
    model: agent.listen.model,
  };
  if (isFlux) {
    // Flux läuft über die v2-Spec: `version` ist Pflicht; `language`/`smart_format` lehnt die
    // API mit "Error parsing client message" ab (empirisch verifiziert 2026-07-20).
    listenProvider.version = "v2";
    // language_hints sind nur beim multilingualen Flux-Modell gültig.
    if (agent.listen.model.includes("multi") && agent.listen.language_hints.length)
      listenProvider.language_hints = agent.listen.language_hints;
    // Modellintegrierte End-of-Turn-Erkennung (von der API akzeptiert).
    if (agent.listen.eot_threshold !== undefined) listenProvider.eot_threshold = agent.listen.eot_threshold;
    if (agent.listen.eot_timeout_ms !== undefined) listenProvider.eot_timeout_ms = agent.listen.eot_timeout_ms;
  } else {
    // nova-3: Sprache gehört in den Provider ("multi" für multilingual, sonst BCP-47 wie "de").
    listenProvider.language = agent.language;
    if (agent.listen.smart_format) listenProvider.smart_format = true;
  }
  if (agent.listen.keyterms.length) listenProvider.keyterms = agent.listen.keyterms;

  const think = buildThink(agent, functions);
  const speak = buildSpeak(agent);

  return {
    type: "Settings",
    audio: {
      input: { encoding: config.audio.encoding, sample_rate: config.audio.sampleRate },
      output: { encoding: config.audio.encoding, sample_rate: config.audio.sampleRate, container: "none" },
    },
    agent: {
      listen: { provider: listenProvider },
      think,
      speak,
      ...(agent.greeting ? { greeting: agent.greeting } : {}),
    },
    ...(agent.tags.length ? { tags: agent.tags } : {}),
    mip_opt_out: agent.mip_opt_out,
    flags: { history: true },
  };
}

function buildThink(agent: ResolvedAgent, functions: FunctionDefinition[]): SettingsMessage["agent"]["think"] {
  const base: SettingsMessage["agent"]["think"] = {
    provider: {},
    prompt: agent.prompt,
    ...(functions.length ? { functions } : {}),
    ...(agent.think.context_length !== undefined ? { context_length: agent.think.context_length } : {}),
  };

  if (agent.think.source === "requesty") {
    const model = agent.think.model || config.llm.model;
    base.provider = {
      type: "open_ai",
      model,
      ...(modelSupportsTemperature(model) ? { temperature: agent.think.temperature } : {}),
    };
    base.endpoint = {
      url: `${config.llm.requestyBaseUrl.replace(/\/$/, "")}/chat/completions`,
      headers: { authorization: `Bearer ${config.llm.requestyApiKey}` },
    };
  } else {
    // Deepgram-managed Modell (z.B. anthropic / open_ai), ohne eigenen endpoint.
    const provider: Record<string, unknown> = {
      type: inferManagedProviderType(agent.think.model),
      model: agent.think.model,
      ...(modelSupportsTemperature(agent.think.model) ? { temperature: agent.think.temperature } : {}),
    };
    if (agent.think.reasoning_mode) provider.reasoning_mode = agent.think.reasoning_mode;
    base.provider = provider;
  }

  return base;
}

/**
 * GPT-5-Familie (und OpenAI-Reasoning-Modelle o1/o3) akzeptieren nur die Default-Temperatur;
 * ein abweichender Wert führt zu Upstream-400 → Deepgram meldet "Failed to think".
 */
function modelSupportsTemperature(model: string): boolean {
  return !/(^|\/)(gpt-5|o1|o3)/i.test(model);
}

/** Grobe Ableitung des Provider-Typs aus der Modell-ID für Deepgram-managed Modelle. */
function inferManagedProviderType(model: string): string {
  if (model.startsWith("claude")) return "anthropic";
  if (model.startsWith("gemini")) return "google";
  return "open_ai";
}

/**
 * speak-Block der Settings. ElevenLabs läuft über die Dritt-TTS-Durchreiche der
 * Voice-Agent-API: provider {type:"eleven_labs", model_id} + endpoint mit der
 * Voice-ID in der URL und dem API-Key als xi-api-key-Header (Key nur aus dem
 * Server-Env — nie in der DB). Unvollständige Konfiguration fällt auf die
 * Deepgram-Stimme zurück; ein Anruf scheitert nie an der TTS-Auswahl.
 */
function buildSpeak(agent: ResolvedAgent): SettingsMessage["agent"]["speak"] {
  if (agent.speak.provider === "eleven_labs") {
    const apiKey = config.elevenlabs.apiKey;
    const voiceId = agent.speak.voice?.trim();
    if (!apiKey || !voiceId) {
      log.warn("ElevenLabs-TTS unvollständig (ELEVENLABS_API_KEY oder Voice-ID fehlt) — Fallback auf Deepgram-Stimme", {
        agent: agent.name,
        hasKey: Boolean(apiKey),
        hasVoice: Boolean(voiceId),
      });
      return { provider: buildDeepgramSpeakProvider(agent, config.defaultAgent.speakModel) };
    }
    // speak.model trägt hier die ElevenLabs-Modell-ID; ein (Default-)Aura-Wert wäre falsch.
    const modelId =
      agent.speak.model && !agent.speak.model.startsWith("aura") ? agent.speak.model : "eleven_turbo_v2_5";
    const provider: Record<string, unknown> = { type: "eleven_labs", model_id: modelId };
    if (agent.speak.language) provider.language_code = agent.speak.language;
    return {
      provider,
      endpoint: {
        url: `wss://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voiceId)}/multi-stream-input`,
        headers: { "xi-api-key": apiKey },
      },
    };
  }
  return { provider: buildDeepgramSpeakProvider(agent, agent.speak.model) };
}

function buildDeepgramSpeakProvider(agent: ResolvedAgent, model: string): Record<string, unknown> {
  const p: Record<string, unknown> = { type: "deepgram" };
  if (model) p.model = model;
  if (agent.speak.voice) p.voice = agent.speak.voice;
  if (agent.speak.language) p.language = agent.speak.language;
  if (agent.speak.speed !== undefined) p.speed = agent.speak.speed;
  if (agent.speak.volume !== undefined) p.volume = agent.speak.volume;
  return p;
}
