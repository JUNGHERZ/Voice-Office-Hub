/**
 * Gesprächsführung (0.13.0) — entscheidet, ob auf ein gemeldetes Turn-Ende
 * geantwortet oder noch gewartet wird.
 *
 * Reines Modul: keine Zeit außer der übergebenen, kein I/O, kein Zustand über den
 * Aufruf hinaus. Damit ist die Regel gegen aufgezeichnete echte Turns prüfbar
 * (test/fixtures/fluxTurnTrace.json) — dieselbe Bauart wie die Sprechuhr.
 *
 * WAS DIE MESSUNG ERGEBEN HAT (Anruf vom 26.08.2026, 458 Update-Ereignisse):
 *
 *  1. `end_of_turn_confidence` ist KEINE steigende Kurve, sondern spitzenförmig.
 *     Sie misst „wäre HIER ein plausibler Schlusspunkt", ausgewertet je Token, und
 *     fällt mitten im Wort auf nahe null zurück. Ein Turn sah so aus:
 *       0.553 „Yeah." → 0.008 → 0.648 „…geholfen" → 0.008 → 0.761 „…Vielen Dank."
 *
 *  2. Flux beendet den Turn überwiegend über den STILLE-TIMEOUT, nicht über die
 *     Konfidenzschwelle: Zwei Turns endeten bei 0.048 bzw. 0.159, also weit unter
 *     dem Vorgabewert 0.7. Der Agent antwortet also, weil der Anrufer PAUSIERT hat,
 *     nicht weil er fertig war — genau die Beobachtung, die diesen Block ausgelöst hat.
 *
 *  3. Deshalb ist das SATZENDZEICHEN das primäre Signal und die Konfidenz nur der
 *     Stichentscheid. Umgekehrt trennt es nicht: Bei Schwelle 0.5 würde eine reine
 *     Konfidenzregel eine vollständige Frage („Wie kann ich … Update machen?", 0.048)
 *     fälschlich zurückhalten.
 *
 * Grenze der Stichprobe: ein Anruf, ein Sprecher, neun Turns. Dass die Regel dort
 * sauber trennt, ist kein starker Beleg — und sie hängt daran, dass `smart_format`
 * die Satzzeichen überhaupt setzt. Ein zweiter Messanruf soll sie widerlegen können.
 */

/** Warum so entschieden wurde — fürs Log und für die Auswertung späterer Anrufe. */
export type TurnReason =
  | "terminal-punctuation"
  | "confident-stop"
  | "unfinished"
  | "already-held"
  | "nothing-said";

export type TurnVerdict =
  | { action: "answer"; reason: TurnReason }
  | { action: "hold"; reason: TurnReason; maxWaitMs: number };

export interface TurnEndSignal {
  /** Finales Transkript des Turns, wie Flux es beim EndOfTurn meldet. */
  transcript: string;
  /** Konfidenz des letzten Update MIT Text vor dem Turn-Ende (0–1). */
  confidence: number;
  /** Wurde dieser Turn schon einmal zurückgehalten? Dann wird jetzt geantwortet. */
  heldBefore?: boolean;
}

export interface HoldOffOptions {
  /**
   * Ab dieser Konfidenz gilt ein Halt als beabsichtigt, auch ohne Satzzeichen.
   * 0.5 liegt in der Messung zwischen den beiden unfertigen Turns (0.159 / 0.410)
   * und dem niedrigsten vollständigen MIT Satzzeichen — die Schwelle greift also
   * nur dort, wo das Satzzeichen fehlt.
   */
  confidentStop: number;
  /**
   * Wie lange höchstens gewartet wird, bevor trotzdem geantwortet wird.
   * NICHT gemessen: Der Agent hat in der Messung nie gewartet, es gibt also keine
   * Zahl dafür, wie schnell ein Anrufer weiterspricht. 700 ms ist die Größenordnung
   * einer natürlichen Pause zwischen zwei Teilsätzen und gehört nachgemessen,
   * sobald das Warten läuft.
   */
  maxWaitMs: number;
}

export const DEFAULT_HOLD_OFF: HoldOffOptions = {
  confidentStop: 0.5,
  maxWaitMs: 700,
};

/**
 * Endet der Text auf einem Satzschlusszeichen? Schließende Anführungszeichen und
 * Klammern dahinter sind erlaubt (»… Vielen Dank.«), Auslassungspunkte zählen NICHT
 * als Abschluss — sie stehen im Deutschen gerade für das Abbrechen.
 */
export function endsSentence(text: string): boolean {
  const t = text.trim();
  if (!t) return false;
  if (/(\.\.\.|…)["'»«)\]]*$/u.test(t)) return false;
  return /[.!?]["'»«)\]]*$/u.test(t);
}

/**
 * Die eine Entscheidung. Reihenfolge ist tragend: Das Satzzeichen schlägt die
 * Konfidenz, nicht umgekehrt (siehe Kopfkommentar, Punkt 3).
 */
export function decideTurnEnd(
  sig: TurnEndSignal,
  opts: HoldOffOptions = DEFAULT_HOLD_OFF,
): TurnVerdict {
  if (!sig.transcript.trim()) return { action: "answer", reason: "nothing-said" };
  // Einmal gewartet reicht. Sonst hinge der Anrufer in einer Warteschleife fest,
  // wenn er den Satz gar nicht zu Ende führen will.
  if (sig.heldBefore) return { action: "answer", reason: "already-held" };
  if (endsSentence(sig.transcript)) return { action: "answer", reason: "terminal-punctuation" };
  if (sig.confidence >= opts.confidentStop) return { action: "answer", reason: "confident-stop" };
  return { action: "hold", reason: "unfinished", maxWaitMs: opts.maxWaitMs };
}
