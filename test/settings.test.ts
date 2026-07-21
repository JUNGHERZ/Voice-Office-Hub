import assert from "node:assert/strict";
import { test } from "node:test";

import { config } from "../src/config.js";
import { buildSettings } from "../src/deepgram/settings.js";
import type { ResolvedAgent } from "../src/types.js";

function agent(overrides: Partial<ResolvedAgent> = {}): ResolvedAgent {
  return {
    name: "test",
    mode: "agent",
    voiceProvider: "deepgram",
    targetNumbers: [],
    useTransferCallerId: false,
    language: "multi",
    greeting: "Hallo",
    prompt: "Du bist ein Assistent.",
    listen: { model: "nova-3", language_hints: ["de", "en"], keyterms: ["Loupz"], smart_format: true },
    think: { source: "requesty", model: "openai/gpt-4o", temperature: 0.5 },
    speak: { provider: "deepgram", model: "aura-2-thalia-en" },
    tools: [],
    customTools: [],
    mcpServers: [],
    summary: { enabled: false, prompt: "", model: "openai/gpt-4.1-mini" },
    ambience: { enabled: false, preset: "office", volume: 0.25 },
    tags: ["support"],
    mip_opt_out: false,
    ...overrides,
  };
}

test("buildSettings: Grundgerüst + Audio aus Config", () => {
  const s = buildSettings(agent(), []);
  assert.equal(s.type, "Settings");
  assert.equal(s.audio.input.sample_rate, config.audio.sampleRate);
  assert.equal(s.audio.output.sample_rate, config.audio.sampleRate);
  assert.equal((s.agent.listen.provider as Record<string, unknown>).language, "multi");
  assert.equal(s.agent.greeting, "Hallo");
  assert.deepEqual(s.tags, ["support"]);
  assert.equal(s.mip_opt_out, false);
});

test("buildSettings: listen-Optionen werden übernommen (nova-3: language statt language_hints)", () => {
  const s = buildSettings(agent(), []);
  const p = s.agent.listen.provider as Record<string, unknown>;
  assert.equal(p.model, "nova-3");
  assert.equal(p.language, "multi");
  // language_hints ist nur für Flux gültig → bei nova-3 weggelassen.
  assert.equal(p.language_hints, undefined);
  assert.deepEqual(p.keyterms, ["Loupz"]);
  assert.equal(p.smart_format, true);
});

test("buildSettings: Flux → v2-Spec (version, hints; ohne language/smart_format)", () => {
  const s = buildSettings(
    agent({ listen: { model: "flux-general-multi", language_hints: ["de", "en"], keyterms: [], smart_format: true } }),
    [],
  );
  const p = s.agent.listen.provider as Record<string, unknown>;
  assert.equal(p.version, "v2", "Flux verlangt version v2");
  assert.deepEqual(p.language_hints, ["de", "en"]);
  // Die API lehnt language/smart_format bei Flux ab ("Error parsing client message").
  assert.equal(p.language, undefined);
  assert.equal(p.smart_format, undefined);

  // flux-general-en: keine language_hints (nur beim multilingualen Modell gültig).
  const en = buildSettings(
    agent({ listen: { model: "flux-general-en", language_hints: ["de"], keyterms: [], smart_format: false } }),
    [],
  );
  const pEn = en.agent.listen.provider as Record<string, unknown>;
  assert.equal(pEn.version, "v2");
  assert.equal(pEn.language_hints, undefined);
});

test("buildSettings: eot_* nur bei Flux-Modellen (nova-3 lehnt die Felder ab)", () => {
  const nova = buildSettings(
    agent({ listen: { model: "nova-3", language_hints: [], keyterms: [], smart_format: true, eot_threshold: 0.7, eot_timeout_ms: 3000 } }),
    [],
  );
  const pNova = nova.agent.listen.provider as Record<string, unknown>;
  assert.equal(pNova.eot_threshold, undefined);
  assert.equal(pNova.eot_timeout_ms, undefined);

  const flux = buildSettings(
    agent({ listen: { model: "flux-general-multi", language_hints: [], keyterms: [], smart_format: true, eot_threshold: 0.7, eot_timeout_ms: 3000 } }),
    [],
  );
  const pFlux = flux.agent.listen.provider as Record<string, unknown>;
  assert.equal(pFlux.eot_threshold, 0.7);
  assert.equal(pFlux.eot_timeout_ms, 3000);
});

test("buildSettings: think=requesty → open_ai + Requesty-Endpoint", () => {
  const s = buildSettings(agent({ think: { source: "requesty", model: "x", temperature: 0.3 } }), []);
  const provider = s.agent.think.provider as Record<string, unknown>;
  assert.equal(provider.type, "open_ai");
  assert.ok(s.agent.think.endpoint, "Endpoint erwartet");
  assert.match(String(s.agent.think.endpoint!.url), /\/chat\/completions$/);
  assert.match(String(s.agent.think.endpoint!.headers?.authorization), /^Bearer /);
});

test("buildSettings: think=deepgram (claude) → anthropic, kein Endpoint", () => {
  const s = buildSettings(
    agent({ think: { source: "deepgram", model: "claude-sonnet-4-6", temperature: 0.5 } }),
    [],
  );
  const provider = s.agent.think.provider as Record<string, unknown>;
  assert.equal(provider.type, "anthropic");
  assert.equal(s.agent.think.endpoint, undefined);
});

test("buildSettings: GPT-5 (managed) ohne temperature", () => {
  const s = buildSettings(
    agent({ think: { source: "deepgram", model: "gpt-5-mini", temperature: 0.5 } }),
    [],
  );
  const provider = s.agent.think.provider as Record<string, unknown>;
  assert.equal(provider.type, "open_ai");
  assert.equal(provider.model, "gpt-5-mini");
  assert.equal(provider.temperature, undefined);
});

test("buildSettings: gpt-4o-mini (managed) mit temperature", () => {
  const s = buildSettings(
    agent({ think: { source: "deepgram", model: "gpt-4o-mini", temperature: 0.5 } }),
    [],
  );
  const provider = s.agent.think.provider as Record<string, unknown>;
  assert.equal(provider.temperature, 0.5);
});

test("buildSettings: Functions werden eingebettet", () => {
  const fns = [{ name: "get_status", description: "d", parameters: { type: "object" } }];
  const s = buildSettings(agent(), fns);
  assert.deepEqual(s.agent.think.functions, fns);
});

test("buildSettings: speak-Provider (deepgram) nutzt model", () => {
  const s = buildSettings(agent(), []);
  const p = s.agent.speak.provider as Record<string, unknown>;
  assert.equal(p.type, "deepgram");
  assert.equal(p.model, "aura-2-thalia-en");
  assert.equal(s.agent.speak.endpoint, undefined, "Deepgram-TTS braucht keinen Endpoint");
});

test("buildSettings: eleven_labs → Dritt-TTS mit Voice-URL und xi-api-key", () => {
  const prevKey = config.elevenlabs.apiKey;
  config.elevenlabs.apiKey = "xi-test-key";
  try {
    const s = buildSettings(
      agent({ speak: { provider: "eleven_labs", model: "eleven_flash_v2_5", voice: "21m00Tcm4TlvDq8ikWAM" } }),
      [],
    );
    const p = s.agent.speak.provider as Record<string, unknown>;
    assert.equal(p.type, "eleven_labs");
    assert.equal(p.model_id, "eleven_flash_v2_5");
    assert.equal(
      s.agent.speak.endpoint?.url,
      "wss://api.elevenlabs.io/v1/text-to-speech/21m00Tcm4TlvDq8ikWAM/multi-stream-input",
    );
    assert.equal(s.agent.speak.endpoint?.headers?.["xi-api-key"], "xi-test-key");

    // Ein (Default-)Aura-Modell wäre für ElevenLabs falsch → dokumentiertes Default-Modell.
    const s2 = buildSettings(
      agent({ speak: { provider: "eleven_labs", model: "aura-2-thalia-en", voice: "v1" } }),
      [],
    );
    assert.equal((s2.agent.speak.provider as Record<string, unknown>).model_id, "eleven_turbo_v2_5");
  } finally {
    config.elevenlabs.apiKey = prevKey;
  }
});

test("buildSettings: eleven_labs ohne Key/Voice-ID → Fallback auf Deepgram-Stimme", () => {
  const prevKey = config.elevenlabs.apiKey;
  config.elevenlabs.apiKey = "";
  try {
    const s = buildSettings(agent({ speak: { provider: "eleven_labs", model: "eleven_flash_v2_5", voice: "v1" } }), []);
    const p = s.agent.speak.provider as Record<string, unknown>;
    assert.equal(p.type, "deepgram", "ohne Env-Key → Deepgram-Fallback");
    assert.equal(p.model, config.defaultAgent.speakModel);
    assert.equal(s.agent.speak.endpoint, undefined);

    config.elevenlabs.apiKey = "xi-test-key";
    const s2 = buildSettings(agent({ speak: { provider: "eleven_labs", model: "eleven_flash_v2_5" } }), []);
    assert.equal((s2.agent.speak.provider as Record<string, unknown>).type, "deepgram", "ohne Voice-ID → Fallback");
  } finally {
    config.elevenlabs.apiKey = prevKey;
  }
});
