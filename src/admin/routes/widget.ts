/**
 * Öffentliche Widget-Endpoints (bewusst OHNE requireAuth — die Absicherung läuft anders):
 *
 *   POST /api/widget/session     key-gebunden: liefert kurzlebige Verbindungsdaten
 *                                (WS-URL, SIP-Creds, Exten) NUR nach Key-/Origin-/Limit-Prüfung.
 *                                Erlaubt sind die Appliance selbst und die Origins aus
 *                                `widget.allowedOrigins` des Agenten (0.10.2).
 *   GET  /widget/:key            iframe-Seite des Widgets; setzt pro Agent den
 *                                CSP-frame-ancestors-Header (wer darf einbetten).
 *   GET  /api/widget/call/:token token-gebunden: Live-Transkript des laufenden Web-Anrufs.
 *
 * Threat-Model siehe docs/webrtc.md — Worst Case bei geleaktem SIP-Passwort ist "mit dem
 * KI-Agenten sprechen" (gleiche Exposure-Klasse wie die öffentliche Rufnummer), begrenzt
 * durch Kill-Switch, Rate-Limits, Concurrent-Cap und den dedizierten Dialplan-Context.
 */
import { readFileSync } from "node:fs";
import path from "node:path";

import type { FastifyInstance, FastifyRequest } from "fastify";

import { config } from "../../config.js";
import { Agent } from "../../db/models/Agent.js";
import { RequestModel } from "../../db/models/Request.js";
import { issueWidgetSession } from "../../db/widgetSessions.js";
import { logger } from "../../util/logger.js";
import { hasValidApiKey } from "../auth.js";
import { SlidingWindowLimiter } from "../rateLimit.js";

const log = logger.child({ mod: "widget" });

interface WidgetAgentDoc {
  _id?: unknown;
  name?: string;
  widget?: {
    enabled?: boolean;
    key?: string;
    exten?: string;
    allowedOrigins?: string[];
    showTranscript?: boolean;
  };
}

interface WidgetCallDoc {
  status?: string;
  endedAt?: Date | string;
  durationSec?: number;
  agentId?: unknown;
  transcript?: Array<{ t: number; speaker: string; text: string }>;
}

/** Injizierbare Datenzugriffe (Tests reichen Fakes ein; Produktion nutzt Mongoose). */
export interface WidgetRouteDeps {
  findByWidgetKey: (key: string) => Promise<WidgetAgentDoc | null>;
  /** Stellt das Anruf-Token aus (0.11.0) und gibt es zurück. */
  issueSession: (agentId: string, exten: string | undefined) => Promise<string>;
  countActiveWebCalls: () => Promise<number>;
  findCallByToken: (token: string) => Promise<WidgetCallDoc | null>;
  showTranscriptForAgent: (agentId: unknown) => Promise<boolean>;
  now: () => number;
}

export const defaultWidgetDeps: WidgetRouteDeps = {
  findByWidgetKey: (key) =>
    Agent.findOne({ "widget.key": key, "widget.enabled": true, enabled: true }).lean<WidgetAgentDoc>(),
  issueSession: (agentId, exten) => issueWidgetSession(agentId, exten, config.widget.sessionTtlSec),
  // Nutzt den Partial-Index auf in_progress; Web-Anrufe sind an der Caller-ID erkennbar.
  countActiveWebCalls: () =>
    RequestModel.countDocuments({ status: "in_progress", callerNumber: /^web-/ }),
  findCallByToken: (token) => RequestModel.findOne({ widgetToken: token }).lean<WidgetCallDoc>(),
  showTranscriptForAgent: async (agentId) => {
    if (!agentId) return false;
    const a = await Agent.findById(agentId, { "widget.showTranscript": 1 }).lean<WidgetAgentDoc>();
    return a?.widget?.showTranscript !== false;
  },
  now: () => Date.now(),
};

/** Nachlauf, in dem das Transkript nach Gesprächsende noch abrufbar bleibt. */
const CALL_GRACE_MS = 120_000;

/**
 * Darf dieser Origin eine Session für diesen Agenten holen? (0.10.2)
 *
 * `widget.allowedOrigins` steuert bisher nur die Einbettung (CSP `frame-ancestors`).
 * Dasselbe Feld gilt jetzt auch hier — sonst ließe sich das Widget nur auf der Appliance
 * selbst betreiben: Der Fetch aus einem fremd eingebetteten iframe trägt die Origin der
 * einbettenden Seite, und die wurde pauschal abgewiesen. Ein Feld, zwei Wirkungen, dieselbe
 * Liste — alles andere lädt dazu ein, eine der beiden zu vergessen.
 *
 * Die Semantik folgt bewusst der von CSP, weil die Einträge dort landen: `*.kunde.de` deckt
 * Unterdomänen ab, NICHT die Domäne selbst; Schema und Port müssen übereinstimmen. Ohne
 * diese Gleichheit lüde ein Eintrag, der die Einbettung erlaubt, still zu einem 403 ein.
 * Leere Liste = unverändertes Verhalten (nur die Appliance selbst).
 */
export function widgetOriginAllowed(origin: string, allowed: readonly string[] = []): boolean {
  const want = parseOrigin(origin);
  if (!want) return false;
  return allowed.some((raw) => {
    const entry = parseOrigin(raw);
    if (!entry) return false;
    if (entry.scheme !== want.scheme || entry.port !== want.port) return false;
    if (entry.host.startsWith("*.")) {
      // Nur echte Unterdomänen: Der führende Punkt im Suffix verhindert, dass
      // "boese-kunde.de" als Unterdomäne von "kunde.de" durchgeht, die Längenprüfung,
      // dass die Domäne selbst als eigene Unterdomäne zählt.
      const suffix = entry.host.slice(1); // "*.kunde.de" → ".kunde.de"
      return want.host.endsWith(suffix) && want.host.length > suffix.length;
    }
    return entry.host === want.host;
  });
}

/** `https://Host:8443/` → `{scheme, host, port}` in Kleinschreibung; sonst undefined. */
function parseOrigin(raw: string): { scheme: string; host: string; port: string } | undefined {
  const m = /^(https?):\/\/([^/\s:]+)(?::(\d+))?\/?$/i.exec(String(raw ?? "").trim());
  if (!m) return undefined;
  return { scheme: m[1]!.toLowerCase(), host: m[2]!.toLowerCase(), port: m[3] ?? "" };
}
const TOKEN_PATTERN = /^[a-f0-9]{16,64}$/;

export async function widgetRoutes(
  app: FastifyInstance,
  opts: { deps?: Partial<WidgetRouteDeps> } = {},
): Promise<void> {
  const deps: WidgetRouteDeps = { ...defaultWidgetDeps, ...opts.deps };
  const ipLimiter = new SlidingWindowLimiter(config.widget.sessionRatePerMinIp, 60_000, deps.now);
  const keyLimiter = new SlidingWindowLimiter(config.widget.sessionRatePerMinKey, 60_000, deps.now);
  const callLimiter = new SlidingWindowLimiter(60, 60_000, deps.now); // Transkript-Polling (2 s ⇒ 30/min)

  // Die iframe-Seite wird einmal gelesen und gecacht (Deployment-Artefakt, ändert sich nur mit dem Image).
  let widgetHtml: string | undefined;
  const loadWidgetHtml = (): string => {
    widgetHtml ??= readFileSync(path.join(process.cwd(), "widget-app", "index.html"), "utf8");
    return widgetHtml;
  };

  const applianceOrigin = (req: FastifyRequest): string =>
    `${req.protocol}://${String(req.headers.host ?? "")}`;

  // ── Session: Verbindungsdaten für einen Anruf ──────────────────────────────
  app.post(
    "/api/widget/session",
    {
      schema: {
        tags: ["widget"],
        summary: "Widget-Session (öffentlich, key-gebunden): Verbindungsdaten für einen Web-Anruf",
        body: {
          type: "object",
          properties: { key: { type: "string", minLength: 8, maxLength: 64 } },
          required: ["key"],
        },
      },
    },
    async (req, reply) => {
      if (!config.widget.enabled) return reply.code(404).send({ error: "not found" });

      const { key } = req.body as { key: string };
      // Ein authentifizierter Aufrufer ist ein Vermittler, kein Besucher: Holt ein Backend
      // die Sitzung (damit der Widget-Schlüssel den Browser nie erreicht), zählt der
      // IP-Deckel nicht mehr Besucher, sondern Worker — aus „10 pro Minute und Besucher"
      // würde „10 pro Minute für die ganze Appliance". Der Key hebt genau diesen Deckel auf,
      // nichts weiter: Key-Deckel, Kill-Switch, Origin-Prüfung und der Deckel für
      // gleichzeitige Anrufe bleiben. Ohne den Header ändert sich nichts.
      const broker = hasValidApiKey(req);
      if ((!broker && !ipLimiter.allow(req.ip)) || !keyLimiter.allow(key)) {
        return reply.code(429).send({ message: "Zu viele Anfragen — bitte kurz warten." });
      }

      // Der Agent muss VOR der Origin-Prüfung feststehen: Welche fremden Seiten das Widget
      // betreiben dürfen, steht an ihm. Rate-Limits greifen bereits davor, ein abgewiesener
      // Origin kostet also höchstens eine Suche über den indizierten Widget-Key.
      const agent = await deps.findByWidgetKey(key);
      if (!agent?.widget?.exten) return reply.code(404).send({ error: "not found" });

      // Same-origin (der Fetch aus dem iframe der Appliance selbst) oder eine Seite, die
      // der Agent ausdrücklich nennt. Alles andere ist ein Skript-Zugriff von außen.
      // Fehlt der Header ganz, bleibt es wie bisher bei „durchlassen" — er ist kein
      // Schutzmerkmal, sondern nur ein Hinweis des Browsers.
      const origin = req.headers.origin;
      if (
        origin &&
        origin !== applianceOrigin(req) &&
        !widgetOriginAllowed(origin, agent.widget.allowedOrigins)
      ) {
        return reply.code(403).send({ error: "forbidden" });
      }

      if (!config.widget.sipPassword) {
        log.warn("Widget-Session angefragt, aber WIDGET_SIP_PASSWORD fehlt (EMBED_ASTERISK=false?)");
        return reply.code(503).send({ message: "Widget ist auf diesem System nicht konfiguriert." });
      }

      const active = await deps.countActiveWebCalls();
      if (active >= config.widget.maxConcurrent) {
        return reply
          .code(429)
          .send({ message: "Zurzeit sind alle Web-Leitungen belegt. Bitte später erneut versuchen." });
      }

      // /ws läuft IMMER same-origin über den Admin-Port (Fastify proxyt an Asterisk) —
      // funktioniert damit hinter jedem Single-Port-TLS-Proxy ohne Sonderrouten.
      const host = String(req.headers.host ?? "");
      const hostname = host.split(":")[0] ?? host;
      const wsUrl =
        config.widget.wsUrlOverride ||
        `${req.protocol === "https" ? "wss" : "ws"}://${host}/ws`;

      // Das Token für genau diesen Anruf (0.11.0). Der Client setzt es als SIP-Header
      // `X-Widget-Token`; die Engine lässt das INVITE nur durch, wenn es hier ausgestellt
      // wurde, noch gilt und zu diesem Agenten gehört. Ohne den Session-Endpoint kommt
      // damit kein Web-Anruf mehr zustande, auch nicht mit gültigem SIP-Passwort.
      const callToken = await deps.issueSession(String(agent._id), agent.widget.exten);

      return {
        wsUrl,
        domain: hostname,
        exten: agent.widget.exten,
        callToken,
        authUser: config.widget.sipUser,
        authPassword: config.widget.sipPassword,
        iceServers: [{ urls: config.widget.stunServer }],
        showTranscript: agent.widget.showTranscript !== false,
        agentName: agent.name ?? "",
      };
    },
  );

  // ── iframe-Seite mit Embed-Schutz ─────────────────────────────────────────
  app.get(
    "/widget/:key",
    { schema: { tags: ["widget"], summary: "Widget-Seite (iframe-Inhalt) mit frame-ancestors-CSP" } },
    async (req, reply) => {
      const { key } = req.params as { key: string };
      const agent = config.widget.enabled ? await deps.findByWidgetKey(key) : null;
      if (!agent) {
        return reply
          .code(404)
          .type("text/html; charset=utf-8")
          .send("<!doctype html><meta charset=utf-8><title>Nicht gefunden</title><p style=\"font-family:system-ui;padding:24px\">Dieses Widget ist nicht (mehr) verfügbar.</p>");
      }
      const ancestors = ["'self'", ...(agent.widget?.allowedOrigins ?? [])].join(" ");
      return reply
        .header("content-security-policy", `frame-ancestors ${ancestors}`)
        .type("text/html; charset=utf-8")
        .send(loadWidgetHtml());
    },
  );

  // ── Live-Transkript (token-gebunden) ──────────────────────────────────────
  app.get(
    "/api/widget/call/:token",
    { schema: { tags: ["widget"], summary: "Live-Transkript eines Web-Anrufs (öffentlich, token-gebunden)" } },
    async (req, reply) => {
      if (!config.widget.enabled) return reply.code(404).send({ error: "not found" });
      const { token } = req.params as { token: string };
      if (!TOKEN_PATTERN.test(token) || !callLimiter.allow(req.ip)) {
        return reply.code(404).send({ error: "not found" });
      }

      const call = await deps.findCallByToken(token);
      if (!call) return reply.code(404).send({ error: "not found" });

      if (call.status !== "in_progress") {
        const endedAt = call.endedAt ? new Date(call.endedAt).getTime() : 0;
        if (!endedAt || deps.now() - endedAt > CALL_GRACE_MS) {
          return reply.code(404).send({ error: "not found" });
        }
      }

      if (!(await deps.showTranscriptForAgent(call.agentId))) {
        return reply.code(404).send({ error: "not found" });
      }

      return {
        status: call.status,
        durationSec: call.durationSec,
        transcript: (call.transcript ?? []).map((turn) => ({
          t: turn.t,
          speaker: turn.speaker,
          text: turn.text,
        })),
      };
    },
  );
}
