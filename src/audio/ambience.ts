/**
 * AmbienceMixer: mischt einen geloopten Hintergrund-Loop mit einstellbarem Pegel
 * auf 20-ms-Frames. Rein und ohne I/O — der Playout-Takt der MediaSession ruft
 * `mix()` pro Frame auf (TTS-Frame oder null = reine Ambience in Sprechpausen).
 */
import { config } from "../config.js";
import type { ResolvedAmbience } from "../types.js";
import { logger } from "../util/logger.js";
import { getAmbienceLoop } from "./ambiencePresets.js";

const log = logger.child({ mod: "ambience" });

function frameBytesFromConfig(): number {
  return (config.audio.sampleRate * 2 * 20) / 1000;
}

export class AmbienceMixer {
  private offset = 0; // Sample-Index im Loop

  constructor(
    private readonly loop: Buffer, // slin 16-bit LE mono; Länge gerade und >= frameBytes
    private readonly gain: number, // 0..1 linear
    private readonly frameBytes = frameBytesFromConfig(),
  ) {}

  /** Liefert frame+Ambience (bzw. reine Ambience bei null). Nie in-place — Eingabe bleibt unverändert. */
  mix(frame: Buffer | null): Buffer {
    const bytes = frame ? frame.length : this.frameBytes;
    const samples = bytes >> 1;
    const out = Buffer.alloc(bytes);
    const loopSamples = this.loop.length >> 1;
    for (let i = 0; i < samples; i++) {
      const dry = frame ? frame.readInt16LE(i * 2) : 0;
      const amb = this.loop.readInt16LE(((this.offset + i) % loopSamples) * 2);
      let v = dry + Math.round(amb * this.gain);
      if (v > 32767) v = 32767;
      else if (v < -32768) v = -32768;
      out.writeInt16LE(v, i * 2);
    }
    this.offset = (this.offset + samples) % loopSamples;
    return out;
  }
}

/**
 * Baut den Mixer für einen Anruf. `undefined` = keine Ambience (deaktiviert,
 * Lautstärke 0 oder unbekanntes/kaputtes Preset) — ein Anruf scheitert nie daran.
 */
export function createAmbienceMixer(
  ambience: ResolvedAmbience | undefined,
  callId: string,
): AmbienceMixer | undefined {
  if (!ambience?.enabled) return undefined;
  const gain = Math.min(1, Math.max(0, ambience.volume));
  if (gain <= 0) return undefined;

  const loop = getAmbienceLoop(ambience.preset);
  if (!loop) {
    log.warn("Unbekanntes Ambience-Preset — Anruf läuft ohne Hintergrund", {
      preset: ambience.preset,
      callId,
    });
    return undefined;
  }
  return new AmbienceMixer(loop, gain);
}
