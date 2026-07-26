/**
 * Stille-Wächter (0.6.27): Schweigt der Anrufer, spricht der Agent eine kurze Ansage aus dem
 * `idle`-Pool — eskalierend über mehrere Stufen, optional endend im Auflegen.
 *
 * Bewusst OHNE eigenen Timer: Der callHandler treibt `tick(now)` (alle ~250 ms) und liefert über
 * die Hooks alles Wissen, das nur er hat — Playout-Puffer, Transfer-/Auflege-Zustand, laufende
 * Tool-Dispatches. Damit ist diese Klasse eine reine Zustandsmaschine: kein `Date.now()`, kein
 * I/O, ohne Fake-Timer testbar (Timestamps von Hand vorschieben).
 *
 * Die Abstände wachsen je Stufe (BACKOFF) statt konstant zu bleiben: Ein Mensch gibt mit jeder
 * Runde mehr Luft, nicht gleich viel — sonst entsteht ein Maschinengewehr-Takt bis zum Auflegen.
 * Der Jitter ist ausschließlich additiv, damit der konfigurierte Wert eine Zusage nach unten
 * bleibt („nie vor timeoutMs") — zu früh ins Nachdenken zu reden ist der teurere Fehler.
 */
import type { ResolvedIdlePrompts } from "../types.js";

/** Faktor je Stufe: Ansage 1, Ansage 2, danach (auch Gnadenfrist vor dem Auflegen). */
const BACKOFF = [1, 1.5, 2];
/** Zufällige Streckung obendrauf: 0 … +20 %, nie nach unten. */
const JITTER = 0.2;

export interface IdleWatcherHooks {
  /** Hört der Anrufer den Agenten gerade noch? (Playout-Puffer, frisches Audio, Sprechdauer-Boden) */
  isAgentAudible(now: number): boolean;
  /** Darf jetzt nicht gesprochen werden? (Transfer, Auflegen läuft, Tool-Dispatch, Session weg) */
  isBlocked(): boolean;
  /** Ansage der Stufe `stage` (0-basiert); "" wenn keine gepflegt ist. */
  phrase(stage: number): string;
  /** Ansage sprechen (injectMessage) und zählen. */
  speak(text: string): void;
  /** Leiter erschöpft + hangupAfter: Abschied sprechen und auflegen (Text löst der Aufrufer auf). */
  hangup(): void;
}

export class IdleWatcher {
  /**
   * Beginn der aktuellen Stille (wird mitgezogen, solange der Agent hörbar/gesperrt ist).
   * undefined = noch nicht verankert; der erste Tick setzt ihn. Ohne das läge die erste
   * Fälligkeit immer in der Vergangenheit → Ansage sofort beim Anrufaufbau.
   */
  private anchor?: number;
  /** Fälligkeit der aktuellen Stufe; undefined = beim nächsten Tick neu würfeln. */
  private deadline?: number;
  /** Nächste zu sprechende Eskalationsstufe (0-basiert). */
  private stage = 0;
  /** Leiter abgearbeitet — Ruhe, bis der Anrufer wieder spricht. */
  private stopped = false;

  constructor(
    private readonly cfg: ResolvedIdlePrompts,
    private readonly hooks: IdleWatcherHooks,
    private readonly random: () => number = Math.random,
  ) {}

  /** Anrufer war aktiv (Sprechbeginn oder fertiger Turn) → neue Stille-Episode ab Stufe 0. */
  noteCallerActivity(now: number): void {
    this.anchor = now;
    this.deadline = undefined;
    this.stage = 0;
    this.stopped = false;
  }

  /** Vom callHandler getaktet. Tut nichts, solange der Agent hörbar oder die Ansage gesperrt ist. */
  tick(now: number): void {
    if (!this.cfg.enabled || this.stopped) return;

    // Noch nicht verankert (erster Tick), Agent hörbar oder Ansage gesperrt: Die Stille hat
    // nicht begonnen bzw. wurde unterbrochen — Anker mitziehen und die Fälligkeit neu würfeln.
    if (this.anchor === undefined || this.hooks.isBlocked() || this.hooks.isAgentAudible(now)) {
      this.anchor = now;
      this.deadline = undefined;
      return;
    }

    if (this.deadline === undefined) this.deadline = this.anchor + this.waitFor(this.stage);
    if (now < this.deadline) return;

    if (this.stage < this.cfg.maxPrompts) {
      // Leere Phrase (Pool kürzer als maxPrompts o. ä.): Stufe läuft weiter, es wird nur nichts gesprochen.
      const text = this.hooks.phrase(this.stage);
      this.stage += 1;
      this.anchor = now;
      this.deadline = undefined;
      if (text) this.hooks.speak(text);
      return;
    }

    this.stopped = true;
    if (this.cfg.hangupAfter) this.hooks.hangup();
  }

  private waitFor(stage: number): number {
    const factor = BACKOFF[Math.min(stage, BACKOFF.length - 1)] ?? 1;
    return Math.round(this.cfg.timeoutMs * factor * (1 + JITTER * this.random()));
  }
}
