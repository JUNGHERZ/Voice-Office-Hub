/**
 * Sprechuhr (0.12.0) — bildet Abspielzeit auf Textposition ab.
 *
 * Wozu: Fällt der Anrufer dem Agenten ins Wort, schreibt runAssistantTurn den
 * Assistententurn NIE (die Historie entsteht erst nach vollständigem LLM-Stream,
 * der catch kehrt vorher zurück). Das Modell weiß danach nicht einmal, dass es
 * gesprochen hat, und fängt im nächsten Turn gern von vorne an. Die Uhr sagt,
 * wie weit die Sprachausgabe gekommen war — der Rest wird abgeschnitten.
 *
 * Sie sitzt bewusst in der NativeSession und nicht in einem Adapter: Nur die
 * Session kennt die Turn-Grenze, und nur so ist das Verhalten von der Wahl der
 * Sprachausgabe unabhängig. Die Anbieter liefern lediglich unterschiedlich
 * genaue Zuleitungen:
 *
 *   segmentiert  Der Adapter meldet vor jedem Audiostück, zu welchem Text es
 *                gehört (`segment`-Event). Die HTTP-Anbieter können das exakt —
 *                dort IST ein Auftrag ein Satz. Genauigkeit: Satz, innerhalb des
 *                angebrochenen Satzes proportional interpoliert.
 *   flach        Kein Adapter-Signal (Aura: Binärstrom ohne Satzgrenzen). Dann
 *                zählt die Uhr über die Sprechrate — anfangs geschätzt, nach dem
 *                ersten ungestörten Turn an der eigenen Stimme gemessen.
 *
 * Die Regel, die den Entwurf sicher macht: IMMER abrunden, immer auf die vorige
 * Wortgrenze schnappen. Zu wenig zu behaupten kostet eine kleine Wiederholung;
 * zu viel zu behaupten hiesse, die Historie führt Sätze, die nie jemand gehört
 * hat — und das wäre schlechter als das heutige Loch.
 */

/** Startwert der Sprechrate. Dieselbe Grössenordnung wie die Filler-Abschätzung. */
const DEFAULT_CHARS_PER_SECOND = 14;

/** Plausibilitätsfenster für gemessene Raten — schützt vor Ausreissern. */
const MIN_CHARS_PER_SECOND = 6;
const MAX_CHARS_PER_SECOND = 30;

/** Unter dieser Audiodauer ist eine Messung zu verrauscht, um die Rate zu ändern. */
const CALIBRATION_MIN_MS = 800;

export interface SpokenSlice {
  /** Was der Anrufer tatsächlich gehört hat, abgerundet auf die letzte Wortgrenze. */
  text: string;
  /** true = es wurde nichts abgeschnitten (alles Angesagte ist auch erklungen). */
  complete: boolean;
}

interface Segment {
  text: string;
  ms: number;
}

/**
 * Schneidet `text` vor Position `n` an der letzten Wortgrenze ab. Ein halbes Wort
 * ist keine Aussage — lieber gar nichts zurückgeben als „Kontosta".
 */
export function cutAtWord(text: string, n: number): string {
  if (n <= 0) return "";
  if (n >= text.length) return text;
  const cut = text.lastIndexOf(" ", n);
  if (cut <= 0) return "";
  // Ein hängendes Komma oder ein Gedankenstrich vor den drei Punkten liest sich falsch.
  return text.slice(0, cut).replace(/[\s,;:–—-]+$/u, "");
}

export class SpeechClock {
  /** Vom Adapter gemeldete Stücke — nur im segmentierten Modus gefüllt. */
  private segments: Segment[] = [];
  /** Was in die Synthese ging, in Reihenfolge. Auch Text, dessen Audio nie kam. */
  private queuedParts: string[] = [];
  private totalMs = 0;
  private segmented = false;
  private charsPerSecond: number;
  /** Anzahl bisheriger Messungen — gewichtet den gleitenden Mittelwert. */
  private measurements = 0;

  constructor(speed = 1) {
    const factor = Number.isFinite(speed) && speed > 0 ? speed : 1;
    this.charsPerSecond = DEFAULT_CHARS_PER_SECOND * factor;
  }

  /**
   * Neuer Turn. Die gemessene Sprechrate überlebt bewusst — sie gehört zur
   * Stimme, nicht zum Turn, und ist nach dem Greeting meist schon belastbar.
   */
  reset(): void {
    this.segments = [];
    this.queuedParts = [];
    this.totalMs = 0;
    this.segmented = false;
  }

  /** Text ging in die Synthese (aus speak() — der einen Stelle, an der das passiert). */
  queued(text: string): void {
    if (text) this.queuedParts.push(text);
  }

  /** Adapter: ab jetzt gehört das Audio zu diesem Text. Schaltet den genauen Modus ein. */
  segment(text: string): void {
    this.segmented = true;
    this.segments.push({ text, ms: 0 });
  }

  /** Audio wurde an die Medienschicht weitergereicht. */
  audio(ms: number): void {
    if (!(ms > 0)) return;
    this.totalMs += ms;
    const head = this.segments[this.segments.length - 1];
    if (head) head.ms += ms;
  }

  /** Gesamtes bisher ausgegebenes Audio dieses Turns. */
  emittedMs(): number {
    return this.totalMs;
  }

  /**
   * Turn ohne Barge-in zu Ende gesprochen → die tatsächliche Sprechrate dieser
   * Stimme messen. Das ist der Grund, warum auch der flache Modus (Aura) nach
   * dem ersten ungestörten Turn brauchbar wird: Das Greeting kalibriert ihn.
   */
  calibrate(): void {
    if (this.totalMs < CALIBRATION_MIN_MS) return;
    const chars = this.queuedParts.join(" ").length;
    if (!chars) return;
    const measured = chars / (this.totalMs / 1000);
    if (measured < MIN_CHARS_PER_SECOND || measured > MAX_CHARS_PER_SECOND) return;
    // Gleitender Mittelwert; die erste Messung verdrängt den Schätzwert ganz.
    this.measurements += 1;
    const w = 1 / this.measurements;
    this.charsPerSecond =
      this.measurements === 1 ? measured : this.charsPerSecond * (1 - w) + measured * w;
  }

  /** Für Tests und Diagnose: die aktuell angenommene Sprechrate. */
  rate(): number {
    return this.charsPerSecond;
  }

  /**
   * Was bei `playedMs` abgespielter Zeit tatsächlich erklungen war.
   * Die Zeit kommt vom Aufrufer als `emittedMs() - unplayedMs` — beides bezieht
   * sich auf denselben Turn, ein absoluter Zeitbegriff ist nicht nötig.
   */
  spokenAt(playedMs: number): SpokenSlice {
    const played = Math.max(0, Math.min(playedMs, this.totalMs));
    if (this.totalMs <= 0 || played <= 0) {
      return { text: "", complete: this.queuedParts.length === 0 };
    }
    return this.segmented ? this.sliceSegments(played) : this.sliceFlat(played);
  }

  private sliceSegments(played: number): SpokenSlice {
    const parts: string[] = [];
    let acc = 0;
    for (const seg of this.segments) {
      if (seg.ms <= 0) continue;
      if (played >= acc + seg.ms) {
        parts.push(seg.text);
        acc += seg.ms;
        continue;
      }
      const head = cutAtWord(seg.text, Math.floor(((played - acc) / seg.ms) * seg.text.length));
      if (head) parts.push(head);
      return { text: parts.join(" "), complete: false };
    }
    // Alle erklungenen Segmente sind durch — offen bleibt, ob noch Text wartete,
    // dessen Audio nie kam (Barge-in während der Synthese des nächsten Satzes).
    return { text: parts.join(" "), complete: this.segments.length >= this.queuedParts.length };
  }

  private sliceFlat(played: number): SpokenSlice {
    const flat = this.queuedParts.join(" ");
    if (!flat) return { text: "", complete: true };
    const chars = Math.floor((played / 1000) * this.charsPerSecond);
    if (chars >= flat.length) return { text: flat, complete: true };
    return { text: cutAtWord(flat, chars), complete: false };
  }
}
