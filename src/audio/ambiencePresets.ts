/**
 * Ambience-Preset-Manifest + Loop-Beschaffung. Loops kommen aus dem prozeduralen
 * Generator (Default) oder — falls gesetzt — aus AMBIENCE_DIR (<preset>.raw als
 * slin 16-bit LE mono in AUDIO_SAMPLE_RATE), z. B. für kuratierte CC0-Aufnahmen.
 * Beschaffung ist lazy und prozessweit gecacht (ein Buffer pro Preset, read-only
 * geteilt — jeder Anruf mischt mit eigenem Offset).
 */
import { readFileSync } from "node:fs";
import path from "node:path";

import { config } from "../config.js";
import { logger } from "../util/logger.js";
import { generateAmbience, type AmbiencePresetId } from "./ambienceGenerator.js";

const log = logger.child({ mod: "ambience" });

export interface AmbiencePreset {
  id: AmbiencePresetId;
  /** Deutsches Anzeige-Label für die Admin-UI. */
  label: string;
}

export const AMBIENCE_PRESETS: AmbiencePreset[] = [
  { id: "office", label: "Büroatmosphäre (Raumklang + Tippen)" },
  { id: "room", label: "Neutraler Raumklang" },
  { id: "rain", label: "Regen" },
];

export const AMBIENCE_PRESET_IDS: string[] = AMBIENCE_PRESETS.map((p) => p.id);

export function listAmbiencePresets(): AmbiencePreset[] {
  return AMBIENCE_PRESETS;
}

const cache = new Map<string, Buffer>();

/** Nur für Tests: Cache leeren (z. B. zwischen Override-Dir-Szenarien). */
export function resetAmbienceCache(): void {
  cache.clear();
}

function isKnownPreset(id: string): id is AmbiencePresetId {
  return (AMBIENCE_PRESET_IDS as string[]).includes(id);
}

/** Kleinste sinnvolle Loop-Länge: ein 20-ms-Frame. */
function minLoopBytes(): number {
  return (config.audio.sampleRate * 2 * 20) / 1000;
}

/**
 * Loop-PCM des Presets — Override aus `dir` (<preset>.raw), sonst prozedural.
 * Unbekannte Preset-Id → undefined (Aufrufer entscheidet; ein Anruf scheitert nie daran).
 */
export function getAmbienceLoop(presetId: string, dir = config.audio.ambienceDir): Buffer | undefined {
  if (!isKnownPreset(presetId)) return undefined;

  const cacheKey = `${dir}|${presetId}`;
  const cached = cache.get(cacheKey);
  if (cached) return cached;

  let loop: Buffer | undefined;
  if (dir) {
    const file = path.join(dir, `${presetId}.raw`);
    try {
      const data = readFileSync(file);
      if (data.length >= minLoopBytes() && data.length % 2 === 0) {
        loop = data;
      } else {
        log.warn("Ambience-Override unbrauchbar (zu kurz oder ungerade Länge) — nutze eingebautes Preset", {
          file,
          bytes: data.length,
        });
      }
    } catch {
      // Datei fehlt → normaler Fall, eingebautes Preset nutzen.
    }
  }
  loop ??= generateAmbience(presetId, config.audio.sampleRate);

  cache.set(cacheKey, loop);
  return loop;
}
