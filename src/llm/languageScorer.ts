/**
 * Leichtgewichtiger Sprach-Detektor über Stopwort-Trefferquoten. KEINE Dependency.
 *
 * Zweck: nur ein *Verdachtssignal* für die adaptive Re-Detection im CallLocalizer — er
 * entscheidet NIE die Sprache, sondern triggert höchstens den LLM-One-Shot (localize.ts).
 * Deshalb genügt eine grobe, aber ausreichend robuste Heuristik mit Konfidenz-Gate; ein
 * „Okay."/„Ja." oder ein einzelnes geteiltes Wort darf die Gesprächssprache nie kippen.
 */

const STOPWORDS: Record<string, string[]> = {
  de: ["der", "die", "das", "und", "ich", "nicht", "ist", "ein", "eine", "zu", "den", "mit", "sie", "auf", "für", "haben", "kann", "wir", "was", "bitte", "gerne", "einen", "möchte", "hallo", "danke", "guten", "wie", "mir", "mich", "noch"],
  en: ["the", "and", "you", "for", "not", "are", "with", "have", "this", "that", "can", "please", "hello", "would", "like", "what", "your", "how", "help", "thanks", "want", "need", "good", "just", "about", "there", "could"],
  fr: ["le", "la", "les", "et", "je", "ne", "pas", "est", "un", "une", "vous", "avec", "pour", "bonjour", "merci", "oui", "que", "comment", "voudrais", "plaît", "besoin", "bien", "suis"],
  es: ["el", "los", "las", "no", "es", "un", "una", "con", "para", "por", "hola", "gracias", "sí", "que", "cómo", "quiero", "necesito", "buenos", "usted", "me", "está", "puede"],
  it: ["il", "le", "non", "è", "un", "una", "con", "per", "ciao", "grazie", "sì", "che", "come", "vorrei", "buongiorno", "sono", "mi", "ho", "posso", "vuole"],
  nl: ["het", "een", "en", "ik", "niet", "is", "met", "voor", "hallo", "dank", "nee", "wat", "hoe", "graag", "wil", "goedemorgen", "kan", "een", "mijn", "dat"],
  pt: ["os", "não", "é", "um", "uma", "com", "para", "por", "olá", "obrigado", "sim", "que", "como", "quero", "preciso", "bom", "você", "está", "pode", "eu"],
  pl: ["nie", "tak", "jest", "dzień", "dobry", "proszę", "dziękuję", "co", "jak", "chcę", "potrzebuję", "na", "to", "się", "mogę", "pan", "pani"],
  tr: ["bir", "ve", "değil", "için", "ben", "merhaba", "teşekkür", "evet", "hayır", "ne", "nasıl", "istiyorum", "lütfen", "bu", "var", "ile", "yardım"],
};

const STOPSETS: Record<string, Set<string>> = Object.fromEntries(
  Object.entries(STOPWORDS).map(([lang, words]) => [lang, new Set(words)]),
);

export interface LanguageGuess {
  lang: string;
  confidence: number;
}

/**
 * Grobe Sprachschätzung. Gibt `null` zurück, wenn die Evidenz zu dünn/uneindeutig ist
 * (zu kurz, zu niedrige Trefferquote, oder zwei Sprachen zu dicht beieinander).
 */
export function scoreLanguage(text: string): LanguageGuess | null {
  const tokens = text.toLowerCase().split(/[^\p{L}]+/u).filter(Boolean);
  if (tokens.length < 3) return null;

  const scored = Object.entries(STOPSETS)
    .map(([lang, set]) => {
      let matches = 0;
      for (const t of tokens) if (set.has(t)) matches++;
      return { lang, score: matches / tokens.length };
    })
    .sort((a, b) => b.score - a.score);

  const top = scored[0];
  if (!top) return null;
  if (top.score < 0.18) return null; // zu wenig Funktionswörter erkannt
  if (top.score - (scored[1]?.score ?? 0) < 0.08) return null; // zu knapp → unsicher
  return { lang: top.lang, confidence: top.score };
}

/**
 * Ausgangssprache der Agent-Texte aus Begrüßung + System-Prompt schätzen (für `contentLanguage`,
 * wenn am Agenten nichts gesetzt ist). Anders als bei der Anrufer-Erkennung ist die Textmenge
 * hier groß (ein System-Prompt hat mehrere hundert Zeichen) — in dieser Länge ist die
 * Stopwort-Heuristik sehr sicher, und ein LLM-Call wäre reine Verschwendung.
 *
 * `null` heißt „nicht eindeutig"; der Aufrufer setzt dann seinen Default (diese Datei bleibt
 * bewusst ohne Config-Abhängigkeit).
 */
export function detectContentLanguage(...texts: Array<string | undefined>): string | null {
  const text = texts.filter((t) => t && t.trim()).join(" ").trim();
  if (!text) return null;
  return scoreLanguage(text)?.lang ?? null;
}
