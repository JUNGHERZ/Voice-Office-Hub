/**
 * Konfigurations-Overlay pro Anruf (0.9.0).
 *
 * Nach dem DDI-Treffer, aber VOR dem Answer, darf ein externer Dienst mitentscheiden:
 * den Anruf freigeben, auf eine kurze Ansage umleiten oder ablehnen — und dabei einen
 * Teil der Agent-Konfiguration für genau diesen Anruf ersetzen (typisch: der Systemprompt
 * mit eingesetzten Laufzeitwerten).
 *
 * Zwei Eigenschaften sind nicht verhandelbar:
 *   - **Fail-open.** Der Hook liegt auf dem Klingelpfad. Timeout, Verbindungsfehler,
 *     Nicht-200 oder unlesbare Antwort → der gespeicherte Agent gilt unverändert und der
 *     Anruf läuft. Ein Ausfall der Gegenstelle darf nicht alle Anschlüsse stumm schalten.
 *   - **Der Agent bleibt der gespeicherte Agent.** Das Overlay ersetzt Felder, nie die
 *     Identität: `id` entsteht ausschließlich aus dem Dokument (siehe applyOverlay).
 *
 * Ohne `RESOLVER_URL` entsteht kein ausgehender Verkehr und die Funktion ist inert.
 */
import { config } from "../config.js";
import { Agent } from "../db/models/Agent.js";
import type { ResolvedAgent } from "../types.js";
import { fetchWithTimeout } from "../util/http.js";
import { logger } from "../util/logger.js";
import { signBody } from "../util/signature.js";
import { applyOverlay, fromDoc } from "./agentResolver.js";

const log = logger.child({ mod: "callResolver" });

/** Was der Hook über den eingehenden Anruf erfährt. */
export interface ResolveContext {
  /** "web" = Anruf aus dem eingebetteten Widget (Widget-Token am Kanal), sonst "phone". */
  channel: "phone" | "web";
  /** ARI-Channel-ID. Zum Zeitpunkt des Hooks gibt es noch KEIN `requests`-Dokument. */
  channelId: string;
  targetNumber?: string;
  callerNumber?: string;
}

export interface ResolverOptions {
  url?: string;
  secret?: string;
  timeoutMs?: number;
  /**
   * Lädt das Agent-Dokument, auf das das Overlay gelegt wird. Nur nötig, wenn tatsächlich
   * ein Overlay ankommt — ein Lesevorgang, den der Normalbetrieb ohne Hook nie zahlt.
   * Injizierbar, damit die Tests ohne Datenbank auskommen.
   */
  loadDoc?: (id: string) => Promise<Record<string, any> | null>;
}

/**
 * Ergebnis der Entscheidung. `reject` ist bewusst eine eigene Form: „abgelehnt" darf nicht
 * mit „keine DDI-Zuordnung" (findAgent → null) verwechselt werden, sonst würde
 * `UNKNOWN_NUMBER_BEHAVIOR=agent` einen abgelehnten Anruf doch noch beantworten.
 */
export type CallResolution =
  | {
      kind: "run";
      agent: ResolvedAgent;
      /** Opake Kennung des Aufrufers; wird am Request vermerkt und in allen Ereignissen gespiegelt. */
      agentRef?: string;
      /** Fehlt, wenn kein Hook konfiguriert ist. */
      resolverStatus?: "ok" | "unavailable";
      /** false = kein `requests`-Dokument, keine Aufnahme, keine Ereignisse. */
      report: boolean;
      /** true = nur die Begrüßung ausspielen, danach auflegen. */
      announce: boolean;
    }
  | { kind: "reject" };

function passthrough(agent: ResolvedAgent, resolverStatus?: "ok" | "unavailable"): CallResolution {
  return { kind: "run", agent, report: true, announce: false, ...(resolverStatus ? { resolverStatus } : {}) };
}

export async function resolveOverlay(
  agent: ResolvedAgent,
  ctx: ResolveContext,
  opts: ResolverOptions = {},
): Promise<CallResolution> {
  const url = opts.url ?? config.resolver.url;
  if (!url) return passthrough(agent);

  const secret = opts.secret ?? config.resolver.secret;
  const timeoutMs = opts.timeoutMs ?? config.resolver.timeoutMs;
  // Einmal serialisieren: signiert und gesendet wird exakt dieselbe Zeichenkette.
  const body = JSON.stringify({
    event: "agent.resolve",
    channel: ctx.channel,
    agentId: agent.id,
    to: ctx.targetNumber,
    from: ctx.callerNumber,
    channelId: ctx.channelId,
    // Veraltet, nur aus Kompatibilität gesetzt: `callId` heißt im Custom-Tool-Envelope
    // die Request-_id — die es hier noch nicht gibt. Neue Empfänger lesen `channelId`.
    callId: ctx.channelId,
    receivedAt: new Date().toISOString(),
  });

  let answer: Record<string, any>;
  try {
    const res = await fetchWithTimeout(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(secret ? { "x-voh-signature": signBody(body, secret) } : {}),
      },
      body,
      timeoutMs,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    answer = (await res.json()) as Record<string, any>;
  } catch (err) {
    // Fail-open: der Aufrufer erkennt am resolverStatus, dass sein Overlay nicht griff.
    log.warn("Overlay-Hook nicht erreichbar — gespeicherter Agent gilt", {
      err: String(err),
      agent: agent.name,
    });
    return passthrough(agent, "unavailable");
  }

  const verdict = String(answer?.verdict ?? "");
  if (verdict === "reject") return { kind: "reject" };
  if (verdict !== "allow" && verdict !== "announce") {
    log.warn("Unbekanntes verdict — gespeicherter Agent gilt", { verdict });
    return passthrough(agent, "unavailable");
  }

  return {
    kind: "run",
    agent: await mergeOverlay(agent, answer.overlay, opts),
    ...(typeof answer.agentRef === "string" && answer.agentRef ? { agentRef: answer.agentRef } : {}),
    resolverStatus: "ok",
    report: answer.report !== false,
    announce: verdict === "announce",
  };
}

async function loadAgentDoc(id: string): Promise<Record<string, any> | null> {
  return (await Agent.findById(id).lean()) as Record<string, any> | null;
}

/**
 * Overlay anwenden. Der Weg führt über das gespeicherte Dokument und `fromDoc()`, damit
 * überlagerte Felder dieselben Normalisierungen und Defaults bekommen wie gespeicherte.
 */
async function mergeOverlay(
  agent: ResolvedAgent,
  overlay: unknown,
  opts: ResolverOptions,
): Promise<ResolvedAgent> {
  if (!overlay || typeof overlay !== "object" || !Object.keys(overlay).length) return agent;
  if (!agent.id) return agent; // Default-Agent hat kein Dokument — Hook läuft nur auf DB-Treffern.

  const doc = await (opts.loadDoc ?? loadAgentDoc)(agent.id).catch(() => null);
  if (!doc) {
    log.warn("Agent-Dokument nicht lesbar — Overlay verworfen", { agent: agent.name });
    return agent;
  }

  const { doc: merged, ignored } = applyOverlay(doc, overlay as Record<string, unknown>);
  // Einmal pro Anruf, nicht je Feld — und nie ein Abbruch: ein unbekannter Schlüssel ist
  // ein Vertragsfehler des Aufrufers, kein Grund, einen Anruf fallen zu lassen.
  if (ignored.length) log.warn("Overlay-Felder ignoriert", { keys: ignored, agent: agent.name });

  const resolved = fromDoc(merged);
  // Ausdrücklich leere Tool-Liste bleibt leer. `fromDoc` setzt bei leerem Array die
  // Defaults (transfer_call/end_call) — genau das würde eine reine Ansage aushebeln.
  const tools = (overlay as Record<string, unknown>).tools;
  if (Array.isArray(tools)) resolved.tools = tools.map(String);
  return resolved;
}
