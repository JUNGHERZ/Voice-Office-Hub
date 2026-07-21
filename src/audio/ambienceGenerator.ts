/**
 * Prozedurale Ambience-Presets: deterministisch generierte, nahtlos loopbare
 * Hintergrund-Atmosphären als Raw-PCM (slin, 16-bit LE mono). Bewusst ohne
 * Binär-Assets im Repo — lizenzfrei per Konstruktion und unabhängig von der
 * konfigurierten Sample-Rate (8 kHz heute, 16 kHz später ohne Migration).
 */

export type AmbiencePresetId = "office" | "room" | "rain";

const LOOP_SECONDS = 16;
const CROSSFADE_MS = 250;
/** Ziel-Lautheit des Loops ≈ −27 dBFS — als dezentes Bett hinter der Agent-Stimme. */
const TARGET_RMS = 1500;

/** Deterministischer PRNG (mulberry32) — gleicher Seed ⇒ identischer Loop. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Ein-Pol-Tiefpass: y[i] = a·y[i-1] + (1-a)·x[i], a = e^(−2π·fc/sr). */
function lowpass(x: Float64Array, cutoffHz: number, sampleRate: number): Float64Array {
  const alpha = Math.exp((-2 * Math.PI * cutoffHz) / sampleRate);
  const y = new Float64Array(x.length);
  let prev = 0;
  for (let i = 0; i < x.length; i++) {
    prev = alpha * prev + (1 - alpha) * (x[i] ?? 0);
    y[i] = prev;
  }
  return y;
}

function whiteNoise(rand: () => number, length: number): Float64Array {
  const x = new Float64Array(length);
  for (let i = 0; i < length; i++) x[i] = rand() * 2 - 1;
  return x;
}

/**
 * "Braunes" Rauschen (leaky-integriertes Weißrauschen): Energie liegt fast komplett
 * unten (< ~300 Hz) → klingt nach Raum/Lüftung statt nach Zischeln. Ein-Pol-Tiefpass
 * allein (6 dB/Okt) lässt zu viel Höhenanteil durch — das klang wie "schlechte Leitung".
 */
function brownNoise(rand: () => number, length: number): Float64Array {
  const out = new Float64Array(length);
  let acc = 0;
  for (let i = 0; i < length; i++) {
    acc = acc * 0.985 + (rand() * 2 - 1) * 0.06;
    out[i] = acc;
  }
  return out;
}

function rmsOf(x: Float64Array): number {
  let sum = 0;
  for (let i = 0; i < x.length; i++) {
    const v = x[i] ?? 0;
    sum += v * v;
  }
  return Math.sqrt(sum / x.length);
}

/**
 * Neutraler Raumklang: braunes Rauschen, zusätzlich geglättet, mit sehr langsamer
 * Pegel-Modulation — ein warmes, dunkles "der Raum ist da", kein Zischeln.
 */
function buildRoom(rand: () => number, length: number, sampleRate: number): Float64Array {
  const bed = lowpass(brownNoise(rand, length), 400, sampleRate);
  for (let i = 0; i < length; i++) {
    bed[i] = (bed[i] ?? 0) * (1 + 0.15 * Math.sin((2 * Math.PI * 0.08 * i) / sampleRate));
  }
  return bed;
}

/** Büro: Raumklang-Bett + hauchdünne "Luft" + SELTENE, kurze Tipp-Schübe (Tastatur). */
function buildOffice(rand: () => number, length: number, sampleRate: number): Float64Array {
  const out = buildRoom(rand, length, sampleRate);
  for (let i = 0; i < length; i++) out[i] = (out[i] ?? 0) * 0.9;

  // Nur ein Hauch Luftigkeit — deutlich leiser und dunkler als vorher (kein Leitungs-Rauschen).
  const air = lowpass(whiteNoise(rand, length), 1000, sampleRate);
  for (let i = 0; i < length; i++) out[i] = (out[i] ?? 0) + (air[i] ?? 0) * 0.05;

  // Tipp-Schübe: alle 2,5–7 s ein kurzer Schub aus 2–5 Anschlägen im 130–240-ms-Abstand
  // (dazwischen Ruhe — echtes Tippen ist kein Dauerfeuer). Die Klicks landen erst auf
  // einer eigenen Spur und werden dort weichgezeichnet, damit sie nach gedämpfter
  // Tastatur klingen statt nach Knacksern.
  const bedRms = rmsOf(out);
  const clickTrack = new Float64Array(length);
  let pos = Math.floor(sampleRate * (1.2 + rand() * 2));
  while (pos < length) {
    const clicks = 2 + Math.floor(rand() * 4);
    let clickPos = pos;
    for (let c = 0; c < clicks && clickPos < length; c++) {
      const clickLen = Math.floor(sampleRate * (0.008 + rand() * 0.006));
      // Nach der Weichzeichnung (Tiefpass unten) bleibt ~die Hälfte der Spitze übrig —
      // deshalb hier höher ansetzen, Ziel: dezentes "Tack" ~2–3× über dem Bett.
      const amp = bedRms * (4 + rand() * 2);
      let prevSample = 0;
      for (let n = 0; n < clickLen && clickPos + n < length; n++) {
        const burst = rand() * 2 - 1;
        const highpassed = burst - prevSample; // erste Differenz ≈ Hochpass
        prevSample = burst;
        const idx = clickPos + n;
        clickTrack[idx] = (clickTrack[idx] ?? 0) + highpassed * amp * Math.exp(-n / (clickLen / 3));
      }
      clickPos += Math.floor(sampleRate * (0.13 + rand() * 0.11));
    }
    pos += Math.floor(sampleRate * (2.5 + rand() * 4.5));
  }
  const softClicks = lowpass(clickTrack, 2200, sampleRate);
  for (let i = 0; i < length; i++) out[i] = (out[i] ?? 0) + (softClicks[i] ?? 0);
  return out;
}

/** Regen: dichte Zufalls-Impulse durch Leaky-Integrator + Bandpass, plus Rausch-Bett. */
function buildRain(rand: () => number, length: number, sampleRate: number): Float64Array {
  const impulses = new Float64Array(length);
  const dropsPerSecond = 1000;
  const p = dropsPerSecond / sampleRate;
  for (let i = 0; i < length; i++) {
    if (rand() < p) impulses[i] = (rand() * 2 - 1) * (0.3 + rand() * 0.7);
  }
  const smeared = new Float64Array(length);
  let acc = 0;
  for (let i = 0; i < length; i++) {
    acc = acc * 0.995 + (impulses[i] ?? 0);
    smeared[i] = acc;
  }
  // Bandpass ≈ 1,5–3 kHz als Differenz zweier Tiefpässe.
  const lo = lowpass(smeared, 1500, sampleRate);
  const hi = lowpass(smeared, 3000, sampleRate);
  const out = new Float64Array(length);
  for (let i = 0; i < length; i++) out[i] = (hi[i] ?? 0) - (lo[i] ?? 0);

  const bed = lowpass(whiteNoise(rand, length), 2500, sampleRate);
  for (let i = 0; i < length; i++) out[i] = (out[i] ?? 0) + (bed[i] ?? 0) * 0.3;
  return out;
}

const PRESET_BUILDERS: Record<
  AmbiencePresetId,
  { seed: number; build: (rand: () => number, length: number, sampleRate: number) => Float64Array }
> = {
  office: { seed: 0x0ff1ce, build: buildOffice },
  room: { seed: 0x100, build: buildRoom },
  rain: { seed: 0x4a1, build: buildRain },
};

/**
 * Erzeugt einen nahtlos loopbaren Ambience-Abschnitt (16 s) als slin-Buffer.
 * Nahtlosigkeit über 250-ms-Crossfade: das Loop-Ende fließt in den Anfang über.
 */
export function generateAmbience(preset: AmbiencePresetId, sampleRate: number): Buffer {
  const { seed, build } = PRESET_BUILDERS[preset];
  const rand = mulberry32(seed);
  const loopSamples = LOOP_SECONDS * sampleRate;
  const fadeSamples = Math.floor((CROSSFADE_MS / 1000) * sampleRate);
  const raw = build(rand, loopSamples + fadeSamples, sampleRate);

  const mixed = new Float64Array(loopSamples);
  for (let i = 0; i < loopSamples; i++) {
    if (i < fadeSamples) {
      const t = i / fadeSamples;
      mixed[i] = (raw[loopSamples + i] ?? 0) * (1 - t) + (raw[i] ?? 0) * t;
    } else {
      mixed[i] = raw[i] ?? 0;
    }
  }

  // Auf Ziel-RMS normieren, dann int16 mit Clamp schreiben.
  const gain = TARGET_RMS / Math.max(rmsOf(mixed), 1e-9);
  const out = Buffer.alloc(loopSamples * 2);
  for (let i = 0; i < loopSamples; i++) {
    let v = Math.round((mixed[i] ?? 0) * gain);
    if (v > 32767) v = 32767;
    else if (v < -32768) v = -32768;
    out.writeInt16LE(v, i * 2);
  }
  return out;
}
