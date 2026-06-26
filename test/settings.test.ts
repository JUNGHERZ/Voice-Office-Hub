import assert from "node:assert/strict";
import { test } from "node:test";

import { config } from "../src/config.js";
import { buildSettings } from "../src/deepgram/settings.js";
import type { ResolvedAgent } from "../src/types.js";

function agent(overrides: Partial<ResolvedAgent> = {}): ResolvedAgent {
  return {
    name: "test",
    mode: "agent",
    greeting: "Hallo",
    prompt: "Du bist ein Assistent.",
    listen: { model: "nova-3", language_hints: ["de", "en"], keyterms: ["Loupz"], smart_format: true },
    think: { source: "requesty", model: "openai/gpt-4o", temperature: 0.5 },
    speak: { provider: "deepgram", model: "aura-2-thalia-en" },
    tools: [],
    summary: { enabled: false, prompt: "" },
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
  assert.equal(s.agent.language, "multi");
  assert.equal(s.agent.greeting, "Hallo");
  assert.deepEqual(s.tags, ["support"]);
  assert.equal(s.mip_opt_out, false);
});

test("buildSettings: listen-Optionen werden übernommen", () => {
  const s = buildSettings(agent(), []);
  const p = s.agent.listen.provider as Record<string, unknown>;
  assert.equal(p.model, "nova-3");
  assert.deepEqual(p.language_hints, ["de", "en"]);
  assert.deepEqual(p.keyterms, ["Loupz"]);
  assert.equal(p.smart_format, true);
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

test("buildSettings: Functions werden eingebettet", () => {
  const fns = [{ name: "lookup_customer", description: "d", parameters: { type: "object" } }];
  const s = buildSettings(agent(), fns);
  assert.deepEqual(s.agent.think.functions, fns);
});

test("buildSettings: speak-Provider (deepgram) nutzt model", () => {
  const s = buildSettings(agent(), []);
  const p = s.agent.speak.provider as Record<string, unknown>;
  assert.equal(p.type, "deepgram");
  assert.equal(p.model, "aura-2-thalia-en");
});
