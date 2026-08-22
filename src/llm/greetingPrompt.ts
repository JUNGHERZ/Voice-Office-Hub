/**
 * Begrüßungs-Prompt (0.10.0): Statt eines festen Begrüßungstexts kann ein Agent eine
 * ANWEISUNG hinterlegen, aus der der Eröffnungssatz je Anruf entsteht — „Guten Morgen /
 * Guten Tag / Guten Abend" je nach Uhrzeit, mit Firmennamen, später mit Anrede.
 *
 * Arbeitsteilung: Der Inhalt kommt von außen (am Agenten oder aus dem Overlay), die
 * SPRACHE bestimmt die Engine. Bis der Anrufer spricht, ist der `CallerProfile`-Prior die
 * einzige Quelle dafür — und der bleibt pseudonymisiert in der Appliance. Deshalb wandert
 * der Prompt herein, nicht die Sprache hinaus.
 *
 * Kein Cache: Ein pro Anruf wechselnder Text träfe den Übersetzungs-Cache
 * (`AgentTranslation`, Schlüssel `(agentId, lang)` samt Quelltext-Hash) ohnehin nie.
 *
 * Scheitert die Erzeugung, gilt der statische `greeting`-Text. Er ist ab hier nicht mehr
 * der Normalfall, sondern das Sicherheitsnetz — und bleibt deshalb bestehen.
 */
import { chatJson, extractJsonObject } from "./localize.js";
import { config } from "../config.js";
import { logger } from "../util/logger.js";
import { sanitizeForSpeech } from "../native/speechText.js";

const log = logger.child({ mod: "greetingPrompt" });

const SYSTEM_PROMPT = [
  "Du formulierst den Eröffnungssatz eines Telefon-Assistenten.",
  "Der Anrufer hat gerade abgehoben bekommen und hat noch nichts gesagt.",
  "Die ANWEISUNG beschreibt, was der Assistent sagen soll; setze sie wörtlich um und",
  "erfinde keine Angaben dazu (keine Namen, Firmen, Uhrzeiten oder Angebote, die dort",
  "nicht stehen).",
  "Sprich als der Assistent, in der ersten Person, in der angegebenen SPRACHE.",
  "GENAU EIN Satz, höchstens zwei kurze — es ist eine Begrüßung, kein Monolog.",
  "Kein Anführungszeichen, keine Regieanweisung, keine Aufzählung, kein Emoji.",
  'Antworte mit striktem JSON: {"greeting":"<Satz>"}. Keine Prosa.',
].join(" ");

/**
 * Erzeugt den Begrüßungssatz. Liefert `undefined`, wenn das Modell nichts Brauchbares
 * lieferte — der Aufrufer fällt dann auf den statischen Text zurück.
 *
 * `signal` ist Pflicht im Anrufpfad: Der Aufruf läuft, während der Anrufer noch Rufton
 * hört. Legt er auf, muss er abgebrochen werden — sonst zahlt jeder Klingelabbrecher ein
 * Modell, und bei einem Anschluss mit vielen Auflegern läuft eine Rechnung für Gespräche,
 * die nie stattgefunden haben.
 */
export async function generateGreeting(
  prompt: string,
  language: string,
  opts?: { model?: string; signal?: AbortSignal },
): Promise<string | undefined> {
  const instruction = prompt.trim();
  if (!instruction) return undefined;
  const model = opts?.model || config.localize.model;

  const raw = await chatJson(
    model,
    SYSTEM_PROMPT,
    `SPRACHE: ${language}\n\nANWEISUNG: ${instruction}`,
    opts?.signal,
  );
  return parseGreetingResponse(raw);
}

/**
 * Robustes Parsen (exportiert für Tests). Wie bei den Übersetzungs-Antworten überlebt nur
 * ein nicht-leerer String; alles andere gilt als „nichts geliefert" und führt beim
 * Aufrufer zum statischen Text. Zeilenumbrüche werden geglättet — der Satz geht direkt in
 * die Sprachsynthese.
 */
export function parseGreetingResponse(raw: string): string | undefined {
  const text = extractJsonObject(raw);
  if (!text) {
    log.warn("Begrüßung: keine JSON-Antwort");
    return undefined;
  }
  let obj: { greeting?: unknown };
  try {
    obj = JSON.parse(text) as { greeting?: unknown };
  } catch {
    log.warn("Begrüßung: Antwort nicht lesbar");
    return undefined;
  }
  if (typeof obj.greeting !== "string") return undefined;
  // Auch hier geputzt (0.11.2): Der Satz kommt aus einem Modell und geht direkt in die
  // Synthese — beim gebündelten Voice-Provider sogar an der einzigen Stelle vorbei, an der
  // die Engine sonst noch eingreifen könnte. Was hier steht, ist zugleich das, was als
  // `greetingText` am Gespräch protokolliert wird: gesprochen wurde genau dieser Satz.
  const greeting = sanitizeForSpeech(obj.greeting).replace(/\s+/g, " ").trim();
  return greeting || undefined;
}
