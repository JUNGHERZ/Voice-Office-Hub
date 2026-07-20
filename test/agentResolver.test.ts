import assert from "node:assert/strict";
import { test } from "node:test";

import { config } from "../src/config.js";
import { resolveAgent } from "../src/ari/agentResolver.js";

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
});
