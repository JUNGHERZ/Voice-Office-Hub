/**
 * Sprach-Hinweise für die Erkennung — ABGELEITET, nicht konfiguriert (0.14.0).
 *
 * Warum abgeleitet: Bis 0.13.x trug jeder Agent `language_hints: ["de", "en"]` als
 * Vorgabe — ohne Feld im Admin-Panel, also von niemandem gewählt. Damit war Flux
 * ausdrücklich gesagt, dass es AUCH Englisch erwarten soll. Gemessen am 26.08.2026
 * (Anruf `1787759851.0`): 6 von 14 Anrufer-Beiträgen kamen als reines Englisch
 * zurück, ausschliesslich bei KURZEN Äusserungen — aus „Ja, ja" wurde „Yep. Yep.",
 * aus einer Rückfrage „You all good customer?", worauf der Agent mit „Ja, mir geht's
 * gut" antwortete. Die Fehlerkennung hat den Gesprächsverlauf umgelenkt.
 *
 * Deepgram beschreibt genau das: Ein EINZELNER Hinweis „biases strongly toward one
 * language" und erreicht die Genauigkeit eines einsprachigen Modells; mehrere
 * Hinweise sind für Mehrsprach-Hotlines gedacht, also für gewolltes Umschalten.
 * Ein einsprachiges deutsches Flux-Modell gibt es nicht — `flux-general-en` ist
 * englisch-only, alles andere läuft über `flux-general-multi` plus Hinweis.
 *
 * Die Quelle der Wahrheit ist deshalb `agent.contentLanguage`: die Sprache, in der
 * Begrüssung und System-Prompt geschrieben sind. Wer auf Deutsch begrüsst, bekommt
 * überwiegend deutschsprachige Anrufer — und genau das gehört der Erkennung gesagt.
 */

/**
 * Von `flux-general-multi` unterstützte Hinweise (Deepgram, Stand 08/2026).
 * Ein nicht unterstützter Code wird weggelassen statt geraten: Ohne Hinweis erkennt
 * das Modell selbst, mit einem falschen Hinweis rät es in die falsche Richtung.
 */
const FLUX_MULTI_LANGUAGES = new Set([
  "en", "es", "fr", "de", "hi", "ru", "pt", "ja", "it", "nl",
]);

/**
 * Ein Hinweis, abgeleitet aus der Sprache der Agent-Texte.
 *
 * Leeres Ergebnis heisst „kein Hinweis" — Flux erkennt dann selbst. Das ist der
 * richtige Rückfall für Sprachen, die das Modell nicht kennt, und ausdrücklich
 * besser als ein Hinweis auf eine andere Sprache.
 */
export function languageHintsFor(contentLanguage: string | undefined): string[] {
  const lang = (contentLanguage ?? "").trim().toLowerCase().split(/[-_]/)[0];
  if (!lang || lang === "multi") return [];
  return FLUX_MULTI_LANGUAGES.has(lang) ? [lang] : [];
}
