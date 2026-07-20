import "./helpers/env.js"; // MUSS erster Import bleiben (ENV-Pinning vor config-Load)

import assert from "node:assert/strict";
import { test } from "node:test";

import { AgentSession } from "../src/deepgram/agentSession.js";
import { createVoiceAgentSession } from "../src/voice/factory.js";
import { testAgent } from "./helpers/fakes.js";

test("Factory: deepgram → AgentSession (Konstruktion inert, kein Netzwerk)", () => {
  const session = createVoiceAgentSession(testAgent(), { callId: "call-1", functions: [] });
  assert.ok(session instanceof AgentSession);
  session.close(); // ohne start() ein No-op — darf nicht werfen
});

test("Factory: nicht implementierter Provider wirft sauber", () => {
  assert.throws(
    () => createVoiceAgentSession(testAgent({ voiceProvider: "elevenlabs" }), { callId: "call-1", functions: [] }),
    /noch nicht implementiert/,
  );
});
