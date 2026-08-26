/**
 * Sprachnachführung (0.15.0) — „Detect-then-Lock" nach Deepgrams Empfehlung.
 *
 * Der Sprach-Hinweis startet bei der Textsprache des Agenten (siehe fluxLanguages.ts).
 * Spricht der Anrufer nachweislich eine andere Sprache, wird der Hinweis mitten im
 * Strom nachgezogen — Flux nimmt dafür eine `Configure`-Nachricht entgegen, ohne dass
 * die Verbindung neu aufgebaut werden muss (verifiziert am 26.08.2026 gegen die echte
 * API: `ConfigureSuccess` kam nach 45 ms, und das folgende `TurnInfo` trug bereits
 * `languages_hinted: ["en"]`).
 *
 * Wozu: Ein fester Hinweis ist für einsprachige Agenten richtig, für einen bewusst
 * mehrsprachigen aber falsch — der Demo-Agent „Englischlehrerin" begrüsst auf Deutsch
 * und wechselt dann absichtlich ins Englische. Genau dort soll die Erkennung mitgehen.
 *
 * Die Erkennung kommt von Flux selbst: Jedes `TurnInfo` trägt ein `languages`-Feld.
 * Eine eigene Heuristik wäre schlechter und überflüssig.
 *
 * ZWEI REGELN, die aus dem Fehler entstanden sind, den diese Funktion beheben soll:
 *
 *  1. KURZE TURNS ZÄHLEN NICHT. Genau bei ihnen verhaspelt sich die Erkennung — aus
 *     „Ja, ja" wurde „Yep. Yep.". Würde ausgerechnet so ein Turn die Umschaltung
 *     auslösen, verstärkte sich der Fehler selbst.
 *  2. EINMAL REICHT NICHT. Erst mehrere aufeinanderfolgende Turns derselben fremden
 *     Sprache schalten um. Sonst flattert der Hinweis bei jedem Fremdwort.
 */

import { isFluxLanguage } from "./fluxLanguages.js";

export interface LanguageLockOptions {
  /** Kürzere Turns werden ignoriert — dort ist die Spracherkennung unzuverlässig. */
  minChars: number;
  /** So viele aufeinanderfolgende Turns derselben Sprache schalten um. */
  confirmTurns: number;
}

export const DEFAULT_LANGUAGE_LOCK: LanguageLockOptions = {
  minChars: 25,
  confirmTurns: 2,
};

export class LanguageLock {
  private current: string;
  private candidate?: string;
  private streak = 0;

  /** @param initialHints Der abgeleitete Start-Hinweis; leer = Flux erkennt selbst. */
  constructor(
    initialHints: readonly string[],
    private readonly opts: LanguageLockOptions = DEFAULT_LANGUAGE_LOCK,
  ) {
    this.current = initialHints[0] ?? "";
  }

  /** Aktuell gesetzter Hinweis ("" = keiner). */
  active(): string {
    return this.current;
  }

  /**
   * Einen abgeschlossenen Turn bewerten.
   *
   * @param transcript Finales Transkript des Turns.
   * @param languages  Von Flux erkannte Sprachen dieses Turns (`TurnInfo.languages`).
   * @returns Die neuen Hinweise, wenn umgeschaltet werden soll — sonst undefined.
   */
  observe(transcript: string, languages: readonly string[] | undefined): string[] | undefined {
    const detected = (languages?.[0] ?? "").trim().toLowerCase().split(/[-_]/)[0];
    // Zu kurz, nichts erkannt, oder eine Sprache, die das Modell gar nicht kennt:
    // Der Streak bleibt unberührt — ein unbrauchbarer Turn ist kein Gegenbeweis.
    if (transcript.trim().length < this.opts.minChars) return undefined;
    if (!detected || !isFluxLanguage(detected)) return undefined;

    if (detected === this.current) {
      this.candidate = undefined;
      this.streak = 0;
      return undefined;
    }
    if (detected !== this.candidate) {
      this.candidate = detected;
      this.streak = 1;
    } else {
      this.streak += 1;
    }
    if (this.streak < this.opts.confirmTurns) return undefined;

    this.current = detected;
    this.candidate = undefined;
    this.streak = 0;
    return [detected];
  }
}
