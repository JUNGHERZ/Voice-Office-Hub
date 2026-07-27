/**
 * Anrufer-Gedächtnis: merkt sich je Rufnummer die zuletzt bestätigte Gesprächssprache, damit
 * die BEGRÜSSUNG beim nächsten Anruf sitzt. Sie geht raus, bevor der Anrufer ein Wort gesagt
 * hat — jede Erkennung im Gespräch kommt dafür zu spät, es braucht Wissen von vorher.
 *
 * ── Warum Bestätigung und Widerspruch verschieden zählen ────────────────────────────────
 * Begrüßen wir auf Englisch, antwortet der Anrufer eher auf Englisch — auch wenn ihm Deutsch
 * lieber wäre. Würden wir das als Bestätigung lernen, zementierte sich ein einmaliger Fehlgriff
 * für immer. Deshalb: Widerspruch überschreibt sofort, Bestätigung zählt nur hoch. Aus einer
 * falschen Zuordnung kommt man so mit einem einzigen Anruf wieder heraus — was zugleich das
 * Problem geteilter Anschlüsse (Firmenzentrale, Familienanschluss) entschärft.
 *
 * Gespeichert wird auch die Standardsprache. Ohne diesen Rückweg bliebe ein einmal gesetztes
 * fremdsprachiges Profil für immer stehen.
 */
import { createHmac } from "node:crypto";

import { config } from "../config.js";
import { CallerProfile } from "../db/models/CallerProfile.js";
import type { ResolvedAgent } from "../types.js";
import { logger } from "../util/logger.js";
import { looksExternal, toSipgateCli } from "../util/phone.js";

const log = logger.child({ mod: "callerProfile" });

/**
 * Pseudonym für eine Rufnummer, oder `null`, wenn sie sich nicht als Wiedererkennungsmerkmal
 * eignet. Ausgeschlossen sind Web-Anrufe (Token ist pro Anruf einmalig → nie ein zweiter
 * Treffer), interne Durchwahlen und unterdrückte Nummern.
 *
 * Normalisierung über `toSipgateCli()`: `0176…` → `49176…`, `+49…`/`0049…` → `49…`. Damit
 * matchen nationale und internationale Schreibweise derselben Nummer auf denselben Schlüssel.
 * Die Annahme „führende 0 = deutsche Nummer" steckt in dieser Funktion und gilt hier mit.
 */
export function callerKey(callerNumber: string | undefined): string | null {
  if (!config.callerProfile.secret) return null;
  const raw = (callerNumber ?? "").trim();
  if (!raw || raw.startsWith("web-") || /anonymous|unknown|restricted/i.test(raw)) return null;
  if (!looksExternal(raw)) return null;
  const normalized = toSipgateCli(raw);
  if (!normalized) return null;
  return createHmac("sha256", config.callerProfile.secret).update(normalized).digest("hex");
}

/** Ist das Gedächtnis für diesen Agenten scharf? (Opt-in + Secret + gespeicherte Agent-ID) */
export function memoryActive(agent: ResolvedAgent): boolean {
  return !!(agent.callerMemory?.language && config.callerProfile.secret && agent.id);
}

export interface CallerPrior {
  lang: string;
  source: "profile";
}

/**
 * Bekannte Sprache dieser Nummer — der einzige Prior, der eine gemessene Sprache liefert
 * statt einer Vermutung. Wirft nie: Ohne Treffer läuft der Anruf wie bisher.
 */
export async function lookupLanguage(
  agent: ResolvedAgent,
  callerNumber: string | undefined,
): Promise<CallerPrior | null> {
  if (!memoryActive(agent)) return null;
  const key = callerKey(callerNumber);
  if (!key) return null;
  try {
    const doc = await CallerProfile.findOne(
      { agentId: agent.id, callerKey: key },
      { facts: 1, source: 1 },
    ).lean<{ facts?: { language?: string }; source?: string }>();
    // Scorer-Werte steuern keine Begrüßung — dafür ist die Heuristik zu grob.
    if (!doc?.facts?.language || doc.source !== "llm") return null;
    return { lang: doc.facts.language, source: "profile" };
  } catch (err) {
    log.warn("Profil-Lookup fehlgeschlagen", { err: String(err) });
    return null;
  }
}

/**
 * Die Lernregel als reine Funktion — der Kern des Ganzen, deshalb getrennt vom Datenzugriff.
 *
 *  - `confirm`: Der Anrufer ist der Sprache gefolgt, die WIR vorgegeben haben. Das ist keine
 *    freie Entscheidung und darf nicht als neues Wissen zählen, sonst zementiert ein
 *    einmaliger Fehlgriff sich selbst. Nur mitzählen.
 *  - `write`: Kein Prior (freie Wahl) oder Widerspruch (bewusster Wechsel) — beides ist ein
 *    echtes Signal und überschreibt sofort.
 *
 * Auch die Standardsprache wird geschrieben: Ohne diesen Rückweg bliebe ein einmal gesetztes
 * fremdsprachiges Profil für immer stehen.
 */
export function learnAction(lang: string, priorLang?: string): "confirm" | "write" {
  return priorLang && priorLang === lang ? "confirm" : "write";
}

/**
 * Nach dem Gespräch festhalten, was der Anrufer tatsächlich gesprochen hat.
 *
 * @param lang    LLM-bestätigte Gesprächssprache
 * @param priorLang Sprache, mit der der Anruf vorbelegt war (falls ein Prior griff)
 */
export async function rememberLanguage(
  agent: ResolvedAgent,
  callerNumber: string | undefined,
  lang: string,
  priorLang?: string,
): Promise<void> {
  if (!memoryActive(agent) || !lang) return;
  const key = callerKey(callerNumber);
  if (!key) return;

  try {
    if (learnAction(lang, priorLang) === "confirm") {
      await CallerProfile.updateOne(
        { agentId: agent.id, callerKey: key },
        { $inc: { confirmations: 1 }, $set: { updatedAt: new Date() } },
      );
      return;
    }
    await CallerProfile.updateOne(
      { agentId: agent.id, callerKey: key },
      { $set: { "facts.language": lang, source: "llm", confirmations: 1 } },
      { upsert: true },
    );
    log.info("Sprache im Anrufer-Profil hinterlegt", {
      agent: agent.name,
      lang,
      ...(priorLang ? { widerspruchZu: priorLang } : {}),
    });
  } catch (err) {
    log.warn("Profil-Schreiben fehlgeschlagen", { err: String(err) });
  }
}
