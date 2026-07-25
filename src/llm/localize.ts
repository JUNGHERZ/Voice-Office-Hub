/**
 * Laufzeit-Lokalisierung fest hinterlegter Ansagen: ein LLM-One-Shot erkennt die Sprache des
 * Anrufers und übersetzt — falls abweichend — den kompletten Ansagen-Katalog in einem Rutsch.
 * Dieselbe Requesty-Anbindung wie summarize.ts / der live `think`-Schritt.
 *
 * Sprache wird NUR aus den `caller:`-Zeilen bestimmt (die `agent:`-Zeilen sind Default-sprachig →
 * „vergiftete Evidenz" für die Sprache, aber wertvoll fürs Register/die Anrede-Form).
 */
import { config } from "../config.js";
import { logger } from "../util/logger.js";

const log = logger.child({ mod: "localize" });

export interface LocalizeResult {
  /** Erkannter Sprachcode des Anrufers (Kleinbuchstaben, z. B. "de", "en", "es"). */
  language: string;
  /**
   * Im Gespräch erkannte Anredeform. Das Modell muss sie BENENNEN, bevor es übersetzt —
   * die erzwungene Zwischenentscheidung macht die Register-Umsetzung deutlich stabiler
   * als eine implizite Anweisung. Nur Diagnose/Logging, steuert nichts.
   */
  formality?: "formal" | "informal";
  /** Übersetzungen unter denselben Katalog-Keys; fehlt, wenn Anrufer = Katalogsprache. */
  phrases?: Record<string, string>;
}

const SYSTEM_PROMPT = [
  "Du bist eine Lokalisierungs-Funktion für einen Telefon-Assistenten.",
  'Erkenne die Sprache des ANRUFERS ausschließlich aus den mit "caller:" markierten Zeilen',
  '(Kleinbuchstaben-Sprachcode wie "de", "en", "es"). Die mit "agent:" markierten Zeilen',
  "sind nur Kontext für Anrede/Ton, NICHT für die Sprachbestimmung.",
  "Das JSON-Objekt CATALOG enthält Ansagen in der Standardsprache des Assistenten, je unter einem Key.",
  'Spricht der Anrufer dieselbe Sprache wie der Katalog, antworte NUR mit {"language":"<code>"} ohne phrases.',
  "Sonst gehe in ZWEI Schritten vor.",
  'SCHRITT 1 — bestimme das Feld "formality": Wie sprechen sich Anrufer und Assistent im',
  'Gespräch an? "informal" wenn die Du-Form verwendet wird (du/tu/tú — z. B. spanisch',
  '"puedes/quieres", italienisch "puoi/vuoi", französisch "tu peux"), sonst "formal".',
  "Achte auf die Verbformen, nicht nur auf Pronomen — in romanischen Sprachen steht das",
  "Pronomen meist gar nicht da. Im Zweifel: so, wie der Anrufer den Assistenten anspricht.",
  'SCHRITT 2 — übersetze JEDEN Katalog-Wert in die Sprache des Anrufers und setze dabei',
  'GENAU die in "formality" bestimmte Anredeform um (bei "informal" durchgehend duzen:',
  "tú/tu-Formen, KEIN usted/lei/vous). Bedeutung und Interpunktion wahren.",
  "Der Sprecher ist IMMER der Assistent: behalte grammatische Person und Perspektive bei",
  "(1. Person Singular bleibt 1. Person Singular) und mache aus einer Aussage über eigenes",
  "Handeln NIEMALS eine Aufforderung an den Anrufer.",
  "Achte auf korrekte Rechtschreibung und Konjugation der Zielsprache.",
  "Behalte die Keys EXAKT bei, füge keine hinzu und lasse keine weg.",
  'Antworte mit striktem JSON: {"language":"<code>","formality":"formal|informal",',
  '"phrases":{<key>:<übersetzung>,…}}. Keine Prosa.',
].join(" ");

interface ChatCompletionResponse {
  choices?: Array<{ message?: { content?: string } }>;
}

/**
 * @param conversation rollenmarkierter Ausschnitt der letzten Turns ("caller: …" / "agent: …")
 * @param catalog Key → Default-Satz (Standardsprache)
 */
export async function detectAndLocalize(
  conversation: string,
  catalog: Record<string, string>,
  opts?: { model?: string; signal?: AbortSignal },
): Promise<LocalizeResult> {
  const model = opts?.model || config.localize.model;
  const userContent = `CATALOG = ${JSON.stringify(catalog)}\n\nGesprächsausschnitt:\n${conversation}`;

  const res = await fetch(`${config.llm.requestyBaseUrl.replace(/\/$/, "")}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${config.llm.requestyApiKey}`,
    },
    body: JSON.stringify({
      model,
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: userContent },
      ],
      temperature: 0,
      max_tokens: 1000,
      // Best-effort — nicht jedes geroutete Modell honoriert es; das robuste Parsen fängt den Rest.
      response_format: { type: "json_object" },
    }),
    signal: opts?.signal,
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    log.warn("Localize-Request fehlgeschlagen", { status: res.status, body });
    throw new Error(`Requesty ${res.status}`);
  }

  const json = (await res.json()) as ChatCompletionResponse;
  return parseLocalizeResponse(json.choices?.[0]?.message?.content ?? "", catalog);
}

/**
 * Robustes Parsen + Validierung gegen den Katalog (exportiert für Tests). Wirft bei
 * Unbrauchbarem — der CallLocalizer fängt das und behält die Default-Sätze.
 */
export function parseLocalizeResponse(raw: string, catalog: Record<string, string>): LocalizeResult {
  const text = extractJsonObject(raw);
  if (!text) throw new Error("localize: keine JSON-Antwort");
  const obj = JSON.parse(text) as { language?: unknown; formality?: unknown; phrases?: unknown };
  if (typeof obj.language !== "string" || !obj.language.trim() || obj.language.length > 8) {
    throw new Error("localize: ungültiges language-Feld");
  }
  const result: LocalizeResult = { language: obj.language.toLowerCase().trim() };
  if (obj.formality === "formal" || obj.formality === "informal") result.formality = obj.formality;
  if (obj.phrases && typeof obj.phrases === "object") {
    const phrases: Record<string, string> = {};
    for (const [key, val] of Object.entries(obj.phrases as Record<string, unknown>)) {
      // Nur bekannte Keys mit nicht-leerem String-Wert — Halluzinationen/Renames werden verworfen.
      if (key in catalog && typeof val === "string" && val.trim()) phrases[key] = val;
    }
    if (Object.keys(phrases).length) result.phrases = phrases;
  }
  return result;
}

/** Strippt ```json-Fences und extrahiert das erste balancierte {…}-Objekt (string-bewusst). */
function extractJsonObject(raw: string): string | null {
  let s = raw.trim();
  if (s.startsWith("```")) s = s.replace(/^```(?:json)?/i, "").replace(/```$/, "").trim();
  const start = s.indexOf("{");
  if (start < 0) return null;
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < s.length; i++) {
    const c = s[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === "\\") esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === "{") depth++;
    else if (c === "}") {
      depth--;
      if (depth === 0) return s.slice(start, i + 1);
    }
  }
  return null;
}
