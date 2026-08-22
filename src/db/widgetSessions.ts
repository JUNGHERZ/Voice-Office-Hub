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

export type Admission = { ok: true } | { ok: false; reason: AdmissionReason };

/** Gespeicherte Sitzung, soweit das Einlösen sie braucht. */
export interface StoredSession {
  agentId?: unknown;
  consumedAt?: Date;
  expiresAt?: Date;
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
    expiresAt: Date;
  }) => Promise<void>;
  claim: (token: string, agentId: string | undefined, now: Date) => Promise<boolean>;
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
    ).lean<{ _id: unknown } | null>();
    return !!claimed;
  },
  find: (token) => WidgetSession.findOne({ token }).lean<StoredSession | null>(),
};

/**
 * Prägt das Token für einen Anruf. 32 Hex-Zeichen aus `randomBytes` — dieselbe Form, die der
 * Transkript-Endpunkt seit jeher erwartet (TOKEN_PATTERN), und nicht erratbar.
 */
export async function issueWidgetSession(
  agentId: string,
  exten: string | undefined,
  ttlSec: number,
  now: number = Date.now(),
  store: SessionStore = defaultStore,
): Promise<string> {
  const token = randomBytes(16).toString("hex");
  await store.create({
    token,
    agentId,
    ...(exten ? { exten } : {}),
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

  if (await store.claim(token, agentId, new Date(now))) return { ok: true };

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
      if (!row) return false;
      if (agentId && String(row.agentId) !== String(agentId)) return false;
      if (row.consumedAt) return false;
      if (!row.expiresAt || row.expiresAt <= now) return false;
      row.consumedAt = now;
      return true;
    },
    find: async (token) => rows.get(token) ?? null,
  };
}
