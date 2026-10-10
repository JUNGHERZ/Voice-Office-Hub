/**
 * Ausstellen und Einlösen von Widget-Sitzungen (0.11.0).
 *
 * Zwei Prozesse, eine Datei: `issueWidgetSession` läuft im Admin-Prozess (Session-Endpoint),
 * `consumeWidgetSession` im Engine-Prozess (StasisStart). Beide Seiten müssen sich über
 * Format und Gültigkeit einig sein — deshalb steht beides hier und nicht je einmal dort.
 *
 * Siehe models/WidgetSession.ts für das Warum.
 */
import { randomBytes } from "node:crypto";

import { WidgetSession } from "./models/WidgetSession.js";

/** Warum ein INVITE nicht durchgelassen wurde — landet als `grund` im Log. */
export type AdmissionReason = "missing" | "unknown" | "expired" | "consumed" | "foreign-agent";

/** `lang`: Sprache des Besuchers, sofern sein Browser eine meldete (0.18.3). */
export type Admission = { ok: true; lang?: string } | { ok: false; reason: AdmissionReason };

/** Gespeicherte Sitzung, soweit das Einlösen sie braucht. */
export interface StoredSession {
  agentId?: unknown;
  consumedAt?: Date;
  expiresAt?: Date;
  lang?: string;
}

/**
 * Sprache des Besuchers als Primär-Subtag (`en-US` → `en`), oder `undefined`.
 *
 * Vorrang hat die ausdrücklich übergebene Angabe (das Widget sendet `navigator.language`,
 * ein Vermittler-Backend kann die seines Besuchers durchreichen). Ohne sie gilt der
 * `Accept-Language`-Header des Aufrufs — beim Fetch aus dem Widget ist das dieselbe
 * Browsereinstellung, bei einem Backend ohne Angabe fehlt er oder steht auf `*`.
 */
export function visitorLanguage(explicit?: string, acceptLanguage?: string): string | undefined {
  const primary = (tag: string): string | undefined => {
    const p = tag.trim().toLowerCase().split(/[-_]/)[0] ?? "";
    return /^[a-z]{2,3}$/.test(p) ? p : undefined;
  };
  if (explicit) return primary(explicit);
  if (!acceptLanguage) return undefined;
  // „de-DE,de;q=0.9,en;q=0.8" — nach Gewicht, nicht nach Reihenfolge.
  const ranked = acceptLanguage
    .split(",")
    .map((part, i) => {
      const [tag = "", ...params] = part.split(";");
      const q = params.map((x) => x.trim()).find((x) => x.startsWith("q="));
      return { tag: tag.trim(), q: q ? Number(q.slice(2)) : 1, i };
    })
    .filter((x) => x.tag && x.tag !== "*" && Number.isFinite(x.q) && x.q > 0)
    .sort((a, b) => b.q - a.q || a.i - b.i);
  for (const { tag } of ranked) {
    const lang = primary(tag);
    if (lang) return lang;
  }
  return undefined;
}

/**
 * Naht für Tests — in Produktion die `widgetSessions`-Collection.
 *
 * `claim` MUSS Prüfung und Verbrauch in einem Schritt erledigen (Mongo:
 * `findOneAndUpdate`); zwei getrennte Schritte ließen zwei gleichzeitige INVITEs mit
 * demselben Token beide durch.
 */
export interface SessionStore {
  create: (doc: {
    token: string;
    agentId: string;
    exten?: string;
    lang?: string;
    expiresAt: Date;
  }) => Promise<void>;
  /** Liefert die beanspruchte Sitzung (für die Besuchersprache) oder `null`. */
  claim: (token: string, agentId: string | undefined, now: Date) => Promise<StoredSession | null>;
  find: (token: string) => Promise<StoredSession | null>;
}

const defaultStore: SessionStore = {
  create: async (doc) => {
    await WidgetSession.create(doc);
  },
  claim: async (token, agentId, now) => {
    const claimed = await WidgetSession.findOneAndUpdate(
      {
        token,
        ...(agentId ? { agentId } : {}),
        consumedAt: { $exists: false },
        expiresAt: { $gt: now },
      },
      { $set: { consumedAt: now } },
    ).lean<StoredSession | null>();
    return claimed;
  },
  find: (token) => WidgetSession.findOne({ token }).lean<StoredSession | null>(),
};

/**
 * Prägt das Token für einen Anruf. 32 Hex-Zeichen aus `randomBytes` — dieselbe Form, die der
 * Transkript-Endpunkt seit jeher erwartet (TOKEN_PATTERN), und nicht erratbar.
 */
export async function issueWidgetSession(
  agentId: string,
  session: { exten?: string; lang?: string },
  ttlSec: number,
  now: number = Date.now(),
  store: SessionStore = defaultStore,
): Promise<string> {
  const token = randomBytes(16).toString("hex");
  await store.create({
    token,
    agentId,
    ...(session.exten ? { exten: session.exten } : {}),
    ...(session.lang ? { lang: session.lang } : {}),
    expiresAt: new Date(now + ttlSec * 1000),
  });
  return token;
}

/**
 * Löst eine Sitzung für genau ein INVITE ein.
 *
 * Anspruch und Verbrauch passieren in EINEM `findOneAndUpdate` — sonst kämen zwei
 * gleichzeitige INVITEs mit demselben Token beide durch, und der zweite wäre der Anruf, für
 * den niemand eine Sitzung geholt hat.
 *
 * Der Agent steht bewusst im Filter und nicht in einer Nachprüfung: Ein Anruf auf eine fremde
 * Durchwahl darf die Sitzung nicht verbrauchen. Sonst könnte, wer ein Token mitliest, damit
 * die Sitzung eines fremden Besuchers abräumen, ohne selbst je durchzukommen.
 */
export async function consumeWidgetSession(
  token: string | undefined,
  agentId: string | undefined,
  now: number = Date.now(),
  store: SessionStore = defaultStore,
): Promise<Admission> {
  if (!token) return { ok: false, reason: "missing" };

  const claimed = await store.claim(token, agentId, new Date(now));
  if (claimed) return { ok: true, ...(claimed.lang ? { lang: claimed.lang } : {}) };

  // Nichts beansprucht — warum, steht im Dokument, sofern es überhaupt (noch) eines gibt.
  const existing = await store.find(token);
  if (!existing) return { ok: false, reason: "unknown" };
  // Die fremde Durchwahl zuerst: Sie ist der aussagekräftigste Grund und der einzige, der
  // auf einen Missbrauchsversuch statt auf eine abgelaufene Sitzung hindeutet.
  if (agentId && String(existing.agentId) !== String(agentId)) {
    return { ok: false, reason: "foreign-agent" };
  }
  if (existing.consumedAt) return { ok: false, reason: "consumed" };
  return { ok: false, reason: "expired" };
}

/** In-Memory-Store für Tests — dieselbe Semantik, ohne Datenbank. */
export function memorySessionStore(): SessionStore & { size: () => number } {
  const rows = new Map<string, StoredSession & { token: string }>();
  return {
    size: () => rows.size,
    create: async (doc) => {
      rows.set(doc.token, { ...doc });
    },
    claim: async (token, agentId, now) => {
      const row = rows.get(token);
      if (!row) return null;
      if (agentId && String(row.agentId) !== String(agentId)) return null;
      if (row.consumedAt) return null;
      if (!row.expiresAt || row.expiresAt <= now) return null;
      row.consumedAt = now;
      return row;
    },
    find: async (token) => rows.get(token) ?? null,
  };
}
