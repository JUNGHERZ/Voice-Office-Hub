import "./helpers/env.js"; // MUSS erster Import bleiben (ENV-Pinning vor config-Load)

import assert from "node:assert/strict";
import { test } from "node:test";

import { config } from "../src/config.js";
import { buildNativeTts } from "../src/native/ttsFactory.js";
import { AzureTtsStream } from "../src/native/ttsAzure.js";
import { ElevenLabsTtsStream } from "../src/native/ttsElevenLabs.js";
import { MistralTtsStream } from "../src/native/ttsMistral.js";
import { AuraTtsStream } from "../src/native/ttsStream.js";
import { testAgent } from "./helpers/fakes.js";

/** Keys um einen Testlauf herum setzen und sicher zurückgeben. */
function withKeys(keys: { eleven?: string; mistral?: string; azure?: string }, fn: () => void): void {
  const prev = { eleven: config.elevenlabs.apiKey, mistral: config.mistral.apiKey, azure: config.azure.apiKey };
  config.elevenlabs.apiKey = keys.eleven ?? "";
  config.mistral.apiKey = keys.mistral ?? "";
  config.azure.apiKey = keys.azure ?? "";
  try {
    fn();
  } finally {
    config.elevenlabs.apiKey = prev.eleven;
    config.mistral.apiKey = prev.mistral;
    config.azure.apiKey = prev.azure;
  }
}

// 1 ─ Default-Pfad: Aura.
test("ttsFactory: deepgram → AuraTtsStream", () => {
  const tts = buildNativeTts(testAgent(), "call-1");
  assert.ok(tts instanceof AuraTtsStream);
  tts.close();
});

// 2 ─ ElevenLabs braucht Key UND Voice-ID.
test("ttsFactory: eleven_labs mit Key und Voice-ID", () => {
  withKeys({ eleven: "xi-test" }, () => {
    const tts = buildNativeTts(
      testAgent({ speak: { provider: "eleven_labs", model: "eleven_flash_v2_5", voice: "v1" } }),
      "call-2",
    );
    assert.ok(tts instanceof ElevenLabsTtsStream);
    tts.close();
  });
});

// 3 ─ Unvollständige Konfiguration fällt zurück statt zu werfen — ein Anruf
//     scheitert nie an der TTS-Auswahl.
test("ttsFactory: eleven_labs ohne Key/Voice → Aura-Fallback ohne Throw", () => {
  withKeys({}, () => {
    const noKey = buildNativeTts(
      testAgent({ speak: { provider: "eleven_labs", model: "eleven_flash_v2_5", voice: "v1" } }),
      "call-3",
    );
    assert.ok(noKey instanceof AuraTtsStream, "ohne Key → Aura");
    noKey.close();
  });
  withKeys({ eleven: "xi-test" }, () => {
    const noVoice = buildNativeTts(
      testAgent({ speak: { provider: "eleven_labs", model: "eleven_flash_v2_5" } }),
      "call-4",
    );
    assert.ok(noVoice instanceof AuraTtsStream, "ohne Voice-ID → Aura");
    noVoice.close();
  });
});

// 4 ─ Mistral braucht nur den Key; die Stimme ist optional (Modell-Default).
test("ttsFactory: mistral mit Key", () => {
  withKeys({ mistral: "mi-test" }, () => {
    const tts = buildNativeTts(
      testAgent({ speak: { provider: "mistral", model: "voxtral-mini-tts-latest", voice: "de_female" } }),
      "call-5",
    );
    assert.ok(tts instanceof MistralTtsStream);
    tts.close();
  });
});

test("ttsFactory: mistral ohne Key → Aura-Fallback", () => {
  withKeys({}, () => {
    const tts = buildNativeTts(
      testAgent({ speak: { provider: "mistral", model: "voxtral-mini-tts-latest" } }),
      "call-6",
    );
    assert.ok(tts instanceof AuraTtsStream);
    tts.close();
  });
});

// 5 ─ Unbekannter Provider (z. B. Altbestand nach einem Downgrade) → Aura.
test("ttsFactory: unbekannter Provider → Aura-Fallback", () => {
  const tts = buildNativeTts(testAgent({ speak: { provider: "gibt_es_nicht", model: "x" } }), "call-7");
  assert.ok(tts instanceof AuraTtsStream);
  tts.close();
});

// 6 ─ Jeder Builder prüft seinen EIGENEN Modellstring: ein fremdes Modell darf
//     nicht als Aura-Modell durchgereicht werden.
test("ttsFactory: fremdes Modell fällt auf das Default-Aura-Modell zurück", () => {
  const tts = buildNativeTts(
    testAgent({ speak: { provider: "deepgram", model: "voxtral-mini-tts-latest" } }),
    "call-8",
  ) as AuraTtsStream;
  assert.ok(tts.buildUrl().includes(encodeURIComponent(config.defaultAgent.speakModel)));
  tts.close();
});

// 7 ─ Mistral-URL/Body werden aus der Agentenkonfiguration gebaut.
test("ttsFactory: mistral übernimmt Modell und Stimme des Agents", () => {
  withKeys({ mistral: "mi-test" }, () => {
    const tts = buildNativeTts(
      testAgent({ speak: { provider: "mistral", model: "voxtral-mini-tts-latest", voice: "de_male" } }),
      "call-9",
    ) as MistralTtsStream;
    assert.ok(tts.buildUrl().endsWith("/audio/speech"));
    assert.deepEqual(tts.buildBody("Hallo"), {
      model: "voxtral-mini-tts-latest",
      input: "Hallo",
      voice_id: "de_male",
      response_format: "pcm",
      stream: true,
    });
    tts.close();
  });
});

// Derselbe Schalter muss die native Kaskade steuern (0.8.1).
test("ttsFactory: eleven_labs übernimmt die konfigurierte Basis-URL", () => {
  const prevUrl = config.elevenlabs.baseUrl;
  config.elevenlabs.baseUrl = "wss://api.eu.residency.elevenlabs.io/v1";
  try {
    withKeys({ eleven: "xi-test" }, () => {
      const tts = buildNativeTts(
        testAgent({ speak: { provider: "eleven_labs", model: "eleven_flash_v2_5", voice: "v1" } }),
        "call-eu",
      ) as ElevenLabsTtsStream;
      assert.ok(tts.buildUrl().startsWith("wss://api.eu.residency.elevenlabs.io/v1/text-to-speech/v1/stream-input"));
      tts.close();
    });
  } finally {
    config.elevenlabs.baseUrl = prevUrl;
  }
});

// Azure: die Stimme steckt im Modellfeld (wie bei Aura ist der Name die Stimme).
test("ttsFactory: azure mit Key und Stimme", () => {
  withKeys({ azure: "az-test" }, () => {
    const tts = buildNativeTts(
      testAgent({ speak: { provider: "azure", model: "de-DE-KatjaNeural" } }),
      "call-az",
    ) as AzureTtsStream;
    assert.ok(tts instanceof AzureTtsStream);
    assert.ok(tts.buildSsml("Hallo").includes("name='de-DE-KatjaNeural'"));
    tts.close();
  });
});

test("ttsFactory: azure ohne Key → Aura-Fallback", () => {
  withKeys({}, () => {
    const tts = buildNativeTts(testAgent({ speak: { provider: "azure", model: "de-DE-KatjaNeural" } }), "call-az2");
    assert.ok(tts instanceof AuraTtsStream);
    tts.close();
  });
});
