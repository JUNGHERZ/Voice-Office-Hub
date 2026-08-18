import "./helpers/env.js"; // MUSS erster Import bleiben (ENV-Pinning vor config-Load)

import assert from "node:assert/strict";
import { test } from "node:test";

import { Agent } from "../src/db/models/Agent.js";
import {
  findTtsProvider,
  providersForPath,
  IMPLEMENTED_TTS_PROVIDER_IDS,
  TTS_PROVIDERS,
  TTS_PROVIDER_IDS,
} from "../src/tts/catalog.js";

// 1 ─ Katalog und Mongoose-Enum dürfen nicht auseinanderlaufen.
test("Katalog: speak.provider-Enum stammt aus dem Manifest", () => {
  const enumValues = Agent.schema.path("speak").schema.path("provider").options.enum as string[];
  assert.deepEqual([...enumValues].sort(), [...IMPLEMENTED_TTS_PROVIDER_IDS].sort());
  // Nicht implementierte Provider dürfen NICHT speicherbar sein.
  assert.ok(!enumValues.includes("fish_audio"));
});

// 2 ─ Jeder gelistete Provider ist vollständig beschrieben.
test("Katalog: Einträge sind vollständig und konsistent", () => {
  assert.equal(TTS_PROVIDERS.length, TTS_PROVIDER_IDS.length);
  for (const p of TTS_PROVIDERS) {
    assert.ok(p.label.length, `${p.id}: Label fehlt`);
    assert.ok(p.paths.length, `${p.id}: kein Pfad`);
    assert.ok(p.models.length, `${p.id}: keine Modelle`);
    assert.ok(
      p.models.some((m) => m.id === p.defaultModel),
      `${p.id}: defaultModel "${p.defaultModel}" steht nicht in der Modellliste`,
    );
    assert.ok(p.residencyNote.length > 20, `${p.id}: Residency-Hinweis fehlt`);
    assert.ok(p.costPer1kChars > 0, `${p.id}: Kostenangabe fehlt`);
    assert.ok(p.envKey.length, `${p.id}: envKey fehlt`);
    // Modell-gebundene Stimmen müssen auf existierende Modelle zeigen.
    for (const v of p.voices) {
      for (const m of v.models ?? []) {
        assert.ok(p.models.some((e) => e.id === m), `${p.id}/${v.id}: unbekanntes Modell ${m}`);
      }
    }
    // Ohne Auswahlliste MUSS Freitext möglich sein, sonst wäre nichts eingebbar.
    if (!p.voices.length && !p.modelFreeText) assert.ok(p.models.length > 0);
  }
});

// 3 ─ Speechify fährt auf 3.0, weil nur dieses Modell Deutsch kann.
test("Katalog: Speechify hat simba-3.0 als Default (Deutsch)", () => {
  const sp = findTtsProvider("speechify");
  assert.equal(sp?.defaultModel, "simba-3.0");
  assert.ok(sp?.models.find((m) => m.id === "simba-3.0")?.languages.includes("de"));
  assert.ok(!sp?.models.find((m) => m.id === "simba-3.2")?.languages.includes("de"));
});

// 4 ─ Pfad-Filter: die Voice-Agent-API reicht nur eigene Stimmen + ElevenLabs durch.
test("Katalog: providersForPath trennt native und Deepgram-Pfad", () => {
  const va = providersForPath("deepgram").map((p) => p.id);
  assert.deepEqual(va.sort(), ["deepgram", "eleven_labs"]);
  assert.ok(!va.includes("mistral"), "Mistral läuft nur in der nativen Kaskade");

  const native = providersForPath("native").map((p) => p.id);
  assert.ok(native.includes("mistral"));
  assert.ok(!native.includes("fish_audio"), "nicht implementierte Provider tauchen nicht auf");
});

// 5 ─ DSGVO-Einstufung ist gepflegt (Grundlage für Badge und Doku).
test("Katalog: Residency-Einstufung je Provider", () => {
  assert.equal(findTtsProvider("mistral")?.residency, "eu");
  assert.equal(findTtsProvider("deepgram")?.residency, "eu-optional");
  // EU-Data-Residency ist verfügbar, aber nur im Enterprise-Tarif und nur, wenn
  // ELEVENLABS_BASE_URL gesetzt ist — deshalb "eu-optional" wie bei Deepgram.
  assert.equal(findTtsProvider("eleven_labs")?.residency, "eu-optional");
  assert.equal(findTtsProvider("speechify")?.residency, "us");
  assert.equal(findTtsProvider("fish_audio")?.residency, "third-country");
  // Drittland muss ausdrücklich freigeschaltet werden.
  assert.ok(findTtsProvider("fish_audio")?.optInEnv);
});
