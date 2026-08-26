import "./helpers/env.js"; // MUSS erster Import bleiben (ENV-Pinning vor config-Load)

import assert from "node:assert/strict";
import { test } from "node:test";

import { config } from "../src/config.js";
import { AgentSession } from "../src/deepgram/agentSession.js";
import { NativeSession } from "../src/native/nativeSession.js";
import { createVoiceAgentSession } from "../src/voice/factory.js";
import { IMPLEMENTED_VOICE_PROVIDERS, VOICE_PROVIDERS } from "../src/voice/types.js";
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

// ── Dritter Pfad: duplex (0.13.0) ───────────────────────────────────────────
const duplexAgent = () =>
  testAgent({
    voiceProvider: "duplex",
    listen: { model: "flux-general-multi", language_hints: ["de"], keyterms: [], smart_format: true },
  });

test("Factory: duplex → NativeSession mit Gesprächsführung (Konstruktion inert)", () => {
  const session = createVoiceAgentSession(duplexAgent(), { callId: "call-duplex", functions: [] });
  assert.ok(session instanceof NativeSession, "gleiche Kaskade, nur ein Halt davor");
  session.close();
});

// Betriebs-Not-Aus: Ein Anruf scheitert nie an der Pfadwahl — er läuft dann auf der
// bewährten Kaskade weiter (gleiche Regel wie beim TTS-Fallback).
test("Factory: NATIVE_DUPLEX_ENABLED=false lässt Duplex-Agenten nativ laufen", () => {
  const before = config.native.duplexEnabled;
  config.native.duplexEnabled = false;
  try {
    const session = createVoiceAgentSession(duplexAgent(), { callId: "call-duplex-off", functions: [] });
    assert.ok(session instanceof NativeSession);
    session.close();
  } finally {
    config.native.duplexEnabled = before;
  }
});

test("duplex ist am Agenten speicherbar (Enum und Implementierungsliste stimmen überein)", () => {
  assert.ok(IMPLEMENTED_VOICE_PROVIDERS.includes("duplex"));
  for (const p of IMPLEMENTED_VOICE_PROVIDERS) assert.ok(VOICE_PROVIDERS.includes(p));
});
