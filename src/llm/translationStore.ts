/**
 * Vorübersetzte Ansagen: Erzeugung, Ablage und Aktualitätsprüfung.
 *
 * Das Greeting geht raus, BEVOR der Anrufer ein Wort gesagt hat — eine Laufzeit-Übersetzung
 * kommt dafür grundsätzlich zu spät. Deshalb wird der Katalog außerhalb des Anrufs übersetzt
 * und hier abgelegt; zur Laufzeit ist es ein Map-Lookup.
 *
 * ── Wie eine geänderte Ansage ihre Übersetzung entwertet ────────────────────────────────
 * Jeder Eintrag trägt den Hash seines Quelltextes. Bei jedem Laden wird gegen das aktuelle
 * Original geprüft; passt der Hash nicht, ist der Eintrag unbrauchbar und der Default-Satz
 * greift. Es gibt bewusst KEINEN Lösch-Hook auf dem Änderungspfad: Eine veraltete Übersetzung
 * kann so per Konstruktion nicht gesprochen werden — egal ob über Admin-UI, API, Seed-Script
 * oder direkt in der Datenbank geändert wurde. Ein aktiver Lösch-Pfad wäre dagegen ein
 * weiterer Ort, an dem genau ein vergessener Fall zu einem falsch gesprochenen Satz führt.
 *
 * Die Neuübersetzung (`ensureTranslations`) ist davon unabhängig und rein additiv: Sie stellt
 * Frische her, nicht Korrektheit. Fällt sie aus, spricht der Agent die Standardsprache.
 *
 * Die register-adaptive Fassung aus dem laufenden Gespräch (callLocalizer.ts) landet hier NIE —
 * sie ist an einen konkreten Anrufer angepasst (duzen/siezen) und taugt nicht für den nächsten.
 */
import { createHash } from "node:crypto";

import { config } from "../config.js";
import { AgentTranslation } from "../db/models/AgentTranslation.js";
import type { ResolvedAgent } from "../types.js";
import { logger } from "../util/logger.js";

import { buildLocalizationCatalog } from "./callLocalizer.js";
import { translateCatalog } from "./localize.js";

const log = logger.child({ mod: "translations" });

/** Gespeicherter Eintrag: Übersetzung plus Hash des Quelltextes, aus dem sie entstand. */
export interface StoredEntry {
  text: string;
  srcHash: string;
}

export function srcHash(text: string): string {
  return createHash("sha256").update(text).digest("hex").slice(0, 16);
}

/**
 * Aus den gespeicherten Einträgen die zum aktuellen Katalog passenden herausfiltern (rein).
 * Ein geänderter Quelltext entwertet genau seinen Eintrag — die übrigen bleiben gültig.
 */
export function usableEntries(
  catalog: Record<string, string>,
  entries: Record<string, StoredEntry>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, source] of Object.entries(catalog)) {
    const stored = entries[key];
    if (stored?.text && stored.srcHash === srcHash(source)) out[key] = stored.text;
  }
  return out;
}

/** Katalog-Keys, die (noch) keine gültige Übersetzung haben — fehlend oder veraltet (rein). */
export function staleKeys(
  catalog: Record<string, string>,
  entries: Record<string, StoredEntry>,
): string[] {
  return Object.keys(catalog).filter((key) => {
    const stored = entries[key];
    return !stored?.text || stored.srcHash !== srcHash(catalog[key]!);
  });
}

/** Sprechendes Label für die Admin-Anzeige — Katalog-Keys sind interne Bezeichner. */
export function catalogLabel(key: string): string {
  if (key === "greeting") return "Begrüßung";
  if (key === "transferFailed") return "Weiterleitung fehlgeschlagen";
  if (key === "idleHangup") return "Abschied vor dem Auflegen";
  const [pool, rest] = [key.slice(0, key.indexOf(".")), key.slice(key.indexOf(".") + 1)];
  if (pool === "filler") return `Filler-Ansage ${Number(rest) + 1}`;
  if (pool === "idle") return `Stille-Ansage ${Number(rest) + 1}`;
  if (pool === "tool") return `Tool-Ansage: ${rest}`;
  return key;
}

/** Katalog inklusive Greeting — die Vorübersetzung deckt genau das ab, was die Laufzeit nicht kann. */
export function translatableCatalog(agent: ResolvedAgent): Record<string, string> {
  return buildLocalizationCatalog(agent, { includeGreeting: true }).defaults;
}

// — Datenzugriff —

type EntryMap = Record<string, StoredEntry>;

/** Gespeicherte Form (Array, siehe AgentTranslation.ts) → Nachschlage-Form. */
export function toEntryMap(rows: Array<StoredEntry & { key?: string }> | undefined): EntryMap {
  const out: EntryMap = {};
  for (const row of rows ?? []) {
    if (row?.key && row.text && row.srcHash) out[row.key] = { text: row.text, srcHash: row.srcHash };
  }
  return out;
}

/** Nachschlage-Form → gespeicherte Form. Stabil sortiert, damit Diffs lesbar bleiben. */
export function toEntryRows(map: EntryMap): Array<StoredEntry & { key: string }> {
  return Object.keys(map)
    .sort()
    .map((key) => ({ key, text: map[key]!.text, srcHash: map[key]!.srcHash }));
}

/** Gespeicherte Einträge einer Sprache (roh, ungeprüft). */
export async function loadEntries(agentId: string, lang: string): Promise<EntryMap> {
  const doc = await AgentTranslation.findOne({ agentId, lang }).lean<{
    entries?: Array<StoredEntry & { key?: string }>;
  }>();
  return toEntryMap(doc?.entries);
}

/**
 * Verwendbare Übersetzungen einer Sprache — nur Einträge, deren Quelltext unverändert ist.
 * Wirft nie: Ohne Treffer bleibt es beim Default-Satz, der Anruf läuft normal weiter.
 */
export async function loadUsable(
  agent: ResolvedAgent,
  lang: string,
): Promise<Record<string, string>> {
  if (!agent.id || !lang) return {};
  try {
    const catalog = translatableCatalog(agent);
    return usableEntries(catalog, await loadEntries(agent.id, lang));
  } catch (err) {
    log.warn("Übersetzungen konnten nicht geladen werden", { lang, err: String(err) });
    return {};
  }
}

/** Läuft gerade eine Erzeugung? Verhindert doppelte LLM-Calls bei parallelen Anrufen. */
const inFlight = new Set<string>();

/**
 * Fehlende und veraltete Einträge einer Sprache nachziehen. Idempotent, im Hintergrund
 * aufzurufen (`void ensureTranslations(...)`), blockiert nie einen Anruf.
 */
export async function ensureTranslations(agent: ResolvedAgent, lang: string): Promise<void> {
  if (!agent.id || !lang || lang === agent.contentLanguage) return;
  if (!config.llm.requestyApiKey) return;

  const guard = `${agent.id}:${lang}`;
  if (inFlight.has(guard)) return;
  inFlight.add(guard);
  try {
    const catalog = translatableCatalog(agent);
    if (!Object.keys(catalog).length) return;
    const entries = await loadEntries(agent.id, lang);
    const missing = staleKeys(catalog, entries);
    if (!missing.length) return;

    // Nur die betroffenen Sätze übersetzen — Ansagen stehen je für sich, Kontext bringt nichts.
    const subset: Record<string, string> = {};
    for (const key of missing) subset[key] = catalog[key]!;
    const translated = await translateCatalog(subset, agent.contentLanguage, lang);

    const next: EntryMap = { ...entries };
    for (const [key, text] of Object.entries(translated)) {
      next[key] = { text, srcHash: srcHash(catalog[key]!) };
    }
    // Keys, die es im Katalog nicht mehr gibt (gelöschte Filler), fallen hier heraus.
    for (const key of Object.keys(next)) if (!(key in catalog)) delete next[key];

    await AgentTranslation.updateOne(
      { agentId: agent.id, lang },
      { $set: { entries: toEntryRows(next), model: config.localize.model } },
      { upsert: true },
    );
    log.info("Ansagen vorübersetzt", {
      agent: agent.name,
      lang,
      erneuert: Object.keys(translated).length,
      offen: missing.length - Object.keys(translated).length,
    });
  } catch (err) {
    log.warn("Vorübersetzung fehlgeschlagen — Standardsprache bleibt", { lang, err: String(err) });
  } finally {
    inFlight.delete(guard);
  }
}

/** Alle bereits erfassten Sprachen eines Agenten. */
export async function knownLanguages(agentId: string): Promise<string[]> {
  const docs = await AgentTranslation.find({ agentId }, { lang: 1 }).lean<Array<{ lang: string }>>();
  return docs.map((d) => d.lang);
}

/** Nach dem Speichern: alle bereits vorhandenen Sprachen auf den neuen Stand bringen. */
export async function refreshAllLanguages(agent: ResolvedAgent): Promise<void> {
  if (!agent.id) return;
  for (const lang of await knownLanguages(agent.id)) {
    await ensureTranslations(agent, lang);
  }
}
