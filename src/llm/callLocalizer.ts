/**
 * CallLocalizer — pro Anruf ein Objekt, das fest hinterlegte Ansagen (Filler, Transfer-Ansage,
 * künftig weitere Pools) zur Laufzeit in die Sprache des Anrufers übersetzt.
 *
 *  - `active` nur bei mehrsprachigem Agent (`language === "multi"`) + gesetztem Requesty-Key
 *    + nicht-leerem Katalog. Sonst inert: `observeTurn` = No-op, `resolve()` = Default-Sätze
 *    (so bekommt JEDER Agent die Transfer-Ansage in der Standardsprache, null LLM-Kosten).
 *  - Erkennung: ein LLM-One-Shot (localize.ts), eager nach dem ersten inhaltlichen Anrufer-Turn,
 *    im Hintergrund; adaptive Re-Detection über den Stopwort-Scorer bei anhaltendem Sprachwechsel.
 *  - `resolve(key, index?)` liefert immer synchron eine Ansage (Übersetzung → Default → ""), wirft nie.
 *  - Eigentümer ist der callHandler (beide Provider); die NativeSession bekommt ihn injiziert (Filler).
 *
 * Der Katalog ist pool-generisch: `resolve("filler", i)` rotiert durch `filler.0…N`; ein neuer
 * Pool (z. B. `idle` für Stille-Ansagen) ist reine Daten im buildLocalizationCatalog.
 */
import { config } from "../config.js";
import * as repo from "../db/repository.js";
import type { ResolvedAgent } from "../types.js";
import { logger } from "../util/logger.js";

import { detectAndLocalize, type LocalizeResult } from "./localize.js";
import { scoreLanguage } from "./languageScorer.js";

export interface LocalizerDeps {
  localize: typeof detectAndLocalize;
  scoreLanguage: typeof scoreLanguage;
  setLanguage: (id: string, language: string) => Promise<void>;
}

export interface LocalizationCatalog {
  /** Key → Default-Satz (Standardsprache). Einzelansagen (`transferFailed`) und Pool-Glieder (`filler.0`). */
  defaults: Record<string, string>;
  /** Pool-Name → Anzahl der Glieder (Keys `${pool}.${i}`), für `resolve`-Rotation. */
  pools: Record<string, number>;
}

/** Öffentlicher Vertrag des CallLocalizer (callHandler-Tests reichen ein Fake ein). */
export interface CallLocalizerLike {
  observeTurn(speaker: string, text: string): void;
  resolve(key: string, index?: number): string;
  getLanguage(): string | undefined;
  close(): void;
}

/** Baut aus der Agent-Konfiguration den flachen Default-Katalog + die Pool-Registrierung. */
export function buildLocalizationCatalog(agent: ResolvedAgent): LocalizationCatalog {
  const defaults: Record<string, string> = {};
  const pools: Record<string, number> = {};

  defaults.transferFailed = agent.transferFailedAnnouncement || config.announcements.transferFailed;

  const phrases = (agent.fillers?.phrases ?? []).filter((p) => p && p.trim());
  phrases.forEach((p, i) => {
    defaults[`filler.${i}`] = p;
  });
  if (phrases.length) pools.filler = phrases.length;

  for (const t of agent.customTools ?? []) {
    if (t.fillerPhrase && t.fillerPhrase.trim()) defaults[`tool.${t.name}`] = t.fillerPhrase.trim();
  }

  return { defaults, pools };
}

const DETECT_MIN_WORDS = 3;
const REDETECT_STREAK = 2;
const SAMPLE_MAX_CHARS = 1200;

export class CallLocalizer implements CallLocalizerLike {
  private readonly deps: LocalizerDeps;
  private readonly defaults: Record<string, string>;
  private readonly pools: Record<string, number>;
  private readonly active: boolean;
  private readonly log = logger.child({ mod: "localizer" });

  /** Rollenmarkiertes Rolling-Fenster (beide Rollen) als Erkennungs-Kontext inkl. Register. */
  private readonly window: string[] = [];
  private callerTurns = 0;
  private currentLang?: string;
  private readonly cache = new Map<string, Record<string, string>>();
  private readonly cursor: Record<string, number> = {};

  private detecting = false;
  private rerunPending = false;
  private gen = 0; // steigt bei jedem Detect-Start + close → veraltete Ergebnisse verwerfen
  private closed = false;
  private lastWritten?: string;
  private abortCtrl?: AbortController;

  // Re-Detection-Hysterese
  private deviationLang?: string;
  private deviationStreak = 0;

  constructor(
    private readonly agent: ResolvedAgent,
    private readonly requestId: string,
    depsOverride?: Partial<LocalizerDeps>,
  ) {
    this.deps = { localize: detectAndLocalize, scoreLanguage, setLanguage: repo.setLanguage, ...depsOverride };
    const catalog = buildLocalizationCatalog(agent);
    this.defaults = catalog.defaults;
    this.pools = catalog.pools;
    this.active =
      agent.language === "multi" &&
      !!config.llm.requestyApiKey &&
      Object.keys(this.defaults).length > 0;
  }

  /**
   * Einziger Einstieg (non-blocking): puffert beide Rollen; die Trigger-/Scorer-Logik läuft
   * nur bei `speaker === "caller"`. Wird vom callHandler bei jedem conversationText-Event gefüttert.
   */
  observeTurn(speaker: string, text: string): void {
    if (!this.active || this.closed || !text.trim()) return;
    this.window.push(`${speaker === "caller" ? "caller" : "agent"}: ${text}`);
    this.trimWindow();
    if (speaker !== "caller") return;

    this.callerTurns++;
    if (!this.currentLang) {
      const words = text.trim().split(/\s+/).filter(Boolean).length;
      if (words >= DETECT_MIN_WORDS || this.callerTurns >= 2) this.triggerDetect();
      return;
    }

    // Re-Detection: der Scorer beobachtet nur; das LLM bleibt autoritativ.
    const guess = this.deps.scoreLanguage(text);
    if (!guess) return;
    if (guess.lang === this.currentLang) {
      this.deviationStreak = 0;
      this.deviationLang = undefined;
      return;
    }
    this.deviationStreak = guess.lang === this.deviationLang ? this.deviationStreak + 1 : 1;
    this.deviationLang = guess.lang;
    if (this.deviationStreak >= REDETECT_STREAK) {
      const candidate = this.deviationLang;
      this.deviationStreak = 0;
      this.deviationLang = undefined;
      if (candidate && this.cache.has(candidate)) this.switchTo(candidate); // Cache-Hit → kein LLM
      else this.triggerDetect();
    }
  }

  /** Synchron, wirft nie: Übersetzung der aktuellen Sprache → Default-Satz → "". */
  resolve(key: string, index?: number): string {
    const effKey = this.effectiveKey(key, index);
    if (!effKey) return "";
    const translated = this.currentLang ? this.cache.get(this.currentLang)?.[effKey] : undefined;
    return translated ?? this.defaults[effKey] ?? "";
  }

  getLanguage(): string | undefined {
    return this.currentLang;
  }

  close(): void {
    this.closed = true;
    this.gen++;
    this.abortCtrl?.abort();
    this.abortCtrl = undefined;
  }

  // — intern —

  private effectiveKey(key: string, index?: number): string | null {
    const count = this.pools[key];
    if (count === undefined) return key; // Einzelansage
    if (count === 0) return null;
    const idx = index ?? this.cursor[key] ?? 0;
    if (index === undefined) this.cursor[key] = idx + 1; // Rotation nur ohne explizten Index
    return `${key}.${idx % count}`;
  }

  private triggerDetect(): void {
    if (this.detecting) {
      this.rerunPending = true;
      return;
    }
    this.detecting = true;
    const myGen = ++this.gen;
    const sample = this.window.join("\n");
    const ctrl = new AbortController();
    this.abortCtrl = ctrl;
    void this.deps
      .localize(sample, this.defaults, { signal: ctrl.signal })
      .then((res) => this.applyResult(myGen, res))
      .catch((err) => {
        if (!this.closed) this.log.warn("Sprach-Erkennung fehlgeschlagen — Defaults bleiben", { err: String(err) });
      })
      .finally(() => {
        if (this.abortCtrl === ctrl) this.abortCtrl = undefined;
        this.detecting = false;
        if (this.rerunPending && !this.closed) {
          this.rerunPending = false;
          this.triggerDetect();
        }
      });
  }

  private applyResult(myGen: number, res: LocalizeResult): void {
    if (this.closed || myGen !== this.gen) return; // veraltet (close / erneut geändert)
    const lang = res.language;
    if (res.phrases && Object.keys(res.phrases).length) {
      this.cache.set(lang, { ...(this.cache.get(lang) ?? {}), ...res.phrases });
    } else if (!this.cache.has(lang)) {
      // Anrufer = Katalogsprache → keine Übersetzung; leerer Eintrag markiert „geprüft".
      this.cache.set(lang, {});
    }
    this.switchTo(lang);
  }

  private switchTo(lang: string): void {
    this.currentLang = lang;
    if (this.lastWritten === lang) return;
    this.lastWritten = lang;
    void this.deps
      .setLanguage(this.requestId, lang)
      .catch((err) => this.log.warn("setLanguage fehlgeschlagen", { err: String(err) }));
  }

  private trimWindow(): void {
    let total = this.window.reduce((n, l) => n + l.length + 1, 0);
    while (this.window.length > 1 && total > SAMPLE_MAX_CHARS) {
      total -= this.window.shift()!.length + 1;
    }
  }
}
