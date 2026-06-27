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
import type { FunctionDefinition, SettingsMessage } from "./events.js";

export function buildSettings(agent: ResolvedAgent, functions: FunctionDefinition[]): SettingsMessage {
  const listenProvider: Record<string, unknown> = {
    type: "deepgram",
    model: agent.listen.model,
    // Sprache gehört in den Provider (agent.language ist deprecated). "multi" für nova-3 multilingual.
    language: agent.language,
  };
  // language_hints ist nur bei Flux-Modellen (flux-general-multi) gültig; nova-3 lehnt das Feld ab.
  if (agent.listen.model.startsWith("flux") && agent.listen.language_hints.length)
    listenProvider.language_hints = agent.listen.language_hints;
  if (agent.listen.keyterms.length) listenProvider.keyterms = agent.listen.keyterms;
  if (agent.listen.smart_format) listenProvider.smart_format = true;
  if (agent.listen.eot_threshold !== undefined) listenProvider.eot_threshold = agent.listen.eot_threshold;
  if (agent.listen.eot_timeout_ms !== undefined) listenProvider.eot_timeout_ms = agent.listen.eot_timeout_ms;

  const think = buildThink(agent, functions);
  const speakProvider = buildSpeakProvider(agent);

  return {
    type: "Settings",
    audio: {
      input: { encoding: config.audio.encoding, sample_rate: config.audio.sampleRate },
      output: { encoding: config.audio.encoding, sample_rate: config.audio.sampleRate, container: "none" },
    },
    agent: {
      listen: { provider: listenProvider },
      think,
      speak: { provider: speakProvider },
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

function buildSpeakProvider(agent: ResolvedAgent): Record<string, unknown> {
  const p: Record<string, unknown> = { type: agent.speak.provider };
  // Deepgram/OpenAI nutzen "model", Eleven Labs/Cartesia "model_id" + "voice".
  if (agent.speak.provider === "eleven_labs" || agent.speak.provider === "cartesia") {
    if (agent.speak.model) p.model_id = agent.speak.model;
  } else if (agent.speak.model) {
    p.model = agent.speak.model;
  }
  if (agent.speak.voice) p.voice = agent.speak.voice;
  if (agent.speak.language) p.language = agent.speak.language;
  if (agent.speak.speed !== undefined) p.speed = agent.speak.speed;
  if (agent.speak.volume !== undefined) p.volume = agent.speak.volume;
  return p;
}
