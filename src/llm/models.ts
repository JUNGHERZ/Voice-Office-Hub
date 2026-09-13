/**
 * Modell-Eigenheiten, die mehrere LLM-Aufrufer teilen (Deepgram-Settings-Builder,
 * NativeSession-Streaming-Client).
 */

/**
 * Modellkette aus einer kommagetrennten Angabe: erste Stufe primär, danach die
 * Ausweichstufen in Reihenfolge (0.18.0). Eine Angabe ohne Komma ergibt eine Kette
 * der Länge 1 — bestehende Konfigurationen verhalten sich damit unverändert.
 *
 * Leere Einträge und Dubletten fallen raus: `"a, ,a,b"` → `["a","b"]`. Eine Dublette
 * wäre keine Ausweichstufe, sondern nur ein zweiter Versuch beim selben Anbieter —
 * genau das, was ein Anbieterausfall gerade nicht braucht.
 */
export function parseModelChain(value: string | undefined): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of (value ?? "").split(",")) {
    const m = raw.trim();
    if (!m || seen.has(m)) continue;
    seen.add(m);
    out.push(m);
  }
  return out;
}

/**
 * Primärmodell einer Angabe. Für Pfade, die keine Kette können (Deepgram denkt
 * selbst und nimmt genau ein Modell entgegen) und für Anzeigezwecke.
 */
export function primaryModel(value: string | undefined): string {
  return parseModelChain(value)[0] ?? "";
}

/**
 * GPT-5-Familie (und OpenAI-Reasoning-Modelle o1/o3) akzeptieren nur die Default-Temperatur;
 * ein abweichender Wert führt zu Upstream-400 → "Failed to think" bzw. Request-Fehler.
 */
export function modelSupportsTemperature(model: string): boolean {
  return !/(^|\/)(gpt-5|o1|o3)/i.test(model);
}

/**
 * Prompt-Caching ist eine Anthropic-Eigenheit: `cache_control` wird nur von
 * Claude-Modellen ausgewertet (Anthropic-API, Bedrock, Vertex — Requesty reicht den
 * Block durch, live verifiziert 2026-08-18). OpenAI/Gemini/Mistral kennen die
 * Blockform nicht; ihnen statt eines Strings ein Content-Block-Array zu schicken,
 * riskiert einen 400 mitten im Anruf. Deshalb ist die Modellprüfung die harte Grenze.
 */
export function supportsPromptCache(model: string): boolean {
  return /claude/i.test(model);
}

/**
 * Mindestlänge des cachebaren Präfix je Claude-Familie (Tokens). Kürzere Präfixe
 * ignoriert die API STILLSCHWEIGEND — kein Fehler, kein Schreibaufschlag, aber auch
 * keine Ersparnis (live gemessen: 469-Token-Präfix, Kosten mit und ohne cache_control
 * auf den Cent identisch). Der Wert ist deshalb bewusst KEIN Gate, sondern speist nur
 * die Diagnose: ein zu kurzer Prompt soll erklärbar sein, nicht stumm wirkungslos.
 *
 * Reihenfolge ist bedeutungstragend — die spezifischen Versionsmuster stehen vorn,
 * weil `claude-opus-4` sonst auch `claude-opus-4-5` fangen würde.
 */
const CACHE_MIN_TOKENS: ReadonlyArray<readonly [RegExp, number]> = [
  [/claude-opus-4-[56]/i, 4096],
  [/claude-haiku-4-5/i, 4096],
  [/claude-opus-4-7/i, 2048],
  [/claude-haiku-3-5/i, 2048],
  [/claude-opus-4-8/i, 1024],
  [/claude-sonnet-(5|4-6|4-5|4)\b/i, 1024],
  [/claude-opus-(4-1|4)\b/i, 1024],
  [/claude-(opus-5|fable-5|mythos-5)/i, 512],
];

/** Unbekannte Claude-Modelle: der höchste bekannte Wert, damit die Diagnose nicht zu früh Entwarnung gibt. */
const CACHE_MIN_TOKENS_FALLBACK = 4096;

/** Mindest-Präfix in Tokens, ab dem dieses Modell überhaupt cacht. */
export function promptCacheMinTokens(model: string): number {
  for (const [re, min] of CACHE_MIN_TOKENS) if (re.test(model)) return min;
  return CACHE_MIN_TOKENS_FALLBACK;
}
