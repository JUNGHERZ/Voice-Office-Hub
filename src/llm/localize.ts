/**
 * Laufzeit-Lokalisierung fest hinterlegter Ansagen: ein LLM-One-Shot erkennt die Sprache des
 * Anrufers und übersetzt — falls abweichend — den kompletten Ansagen-Katalog in einem Rutsch.
 * Dieselbe Requesty-Anbindung wie summarize.ts / der live `think`-Schritt.
 *
 * Sprache wird NUR aus den `caller:`-Zeilen bestimmt (die `agent:`-Zeilen sind Default-sprachig →
 * „vergiftete Evidenz" für die Sprache, aber wertvoll fürs Register/die Anrede-Form).
 *
 * WICHTIG (0.6.28, teuer gelernt): Der Prompt darf dem Modell KEINEN Weg lassen, die Übersetzung
 * zu überspringen. Eine Abkürzung („gleiche Sprache → nur den Code zurückgeben") wurde von
 * gpt-4.1-mini reproduzierbar auch bei englischen Anrufern genommen (Spanisch dagegen korrekt
 * übersetzt); die Variante „gib es unverändert zurück, wenn es schon passt" lieferte bei
 * Italienisch die deutschen Originale. Deshalb: `phrases` ist Pflicht, und die Entscheidung,
 * ob überhaupt etwas anders ist, liegt allein beim Ergebnisvergleich im Code.
 */
import { config } from "../config.js";
import { logger } from "../util/logger.js";

const log = logger.child({ mod: "localize" });

export interface LocalizeResult {
  /** Erkannter Sprachcode des Anrufers (Kleinbuchstaben, z. B. "de", "en", "es"). */
  language: string;
  /**
   * Sprache, in der die Katalog-Werte verfasst sind. Wie `formality` eine erzwungene
   * Zwischenentscheidung: Das Modell muss die Ausgangssprache benennen, BEVOR es formuliert.
   * Nur Diagnose/Logging — der Code verzweigt bewusst nicht darauf.
   */
  catalogLanguage?: string;
  /**
   * Im Gespräch erkannte Anredeform. Das Modell muss sie BENENNEN, bevor es übersetzt —
   * die erzwungene Zwischenentscheidung macht die Register-Umsetzung deutlich stabiler
   * als eine implizite Anweisung. Nur Diagnose/Logging, steuert nichts.
   */
  formality?: "formal" | "informal";
  /** Ansagen unter denselben Katalog-Keys, in der Sprache und Anrede des Anrufers. */
  phrases?: Record<string, string>;
}

const SYSTEM_PROMPT = [
  "Du bist eine Lokalisierungs-Funktion für einen Telefon-Assistenten.",
  "Das JSON-Objekt CATALOG enthält die Ansagen des Assistenten, je unter einem Key.",
  "Du lieferst IMMER alle vier Felder. Es gibt keinen Fall, in dem du phrases weglässt oder",
  "die Formulierung überspringst — auch dann nicht, wenn die Sprachen übereinstimmen.",
  'SCHRITT 1 — "catalogLanguage": Bestätige die im CATALOG-Kopf genannte Ausgangssprache',
  "(Kleinbuchstaben-Sprachcode). Passt sie nicht zu den Werten, nenne die tatsächliche.",
  'SCHRITT 2 — "language": Die Sprache des ANRUFERS, ausschließlich aus den mit "caller:"',
  'markierten Zeilen. Die "agent:"-Zeilen sind nur Kontext für Anrede und Ton, NICHT für die',
  "Sprachbestimmung.",
  'SCHRITT 3 — "formality": Wie sprechen sich Anrufer und Assistent an? "informal" wenn geduzt',
  'wird (du/tu/tú — spanisch "puedes/quieres", italienisch "puoi/vuoi", französisch "tu peux"),',
  'sonst "formal". Achte auf die Verbformen, nicht nur auf Pronomen — in romanischen Sprachen',
  "steht das Pronomen meist gar nicht da. Im Zweifel: so, wie der Anrufer den Assistenten anspricht.",
  'SCHRITT 4 — "phrases": Formuliere JEDEN Katalog-Wert in der Sprache aus SCHRITT 2 und in der',
  'Anredeform aus SCHRITT 3 (bei "informal" durchgehend duzen: tú/tu-Formen, KEIN usted/lei/vous).',
  "Bedeutung und Interpunktion wahren, korrekte Rechtschreibung und Konjugation der Zielsprache.",
  "Der Sprecher ist IMMER der Assistent: behalte grammatische Person und Perspektive bei",
  "(1. Person Singular bleibt 1. Person Singular) und mache aus einer Aussage über eigenes",
  "Handeln NIEMALS eine Aufforderung an den Anrufer.",
  "Behalte die Keys EXAKT bei, füge keine hinzu und lasse keine weg.",
  'Antworte mit striktem JSON: {"catalogLanguage":"<code>","language":"<code>",',
  '"formality":"formal|informal","phrases":{<key>:<text>,…}}. Keine Prosa.',
].join(" ");

/**
 * Vorübersetzung eines Katalogs bei BEKANNTER Ausgangs- und Zielsprache (Agent-Speicherung,
 * Post-Call-Nachzug). Kein Erkennungsschritt und kein Gespräch — deshalb auch keine Anpassung
 * an den Anrufer: Die Anredeform wird aus dem Original übernommen, damit die Fassung für jeden
 * Anrufer taugt. Die register-adaptive Variante bleibt Sache von `detectAndLocalize` zur Laufzeit.
 *
 * `formality` ist wie dort ein erzwungener Zwischenschritt: Das Modell muss die Anredeform des
 * Originals BENENNEN, bevor es formuliert. Der Wert selbst ist nur Diagnose.
 */
const TRANSLATE_PROMPT = [
  "Du bist eine Übersetzungs-Funktion für die Ansagen eines Telefon-Assistenten.",
  "Das JSON-Objekt CATALOG enthält die Ansagen, je unter einem Key.",
  "Du lieferst IMMER beide Felder und IMMER jeden Key — es gibt keinen Fall, in dem du einen",
  "Wert unübersetzt lässt oder weglässt.",
  'SCHRITT 1 — "formality": Welche Anredeform verwendet das ORIGINAL? "informal" wenn geduzt',
  'wird (du/tu/tú), sonst "formal". Achte auf die Verbformen, nicht nur auf Pronomen.',
  'SCHRITT 2 — "phrases": Formuliere JEDEN Katalog-Wert in der Zielsprache, in der Anredeform',
  "aus SCHRITT 1. Bedeutung und Interpunktion wahren, korrekte Rechtschreibung und Konjugation",
  "der Zielsprache. Der Sprecher ist IMMER der Assistent: behalte grammatische Person und",
  "Perspektive bei (1. Person Singular bleibt 1. Person Singular) und mache aus einer Aussage",
  "über eigenes Handeln NIEMALS eine Aufforderung an den Anrufer.",
  "Eigennamen, Produkt- und Firmennamen bleiben unverändert.",
  "Behalte die Keys EXAKT bei, füge keine hinzu und lasse keine weg.",
  'Antworte mit striktem JSON: {"formality":"formal|informal","phrases":{<key>:<text>,…}}.',
  "Keine Prosa.",
].join(" ");

export async function translateCatalog(
  catalog: Record<string, string>,
  from: string,
  to: string,
  opts?: { model?: string; signal?: AbortSignal },
): Promise<Record<string, string>> {
  if (!Object.keys(catalog).length) return {};
  const model = opts?.model || config.localize.model;
  const raw = await chatJson(
    model,
    TRANSLATE_PROMPT,
    `Ausgangssprache: ${from}\nZielsprache: ${to}\n\nCATALOG = ${JSON.stringify(catalog)}`,
    opts?.signal,
  );
  return parseTranslateResponse(raw, catalog);
}

/**
 * Robustes Parsen der Übersetzungs-Antwort (exportiert für Tests). Wie bei `parseLocalizeResponse`
 * überleben nur bekannte Keys mit nicht-leerem String — halluzinierte Keys werden verworfen.
 * Fehlende Keys sind KEIN Fehler: Der Aufrufer merkt am Hash-Abgleich, was noch fehlt.
 */
export function parseTranslateResponse(
  raw: string,
  catalog: Record<string, string>,
): Record<string, string> {
  const text = extractJsonObject(raw);
  if (!text) throw new Error("translate: keine JSON-Antwort");
  const obj = JSON.parse(text) as { phrases?: unknown };
  const phrases: Record<string, string> = {};
  if (obj.phrases && typeof obj.phrases === "object") {
    for (const [key, val] of Object.entries(obj.phrases as Record<string, unknown>)) {
      if (key in catalog && typeof val === "string" && val.trim()) phrases[key] = val.trim();
    }
  }
  return phrases;
}

/**
 * Gemeinsamer Requesty-Aufruf für die JSON-Prompts dieses Moduls (temperature 0).
 * Exportiert, weil der Begrüßungs-Prompt (llm/greetingPrompt.ts) exakt dieselbe
 * Aufgabenklasse ist — ein One-Shot mit striktem JSON — und dieselbe Anbindung,
 * dasselbe Modell und dasselbe robuste Parsen nutzen soll, statt sie zu verdoppeln.
 */
export async function chatJson(
  model: string,
  system: string,
  user: string,
  signal?: AbortSignal,
): Promise<string> {
  const res = await fetch(`${config.llm.requestyBaseUrl.replace(/\/$/, "")}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${config.llm.requestyApiKey}`,
    },
    body: JSON.stringify({
      model,
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
      temperature: 0,
      max_tokens: 1000,
      // Best-effort — nicht jedes geroutete Modell honoriert es; das robuste Parsen fängt den Rest.
      response_format: { type: "json_object" },
    }),
    signal,
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    log.warn("Localize-Request fehlgeschlagen", { status: res.status, body });
    throw new Error(`Requesty ${res.status}`);
  }
  const json = (await res.json()) as ChatCompletionResponse;
  return json.choices?.[0]?.message?.content ?? "";
}

interface ChatCompletionResponse {
  choices?: Array<{ message?: { content?: string } }>;
}

/**
 * @param conversation rollenmarkierter Ausschnitt der letzten Turns ("caller: …" / "agent: …")
 * @param catalog Key → Default-Satz (Standardsprache)
 * @param opts.catalogLanguage Ausgangssprache des Katalogs (`agent.contentLanguage`). Wird dem
 *   Modell genannt, damit es sie nicht mehr erraten muss — der Bestätigungs-Schritt bleibt aber
 *   erhalten (siehe Datei-Kopf: der erzwungene Zwischenschritt trägt die Stabilität, nicht der Wert).
 */
export async function detectAndLocalize(
  conversation: string,
  catalog: Record<string, string>,
  opts?: { model?: string; signal?: AbortSignal; catalogLanguage?: string },
): Promise<LocalizeResult> {
  const model = opts?.model || config.localize.model;
  const src = opts?.catalogLanguage ? ` (Ausgangssprache: ${opts.catalogLanguage})` : "";
  const userContent = `CATALOG${src} = ${JSON.stringify(catalog)}\n\nGesprächsausschnitt:\n${conversation}`;

  const raw = await chatJson(model, SYSTEM_PROMPT, userContent, opts?.signal);
  return parseLocalizeResponse(raw, catalog);
}

/**
 * Robustes Parsen + Validierung gegen den Katalog (exportiert für Tests). Wirft bei
 * Unbrauchbarem — der CallLocalizer fängt das und behält die Default-Sätze.
 */
export function parseLocalizeResponse(raw: string, catalog: Record<string, string>): LocalizeResult {
  const text = extractJsonObject(raw);
  if (!text) throw new Error("localize: keine JSON-Antwort");
  const obj = JSON.parse(text) as {
    language?: unknown;
    catalogLanguage?: unknown;
    formality?: unknown;
    phrases?: unknown;
  };
  if (typeof obj.language !== "string" || !obj.language.trim() || obj.language.length > 8) {
    throw new Error("localize: ungültiges language-Feld");
  }
  const result: LocalizeResult = { language: obj.language.toLowerCase().trim() };
  if (
    typeof obj.catalogLanguage === "string" &&
    obj.catalogLanguage.trim() &&
    obj.catalogLanguage.length <= 8
  ) {
    result.catalogLanguage = obj.catalogLanguage.toLowerCase().trim();
  }
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
export function extractJsonObject(raw: string): string | null {
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
