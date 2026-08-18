import "./helpers/env.js"; // MUSS erster Import bleiben (ENV-Pinning vor config-Load)

import assert from "node:assert/strict";
import { test } from "node:test";

import { createResampler, supportsResample } from "../src/audio/resample.js";

/** Sinus als linear16-PCM (mono, 16-bit LE). */
function sine(freqHz: number, sampleRate: number, samples: number, amp = 12000): Buffer {
  const buf = Buffer.alloc(samples * 2);
  for (let i = 0; i < samples; i++) {
    buf.writeInt16LE(Math.round(amp * Math.sin((2 * Math.PI * freqHz * i) / sampleRate)), i * 2);
  }
  return buf;
}

/** RMS über den eingeschwungenen Teil (Filter-Vorlauf am Anfang überspringen). */
function rms(pcm: Buffer, skip = 200): number {
  const n = pcm.length / 2;
  if (n <= skip) return 0;
  let sum = 0;
  for (let i = skip; i < n; i++) {
    const v = pcm.readInt16LE(i * 2);
    sum += v * v;
  }
  return Math.sqrt(sum / (n - skip));
}

// 1 ─ Unterstützte Ratenpaare: 24→8 und 24→16 ja, 44,1→8 (L=441) nein.
test("supportsResample: erlaubte Paare", () => {
  assert.equal(supportsResample(8000, 8000), true);
  assert.equal(supportsResample(24000, 8000), true);
  assert.equal(supportsResample(24000, 16000), true);
  assert.equal(supportsResample(44100, 8000), false);
  assert.equal(supportsResample(0, 8000), false);
});

// 2 ─ Gleiche Rate = Durchreicher (identischer Buffer, kein Zustand).
test("createResampler: gleiche Rate reicht unverändert durch", () => {
  const r = createResampler(8000, 8000);
  const input = sine(1000, 8000, 400);
  assert.deepEqual(r.push(input), input);
});

// 3 ─ Längenverhältnis 24→8 kHz ist exakt 3:1 (über mehrere Chunks hinweg stabil).
test("Resampler: Längenverhältnis 3:1 über Chunk-Grenzen", () => {
  const r = createResampler(24000, 8000);
  let outSamples = 0;
  for (let i = 0; i < 3; i++) outSamples += r.push(sine(1000, 24000, 8000)).length / 2;
  assert.ok(Math.abs(outSamples - 8000) <= 2, `erwartet ~8000 Ausgabesamples, waren ${outSamples}`);
});

// 4 ─ DC-Verstärkung ≈ 1: ein konstanter Pegel darf weder wachsen noch schrumpfen.
test("Resampler: DC-Verstärkung bleibt bei 1", () => {
  const r = createResampler(24000, 8000);
  const flat = Buffer.alloc(24000 * 2);
  for (let i = 0; i < 24000; i++) flat.writeInt16LE(8000, i * 2);
  const out = r.push(flat);
  const tail = out.readInt16LE(out.length - 2);
  assert.ok(Math.abs(tail - 8000) <= 40, `DC-Pegel ${tail} statt ~8000`);
});

// 5 ─ Nutzsignal im Sprachband übersteht das Resampling nahezu unverändert.
test("Resampler: 1-kHz-Ton bleibt erhalten", () => {
  const r = createResampler(24000, 8000);
  const out = r.push(sine(1000, 24000, 24000));
  const ratio = rms(out) / (12000 / Math.SQRT2);
  assert.ok(ratio > 0.9 && ratio < 1.1, `1 kHz sollte durchlaufen, Pegelverhältnis ${ratio.toFixed(3)}`);
});

// 6 ─ DER eigentliche Aliasing-Nachweis: 6 kHz liegt über der Ziel-Nyquistfrequenz
//     und würde bei nackter Dezimation als 2-kHz-Sirren im Sprachband landen.
test("Resampler: 6 kHz wird um mindestens 30 dB gedämpft (kein Aliasing)", () => {
  const r = createResampler(24000, 8000);
  const out = r.push(sine(6000, 24000, 24000));
  const ratio = rms(out) / (12000 / Math.SQRT2);
  const dB = 20 * Math.log10(Math.max(ratio, 1e-9));
  assert.ok(dB <= -30, `6 kHz nur um ${dB.toFixed(1)} dB gedämpft — Aliasing würde hörbar`);
});

// 7 ─ Chunk-Grenzen dürfen nichts verändern, auch nicht mitten im 16-Bit-Wort.
test("Resampler: byteweises Einspeisen ergibt dasselbe wie ein Stück", () => {
  const input = sine(1200, 24000, 3000);

  const whole = createResampler(24000, 8000).push(input);

  const chunked = createResampler(24000, 8000);
  const parts: Buffer[] = [];
  // Ungerade Schrittweite ⇒ jeder zweite Chunk endet mitten in einem Sample.
  for (let i = 0; i < input.length; i += 7) parts.push(chunked.push(input.subarray(i, i + 7)));

  assert.deepEqual(Buffer.concat(parts), whole);
});

// 8 ─ reset() (Barge-in) verwirft den Filterzustand vollständig.
test("Resampler: reset() stellt den Ausgangszustand her", () => {
  const r = createResampler(24000, 8000);
  const input = sine(1200, 24000, 3000);
  const first = r.push(input);
  r.reset();
  const second = r.push(input);
  assert.deepEqual(second, first);
});

// 9 ─ 24→16 kHz nutzt L=2 (Polyphase mit echter Interpolation), Verhältnis 2:3.
test("Resampler: 24→16 kHz liefert zwei Drittel der Samples", () => {
  const r = createResampler(24000, 16000);
  const out = r.push(sine(1000, 24000, 24000));
  assert.ok(Math.abs(out.length / 2 - 16000) <= 2, `erwartet ~16000, waren ${out.length / 2}`);
  const ratio = rms(out) / (12000 / Math.SQRT2);
  assert.ok(ratio > 0.9 && ratio < 1.1, `1 kHz Pegelverhältnis ${ratio.toFixed(3)}`);
});
