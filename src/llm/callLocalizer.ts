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
 * Der Katalog ist pool-generisch: `resolve("filler", i)` rotiert durch `filler.0…N`, `resolve("idle", stage)`
 * adressiert die Stille-Ansagen nach Eskalationsstufe. Ein weiterer Pool ist reine Daten im
 * buildLocalizationCatalog — weder localize.ts noch der Kern hier müssen ihn kennen.
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
  preload(lang: string, phrases: Record<string, string>): void;
  getLanguageState(): LanguageState;
  close(): void;
}

/** Was am Ende des Anrufs über die Gesprächssprache bekannt ist (steuert das Anrufer-Profil). */
export interface LanguageState {
  /** Zuletzt gültige Sprache — auch dann gesetzt, wenn sie nur aus dem Prior stammt. */
  lang?: string;
  /** Per LLM bestätigt? Nur dann taugt sie, um künftige Begrüßungen zu steuern. */
  confirmed: boolean;
  /** Sprache, mit der der Anruf vorbelegt startete (aus dem Anrufer-Profil), falls vorhanden. */
  priorLang?: string;
}

/**
 * Baut aus der Agent-Konfiguration den flachen Default-Katalog + die Pool-Registrierung.
 *
 * `includeGreeting` nur für die Vorübersetzung (translationStore.ts): Zur Laufzeit ist die
 * Begrüßung längst gesprochen, sie im Übersetzungs-Prompt mitzuschicken wäre verschwendeter Platz.
 */
export function buildLocalizationCatalog(
  agent: ResolvedAgent,
  opts?: { includeGreeting?: boolean },
): LocalizationCatalog {
  const defaults: Record<string, string> = {};
  const pools: Record<string, number> = {};

  if (opts?.includeGreeting && agent.greeting?.trim()) defaults.greeting = agent.greeting.trim();

  defaults.transferFailed = agent.transferFailedAnnouncement || config.announcements.transferFailed;

  const phrases = (agent.fillers?.phrases ?? []).filter((p) => p && p.trim());
  phrases.forEach((p, i) => {
    defaults[`filler.${i}`] = p;
  });
  if (phrases.length) pools.filler = phrases.length;

  for (const t of agent.customTools ?? []) {
    if (t.fillerPhrase && t.fillerPhrase.trim()) defaults[`tool.${t.name}`] = t.fillerPhrase.trim();
  }

  // Stille-Ansagen (0.6.27): Pool wie beim Filler, aber der Aufrufer indiziert mit der
  // Eskalationsstufe statt zu rotieren (resolve("idle", stage)).
  const idle = (agent.idlePrompts?.phrases ?? []).filter((p) => p && p.trim());
  idle.forEach((p, i) => {
    defaults[`idle.${i}`] = p;
  });
  if (idle.length) pools.idle = idle.length;
  // Nur bei aktivem Auflegen in den Katalog — hält den Übersetzungs-Prompt klein.
  if (agent.idlePrompts?.hangupAfter) {
    defaults.idleHangup = agent.idlePrompts.hangupAnnouncement || config.announcements.idleHangup;
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

  // Vorbelegung aus dem Anrufer-Profil: Ansagen sind ab Sekunde 0 da, die Erkennung steht aber
  // noch aus. Solange das gilt, wird der Detect trotzdem ausgelöst (Bestätigung + Anredeform)
  // und ein einzelner Scorer-Widerspruch schaltet sofort um, statt die Hysterese abzuwarten.
  private provisional = false;
  private priorLang?: string;
  private confirmed = false;

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
    if (!this.currentLang || this.provisional) {
      const words = text.trim().split(/\s+/).filter(Boolean).length;
      // Bei vorbelegter Sprache genügt EIN Lauf zur Bestätigung. Ohne diese Bremse stößt jeder
      // weitere Turn während des laufenden Calls einen Rerun an (`rerunPending`) — der ist
      // sinnvoll, solange gar nichts bekannt ist, aber überflüssig, wenn wir nur bestätigen.
      const busyConfirming = this.provisional && this.detecting;
      if ((words >= DETECT_MIN_WORDS || this.callerTurns >= 2) && !busyConfirming) {
        this.triggerDetect();
      }
      // Vorbelegt und der Anrufer spricht hörbar anders: nicht auf das LLM warten. Ein einzelner
      // klarer Widerspruch reicht, weil die Vorbelegung selbst nur eine Vermutung ist.
      if (this.provisional) {
        const guess = this.deps.scoreLanguage(text);
        if (guess && guess.lang !== this.currentLang) this.switchTo(guess.lang);
      }
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

  /**
   * Sprache und Ansagen aus dem Anrufer-Profil vorbelegen — noch vor dem ersten Wort, damit
   * Begrüßung und erste Ansagen sitzen. Die Erkennung läuft trotzdem an: Sie bestätigt die
   * Sprache und liefert die Anredeform, die eine statische Vorübersetzung nicht kennen kann.
   */
  preload(lang: string, phrases: Record<string, string>): void {
    if (!lang || this.closed || this.currentLang) return;
    this.priorLang = lang;
    this.provisional = true;
    if (Object.keys(phrases).length) this.cache.set(lang, { ...phrases });
    // Direkt statt über switchTo: Eine Vermutung gehört noch nicht als Fakt ins Request-Dokument.
    // `lastWritten` bleibt bewusst leer, damit die spätere Bestätigung den Write auslöst.
    this.currentLang = lang;
  }

  getLanguageState(): LanguageState {
    return {
      lang: this.currentLang,
      confirmed: this.confirmed,
      ...(this.priorLang ? { priorLang: this.priorLang } : {}),
    };
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
      .localize(sample, this.defaults, {
        signal: ctrl.signal,
        catalogLanguage: this.agent.contentLanguage,
      })
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
    // Diagnose: Fehlt phrases bei abweichender Sprache, verweigert das Modell die Übersetzung
    // (siehe localize.ts) — das war 0.6.27 live nur im Requesty-Dashboard sichtbar.
    this.log.info("Ansagen lokalisiert", {
      language: lang,
      ...(res.catalogLanguage ? { catalogLanguage: res.catalogLanguage } : {}),
      ...(res.formality ? { formality: res.formality } : {}),
      phrases: res.phrases ? Object.keys(res.phrases).length : 0,
      catalog: Object.keys(this.defaults).length,
      ...(this.priorLang ? { prior: this.priorLang, priorOk: this.priorLang === lang } : {}),
    });
    // Die vorgegebene Ausgangssprache ist jetzt bestätigt statt geraten — weicht sie ab, ist
    // entweder contentLanguage falsch gepflegt oder das Modell verwirrt. Beides will man sehen.
    if (res.catalogLanguage && res.catalogLanguage !== this.agent.contentLanguage) {
      this.log.warn("Katalogsprache weicht von contentLanguage ab", {
        konfiguriert: this.agent.contentLanguage,
        erkannt: res.catalogLanguage,
      });
    }
    // Ab hier ist die Sprache LLM-bestätigt: Die Vorbelegung verliert ihren Vermutungs-Status,
    // und erst jetzt darf sie ins Anrufer-Profil (Qualitätsgate in callHandler.ts).
    this.provisional = false;
    this.confirmed = true;
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
