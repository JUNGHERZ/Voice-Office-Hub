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

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

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
  /**
   * Mehrere Gespräche in EINER Abfrage (0.11.1). Der Strom-Ticker fragt damit alle offenen
   * Ströme zusammen nach — eine Abfrage je Takt, nicht eine je Strom. Sonst skalierte der
   * Aufwand mit der Zahl der Zuschauer, und der Deckel für gleichzeitige Web-Anrufe hält
   * die nicht.
   */
  findCallsByTokens: (tokens: string[]) => Promise<Array<WidgetCallDoc & { widgetToken: string }>>;
  /**
   * Widget-Einstellungen des Agenten, an dem ein Gespräch hängt: ob das Transkript gezeigt
   * werden darf UND welche Seiten es abrufen dürfen. Eine Abfrage statt zweier — beide
   * Antworten kommen aus demselben Dokument.
   */
  widgetSettingsForAgent: (agentId: unknown) => Promise<{
    showTranscript: boolean;
    allowedOrigins: string[];
  }>;
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
  findCallsByTokens: (tokens) =>
    RequestModel.find(
      { widgetToken: { $in: tokens } },
      { widgetToken: 1, status: 1, endedAt: 1, durationSec: 1, transcript: 1 },
    ).lean<Array<WidgetCallDoc & { widgetToken: string }>>(),
  widgetSettingsForAgent: async (agentId) => {
    if (!agentId) return { showTranscript: false, allowedOrigins: [] };
    const a = await Agent.findById(agentId, {
      "widget.showTranscript": 1,
      "widget.allowedOrigins": 1,
    }).lean<WidgetAgentDoc>();
    return {
      showTranscript: a?.widget?.showTranscript !== false,
      allowedOrigins: a?.widget?.allowedOrigins ?? [],
    };
  },
  now: () => Date.now(),
};

/** Nachlauf, in dem das Transkript nach Gesprächsende noch abrufbar bleibt. */
const CALL_GRACE_MS = 120_000;
/** Kommentar-Herzschlag des Transkript-Stroms (Proxys mit Leerlauf-Timeout). */
const HEARTBEAT_MS = 20_000;
/** Anlaufzeit des Stroms: Der Gesprächsdatensatz entsteht in einem anderen Prozess. */
const STREAM_WARMUP_MS = 200;
const STREAM_WARMUP_TRIES = 10;

/** Ein offener Transkript-Strom. `sent` = Zahl der bereits geschickten Turns. */
interface StreamClient {
  token: string;
  sent: number;
  write: (chunk: string) => void;
  close: () => void;
}

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

/**
 * CORS für die öffentlichen Widget-Endpunkte (0.11.1).
 *
 * Ohne diese Kopfzeile ist ein Endpunkt aus einer fremden Seite heraus **nicht** nutzbar —
 * der Browser hält die Antwort zurück, egal was serverseitig erlaubt wurde. Das eigene
 * Widget merkt davon nichts, weil es same-origin im iframe der Appliance läuft; genau der
 * Fall, den die Origin-Freigabe aus 0.10.2 geöffnet hat, lief also weiterhin ins Leere.
 *
 * Freigegeben wird nach derselben Liste wie alles andere am Widget: `widget.allowedOrigins`
 * des zugehörigen Agenten. `Vary: Origin`, weil die Antwort damit vom Anfrage-Header abhängt
 * und ein Cache sie sonst dem falschen Aufrufer ausliefert. Keine Credentials — die
 * Endpunkte sind token- bzw. key-gebunden und brauchen kein Cookie.
 */
function allowCrossOrigin(
  reply: FastifyReply,
  origin: string | undefined,
  allowed: readonly string[] | undefined,
): void {
  if (!origin || !widgetOriginAllowed(origin, allowed ?? [])) return;
  reply.header("access-control-allow-origin", origin);
  reply.header("vary", "Origin");
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

      // Erst hier steht fest, dass dieser Origin für diesen Agenten freigegeben ist — ohne
      // die Kopfzeile könnte ein Browser die Antwort nicht lesen (0.11.1).
      allowCrossOrigin(reply, origin, agent.widget.allowedOrigins);

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

  /**
   * Preflight des Session-Endpunkts (0.11.1). Ein POST mit `application/json` löst ihn aus.
   *
   * Hier ist der Widget-Schlüssel noch unbekannt — ein Preflight trägt keinen Rumpf —, also
   * kann die Freigabe nicht agentengenau entschieden werden. Das ist unbedenklich: Die
   * Vorabfrage gibt keine Daten heraus. Ob der Aufrufer die eigentliche Antwort lesen darf,
   * entscheidet deren eigene Kopfzeile, und die kennt den Agenten.
   */
  app.options("/api/widget/session", { schema: { hide: true } }, async (req, reply) => {
    const origin = req.headers.origin;
    if (!origin) return reply.code(204).send();
    return reply
      .header("access-control-allow-origin", origin)
      .header("access-control-allow-methods", "POST, OPTIONS")
      .header("access-control-allow-headers", "content-type, x-api-key")
      .header("access-control-max-age", "600")
      .header("vary", "Origin")
      .code(204)
      .send();
  });

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

  // ── Live-Transkript als Strom (SSE, 0.11.1) ───────────────────────────────
  //
  // Warum SSE und nicht WebSocket: Es ist eine Einbahnstraße, es ist gewöhnliches HTTP —
  // läuft also über denselben Port und denselben TLS-Proxy wie alles andere, ohne neue
  // Route-Klasse — und `EventSource` bringt Reconnect samt `Last-Event-ID` mit, sodass der
  // vorhandene Polling-Endpunkt der natürliche Rückfall bleibt (er ist unverändert).
  //
  // Warum ein Ticker statt eines Fan-outs an der Schreibstelle: Die Turns entstehen im
  // Engine-Prozess (dist/index.js), dieser Endpunkt lebt im Admin-Prozess — ein
  // EventEmitter an `appendTranscript` erreicht ihn nicht. Ein Takt über die Datenbank ist
  // hier das Einfachste, das trägt: EINE Abfrage je Takt für ALLE Ströme, und er heilt
  // sich nach einem Neustart von selbst.
  const streams = new Map<number, StreamClient>();
  let streamSeq = 0;
  let ticker: NodeJS.Timeout | undefined;

  async function tick(): Promise<void> {
    if (!streams.size) return stopTicker();
    const tokens = [...new Set([...streams.values()].map((c) => c.token))];
    let calls: Array<WidgetCallDoc & { widgetToken: string }>;
    try {
      calls = await deps.findCallsByTokens(tokens);
    } catch (err) {
      log.warn("Transkript-Strom: Nachlesen fehlgeschlagen", { err: String(err) });
      return;
    }
    const byToken = new Map(calls.map((c) => [c.widgetToken, c]));
    for (const client of streams.values()) {
      const call = byToken.get(client.token);
      if (!call) continue;
      const turns = call.transcript ?? [];
      for (let i = client.sent; i < turns.length; i++) {
        const t = turns[i]!;
        client.write(`id: ${i}\nevent: turn\ndata: ${JSON.stringify(t)}\n\n`);
      }
      client.sent = Math.max(client.sent, turns.length);
      // Ende: Status melden und schließen. Der Nachlauf des Polling-Endpunkts wird hier
      // nicht gebraucht — wer nachlesen will, holt sich das fertige Transkript dort.
      if (call.status && call.status !== "in_progress") {
        client.write(`event: status\ndata: ${JSON.stringify({ status: call.status })}\n\n`);
        client.close();
      }
    }
  }

  function startTicker(): void {
    if (ticker) return;
    ticker = setInterval(() => void tick(), config.widget.streamIntervalMs);
    ticker.unref?.();
  }
  function stopTicker(): void {
    if (!ticker) return;
    clearInterval(ticker);
    ticker = undefined;
  }
  app.addHook("onClose", async () => {
    for (const c of [...streams.values()]) c.close();
    stopTicker();
  });

  app.get(
    "/api/widget/call/:token/stream",
    {
      schema: {
        tags: ["widget"],
        summary: "Live-Transkript als Server-Sent-Events (öffentlich, token-gebunden)",
      },
    },
    async (req, reply) => {
      if (!config.widget.enabled) return reply.code(404).send({ error: "not found" });
      const { token } = req.params as { token: string };
      if (!TOKEN_PATTERN.test(token) || !callLimiter.allow(req.ip)) {
        return reply.code(404).send({ error: "not found" });
      }
      if (streams.size >= config.widget.streamMax) {
        return reply.code(503).send({ message: "Zurzeit keine freien Ströme." });
      }

      // Dieselben Torwächter wie beim Polling-Endpunkt — ein Strom darf nicht das
      // schwächere Tor sein. Einzige Abweichung: eine kurze Anlaufzeit. Das Widget öffnet
      // den Strom, sobald das Gespräch steht — und der Gesprächsdatensatz entsteht im
      // Engine-Prozess im selben Moment. Ein 404 aus diesem Wettrennen würde den Client
      // dauerhaft auf das Polling zurückfallen lassen, obwohl alles in Ordnung ist. Das
      // Polling hat für denselben Fall einfach seinen nächsten Takt.
      let call = await deps.findCallByToken(token);
      for (let i = 0; !call && i < STREAM_WARMUP_TRIES; i++) {
        await new Promise((r) => setTimeout(r, STREAM_WARMUP_MS));
        call = await deps.findCallByToken(token);
      }
      if (!call) return reply.code(404).send({ error: "not found" });
      if (call.status !== "in_progress") {
        const endedAt = call.endedAt ? new Date(call.endedAt).getTime() : 0;
        if (!endedAt || deps.now() - endedAt > CALL_GRACE_MS) {
          return reply.code(404).send({ error: "not found" });
        }
      }
      const settings = await deps.widgetSettingsForAgent(call.agentId);
      if (!settings.showTranscript) return reply.code(404).send({ error: "not found" });
      allowCrossOrigin(reply, req.headers.origin, settings.allowedOrigins);

      // Ab hier gehört die Antwort uns: Fastify soll sie weder serialisieren noch beenden.
      reply.hijack();
      const res = reply.raw;
      res.writeHead(200, {
        "content-type": "text/event-stream; charset=utf-8",
        // `no-transform` ist der wichtigere Teil: Ein komprimierender Proxy würde puffern
        // und damit genau die Sofortigkeit zunichtemachen, für die es den Strom gibt.
        "cache-control": "no-cache, no-transform",
        connection: "keep-alive",
        "x-accel-buffering": "no",
        ...(reply.getHeader("access-control-allow-origin")
          ? {
              "access-control-allow-origin": String(reply.getHeader("access-control-allow-origin")),
              vary: "Origin",
            }
          : {}),
      });

      // Kopfzeilen SOFORT rausschicken. Ohne das hält Node sie zurück, bis der erste Turn
      // geschrieben wird — und ein Strom, der vor dem ersten Wort geöffnet wird (der
      // Normalfall: das Widget öffnet ihn beim Anrufaufbau), bliebe für den Browser
      // minutenlang im Zustand „verbindet". Die Kommentarzeile hinterher drückt zusätzlich
      // puffernde Proxys über ihre Mindestmenge.
      res.flushHeaders();
      res.write(": verbunden\n\n");

      const id = ++streamSeq;
      // `Last-Event-ID` schickt der Browser beim automatischen Reconnect mit: Der Strom
      // setzt hinter dem zuletzt gesehenen Turn fort, statt alles zu wiederholen.
      const lastSeen = Number.parseInt(String(req.headers["last-event-id"] ?? ""), 10);
      const client: StreamClient = {
        token,
        sent: Number.isFinite(lastSeen) && lastSeen >= 0 ? lastSeen + 1 : 0,
        write: (chunk) => {
          if (!res.writableEnded) res.write(chunk);
        },
        close: () => {
          streams.delete(id);
          if (!res.writableEnded) res.end();
          if (!streams.size) stopTicker();
        },
      };
      streams.set(id, client);
      req.raw.on("close", () => client.close());

      // Herzschlag als Kommentarzeile: hält die Verbindung durch Proxys mit Leerlauf-Timeout
      // und kostet nichts.
      const beat = setInterval(() => client.write(": ping\n\n"), HEARTBEAT_MS);
      beat.unref?.();
      req.raw.on("close", () => clearInterval(beat));

      startTicker();
      // Der erste Takt sofort, damit der Verbindungsaufbau nicht schon eine Taktlänge kostet.
      void tick();
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

      const settings = await deps.widgetSettingsForAgent(call.agentId);
      if (!settings.showTranscript) return reply.code(404).send({ error: "not found" });
      allowCrossOrigin(reply, req.headers.origin, settings.allowedOrigins);

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
