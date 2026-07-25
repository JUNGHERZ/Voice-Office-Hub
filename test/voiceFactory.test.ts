import "./helpers/env.js"; // MUSS erster Import bleiben (ENV-Pinning vor config-Load)

import assert from "node:assert/strict";
import { test } from "node:test";

import { AgentSession } from "../src/deepgram/agentSession.js";
import { NativeSession } from "../src/native/nativeSession.js";
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

test("Factory: native → NativeSession (Konstruktion inert)", () => {
  const session = createVoiceAgentSession(
    testAgent({
      voiceProvider: "native",
      listen: { model: "flux-general-multi", language_hints: ["de"], keyterms: [], smart_format: true },
    }),
    { callId: "call-1", functions: [] },
  );
  assert.ok(session instanceof NativeSession);
  session.close(); // ohne start() ein No-op — darf nicht werfen
});

test("Factory: native + eleven_labs → NativeSession (TTS-Matrix, kein Throw)", () => {
  const session = createVoiceAgentSession(
    testAgent({
      voiceProvider: "native",
      listen: { model: "flux-general-multi", language_hints: ["de"], keyterms: [], smart_format: true },
      speak: { provider: "eleven_labs", model: "eleven_flash_v2_5", voice: "v1" },
    }),
    { callId: "call-1", functions: [] },
  );
  assert.ok(session instanceof NativeSession);
  session.close();
});

test("Factory: native erhält opts.localizer; Deepgram ignoriert ihn", () => {
  const localizer = { resolve: () => "x" };
  const native = createVoiceAgentSession(
    testAgent({
      voiceProvider: "native",
      listen: { model: "flux-general-multi", language_hints: ["de"], keyterms: [], smart_format: true },
    }),
    { callId: "call-1", functions: [], localizer },
  );
  assert.ok(native instanceof NativeSession);
  native.close();

  // Deepgram bekommt den Localizer ebenfalls in den opts, nutzt ihn aber nicht (kein Throw).
  const deepgram = createVoiceAgentSession(testAgent(), { callId: "call-2", functions: [], localizer });
  assert.ok(deepgram instanceof AgentSession);
});
