/**
 * Satzgrenzen-Chunker für den LLM→TTS-Overlap: sammelt Text-Deltas und liefert
 * vollständige Sätze, sobald sie "reif" sind — so beginnt die Sprachausgabe,
 * während das LLM noch schreibt. Rein und ohne Zustand außerhalb der Instanz.
 */

/** Kurzformen, nach deren Punkt NICHT getrennt werden darf (dt. Telefonie-Texte). */
const ABBREVIATIONS = new Set([
  "dr", "prof", "nr", "str", "ca", "bzw", "ggf", "evtl", "inkl", "exkl",
  "min", "max", "tel", "abs", "art", "vgl", "usw", "etc",
]);

export interface SentenceChunker {
  /** Delta anhängen; liefert alle jetzt vollständigen Sätze (ggf. leer). */
  push(delta: string): string[];
  /** Rest am Stream-Ende (oder null, wenn nichts aussteht). */
  flush(): string | null;
}

export function createSentenceChunker(minChars: number): SentenceChunker {
  let buf = "";

  /** Darf an Position `i` (Satzzeichen) getrennt werden? */
  const isBoundary = (i: number): boolean => {
    const ch = buf[i];
    if (ch !== "." && ch !== "!" && ch !== "?" && ch !== "…") return false;
    const next = buf[i + 1];
    if (next !== undefined && !/\s/.test(next)) return false; // "1.5", "z.B" mitten im Wort
    if (ch === ".") {
      // Wort vor dem Punkt ansehen: Ziffern ("1."), Einzelbuchstaben ("z. B.", Initialen)
      // und bekannte Kurzformen sind keine Satzenden.
      const before = buf.slice(0, i);
      const word = before.match(/([A-Za-zÄÖÜäöüß0-9]+)$/)?.[1] ?? "";
      if (/^\d+$/.test(word)) return false;
      if (word.length <= 1) return false;
      if (ABBREVIATIONS.has(word.toLowerCase())) return false;
    }
    return true;
  };

  return {
    push(delta: string): string[] {
      buf += delta;
      const out: string[] = [];
      let start = 0;
      for (let i = 0; i < buf.length; i++) {
        if (!isBoundary(i)) continue;
        const candidate = buf.slice(start, i + 1).trim();
        if (candidate.length >= minChars) {
          out.push(candidate);
          start = i + 1;
        }
        // Zu kurz: Grenze überspringen — der Mini-Satz wandert in den nächsten Chunk.
      }
      buf = buf.slice(start);
      return out;
    },
    flush(): string | null {
      const rest = buf.trim();
      buf = "";
      return rest.length ? rest : null;
    },
  };
}
