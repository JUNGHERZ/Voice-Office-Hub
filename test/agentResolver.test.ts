import "./helpers/env.js"; // MUSS erster Import bleiben (ENV-Pinning vor config-Load)

import assert from "node:assert/strict";
import { test } from "node:test";

import { config } from "../src/config.js";
import { defaultAgent, fromDoc, resolveAgent } from "../src/ari/agentResolver.js";

// resolveAgent(undefined) nutzt keinen DB-Zugriff → reiner Default-Agent-Pfad.
test("resolveAgent: ohne DDI → Default-Agent aus Config", async () => {
  const a = await resolveAgent(undefined);
  assert.equal(a.name, "default");
  assert.equal(a.mode, "agent");
  assert.equal(a.voiceProvider, "deepgram");
  assert.equal(a.prompt, config.defaultAgent.prompt);
  assert.equal(a.greeting, config.defaultAgent.greeting);
  assert.equal(a.listen.model, config.defaultAgent.listenModel);
  assert.equal(a.speak.model, config.defaultAgent.speakModel);
  assert.equal(a.think.source, config.llm.provider);
  assert.ok(a.tools.includes("transfer_call"));
  assert.ok(a.tools.includes("end_call"));
  assert.equal(a.summary.enabled, config.summary.enabled);
  assert.equal(a.summary.prompt, config.summary.prompt);
  assert.equal(a.summary.model, config.summary.model);
  assert.deepEqual(a.ambience, { enabled: false, preset: "office", volume: 0.25 });
  // Filler und Stille-Ansagen sind Opt-in: der Default-Agent bleibt in beidem stumm.
  assert.deepEqual(a.fillers, {
    enabled: false,
    delayMs: config.native.fillerDelayMs,
    phrases: [],
  });
  assert.deepEqual(a.idlePrompts, {
    enabled: false,
    timeoutMs: config.idle.timeoutMs,
    maxPrompts: 2,
    phrases: [],
    hangupAfter: false,
  });
});

// ── contentLanguage / callerMemory (0.7.0) ───────────────────────────────────

test("contentLanguage: Default-Agent und leeres Doc fallen auf die Config zurück", () => {
  assert.equal(defaultAgent().contentLanguage, config.defaultAgent.contentLanguage);
  assert.equal(fromDoc({ _id: "x", name: "a" }).contentLanguage, config.defaultAgent.contentLanguage);
});

test("contentLanguage: gespeicherter Wert gewinnt", () => {
  assert.equal(fromDoc({ _id: "x", name: "a", contentLanguage: "en" }).contentLanguage, "en");
});

test("callerMemory: Default aus, gespeicherter Wert wird übernommen", () => {
  assert.equal(defaultAgent().callerMemory.language, false);
  assert.equal(fromDoc({ _id: "x", name: "a" }).callerMemory.language, false);
  assert.equal(
    fromDoc({ _id: "x", name: "a", callerMemory: { language: true } }).callerMemory.language,
    true,
  );
});
