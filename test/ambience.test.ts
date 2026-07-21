import "./helpers/env.js"; // MUSS erster Import bleiben (ENV-Pinning vor config-Load)

import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import { AmbienceMixer, createAmbienceMixer } from "../src/audio/ambience.js";
import { generateAmbience } from "../src/audio/ambienceGenerator.js";
import {
  AMBIENCE_PRESET_IDS,
  getAmbienceLoop,
  listAmbiencePresets,
  resetAmbienceCache,
} from "../src/audio/ambiencePresets.js";
import { Agent } from "../src/db/models/Agent.js";

/** Int16-Buffer aus Sample-Werten (Testdaten kompakt notieren). */
function pcm(samples: number[]): Buffer {
  const buf = Buffer.alloc(samples.length * 2);
  samples.forEach((v, i) => buf.writeInt16LE(v, i * 2));
  return buf;
}

function samplesOf(buf: Buffer): number[] {
  const out: number[] = [];
  for (let i = 0; i < buf.length; i += 2) out.push(buf.readInt16LE(i));
  return out;
}

function rms(buf: Buffer): number {
  let sum = 0;
  const n = buf.length / 2;
  for (let i = 0; i < buf.length; i += 2) {
    const v = buf.readInt16LE(i);
    sum += v * v;
  }
  return Math.sqrt(sum / n);
}

// ── AmbienceMixer ─────────────────────────────────────────────────────────────

// 1 ─ Addition + Gain: TTS-Frame und Loop werden sample-weise mit Pegel gemischt.
test("Mixer: Addition mit Gain", () => {
  const mixer = new AmbienceMixer(pcm([1000, -2000, 3000, 4000]), 0.5, 8);
  const mixed = mixer.mix(pcm([100, 100, 100, 100]));
  assert.deepEqual(samplesOf(mixed), [600, -900, 1600, 2100]);
});

// 2 ─ mix(null) liefert reine Ambience; Offset läuft über Aufrufe weiter.
test("Mixer: mix(null) = reine Ambience, Offset schreitet fort", () => {
  const mixer = new AmbienceMixer(pcm([10, 20, 30, 40, 50, 60, 70, 80]), 1, 8);
  assert.deepEqual(samplesOf(mixer.mix(null)), [10, 20, 30, 40]);
  assert.deepEqual(samplesOf(mixer.mix(null)), [50, 60, 70, 80]);
  assert.deepEqual(samplesOf(mixer.mix(null)), [10, 20, 30, 40], "Loop beginnt von vorn");
});

// 3 ─ Loop-Wrap mitten im Frame (Loop-Länge kein Frame-Vielfaches).
test("Mixer: Loop-Wrap mitten im Frame", () => {
  // Loop = 6 Samples, Frame = 4 Samples → dritter Aufruf wickelt mitten im Frame um.
  const mixer = new AmbienceMixer(pcm([1, 2, 3, 4, 5, 6]), 1, 8);
  assert.deepEqual(samplesOf(mixer.mix(null)), [1, 2, 3, 4]);
  assert.deepEqual(samplesOf(mixer.mix(null)), [5, 6, 1, 2]);
  assert.deepEqual(samplesOf(mixer.mix(null)), [3, 4, 5, 6]);
});

// 4 ─ Clamping beidseitig; das Eingabe-Frame wird nie mutiert.
test("Mixer: int16-Clamp beidseitig, Eingabe unverändert", () => {
  const mixer = new AmbienceMixer(pcm([30000, -30000]), 1, 4);
  const input = pcm([30000, -30000]);
  const mixed = mixer.mix(input);
  assert.deepEqual(samplesOf(mixed), [32767, -32768]);
  assert.deepEqual(samplesOf(input), [30000, -30000], "Eingabe bleibt unverändert");
});

// ── Presets / Generator ───────────────────────────────────────────────────────

// 5 ─ Alle Presets liefern brauchbare, deterministische Loops.
test("Presets: deterministisch, Frame-Vielfaches, plausible Lautheit", () => {
  resetAmbienceCache();
  for (const id of AMBIENCE_PRESET_IDS) {
    const loop = getAmbienceLoop(id, "");
    assert.ok(loop, `Loop für ${id}`);
    assert.equal(loop.length % 320, 0, `${id}: Vielfaches von 320 Bytes (20-ms-Frames)`);
    const loudness = rms(loop);
    assert.ok(loudness > 800 && loudness < 3000, `${id}: RMS im Zielband (ist ${Math.round(loudness)})`);
  }
  // Determinismus: zwei frische Generator-Läufe sind identisch.
  assert.deepEqual(generateAmbience("office", 8000), generateAmbience("office", 8000));
  // Cache: gleicher Aufruf liefert dieselbe Referenz.
  assert.equal(getAmbienceLoop("office", ""), getAmbienceLoop("office", ""));
  assert.equal(getAmbienceLoop("gibtsnicht", ""), undefined);
  assert.ok(listAmbiencePresets().length >= 3);
  assert.ok(listAmbiencePresets().every((p) => p.id && p.label));
});

// 6 ─ AMBIENCE_DIR-Override: gültige Datei gewinnt, kaputte fällt auf den Generator zurück.
test("Presets: Override-Verzeichnis mit Validierung", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "ambience-"));
  const custom = pcm(new Array(320).fill(1234)); // 640 Bytes = 2 Frames à 8 kHz
  writeFileSync(path.join(dir, "office.raw"), custom);
  writeFileSync(path.join(dir, "room.raw"), Buffer.alloc(321)); // ungerade Länge → unbrauchbar

  resetAmbienceCache();
  assert.deepEqual(getAmbienceLoop("office", dir), custom, "Override-Datei wird genutzt");
  const roomLoop = getAmbienceLoop("room", dir);
  assert.ok(roomLoop && roomLoop.length > 321, "kaputte Datei → prozeduraler Fallback");
  resetAmbienceCache();
});

// ── createAmbienceMixer (Gatter) ─────────────────────────────────────────────

// 7 ─ Aus/leise/unbekannt → kein Mixer; zu hohe Lautstärke wird geklemmt.
test("createAmbienceMixer: Gatter und Volume-Klemmung", () => {
  resetAmbienceCache();
  assert.equal(createAmbienceMixer(undefined, "c1"), undefined);
  assert.equal(createAmbienceMixer({ enabled: false, preset: "office", volume: 0.5 }, "c1"), undefined);
  assert.equal(createAmbienceMixer({ enabled: true, preset: "office", volume: 0 }, "c1"), undefined);
  assert.equal(createAmbienceMixer({ enabled: true, preset: "nope", volume: 0.5 }, "c1"), undefined);

  const mixer = createAmbienceMixer({ enabled: true, preset: "office", volume: 5 }, "c1");
  assert.ok(mixer, "volume > 1 wird geklemmt statt abgelehnt");
  // Gain 1 (geklemmt): reine Ambience entspricht exakt dem Loop-Anfang.
  const loop = getAmbienceLoop("office", "");
  assert.ok(loop);
  const frame = mixer.mix(null);
  assert.deepEqual([...frame], [...loop.subarray(0, frame.length)]);
});

// ── Agent-Schema ─────────────────────────────────────────────────────────────

// 8 ─ Defaults materialisieren; Enum/Range werden validiert (ohne DB-Verbindung).
test("Agent-Schema: ambience-Defaults und Validierung", () => {
  const ok = new Agent({ name: "a" });
  assert.equal(ok.validateSync(), undefined);
  assert.deepEqual(ok.toObject().ambience, { enabled: false, preset: "office", volume: 0.25 });

  const badPreset = new Agent({ name: "a", ambience: { preset: "disco" } });
  assert.match(String(badPreset.validateSync()?.errors?.["ambience.preset"] ?? ""), /disco/);

  const badVolume = new Agent({ name: "a", ambience: { volume: 1.5 } });
  assert.ok(badVolume.validateSync()?.errors?.["ambience.volume"], "volume > 1 → ValidationError");

  const badSpeak = new Agent({ name: "a", speak: { provider: "acme_tts" } });
  assert.ok(badSpeak.validateSync()?.errors?.["speak.provider"], "unbekannter TTS-Provider → ValidationError");
});
