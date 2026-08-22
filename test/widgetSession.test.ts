import "./helpers/env.js"; // MUSS erster Import bleiben (ENV-Pinning vor config-Load)

// Widget-spezifisches Pinning VOR dem dynamischen config-Import (ESM-Hoisting umgehen).
process.env.WEBRTC_ENABLED = "true";
process.env.WIDGET_SIP_PASSWORD = "test-sip-pass";
process.env.WIDGET_SESSION_RATE_IP = "3";
process.env.WIDGET_SESSION_RATE_KEY = "10";
process.env.WIDGET_MAX_CONCURRENT = "2";
process.env.ADMIN_API_KEY = "test-management-key";

import assert from "node:assert/strict";
import http from "node:http";
import { test } from "node:test";

import Fastify from "fastify";

const { config } = await import("../src/config.js");
const { widgetRoutes, widgetOriginAllowed } = await import("../src/admin/routes/widget.js");
const { SlidingWindowLimiter } = await import("../src/admin/rateLimit.js");

type Deps = Partial<import("../src/admin/routes/widget.js").WidgetRouteDeps>;

const WIDGET_AGENT = {
  _id: "6a411b273d84ad5c5d4d28ef",
  name: "Vertrieb Demo",
  widget: {
    enabled: true,
    key: "k".repeat(32),
    exten: "120",
    allowedOrigins: ["https://kunde.de"],
    showTranscript: true,
  },
};

function makeApp(deps: Deps = {}) {
  // forceCloseConnections: Ein offener SSE-Strom ist für Fastify keine „idle"-Verbindung —
  // ohne das wartet close() auf ihn, und der Testlauf endet nie.
  const app = Fastify({ logger: false, trustProxy: true, forceCloseConnections: true });
  void app.register(widgetRoutes, {
    deps: {
      findByWidgetKey: async (key: string) => (key === WIDGET_AGENT.widget.key ? WIDGET_AGENT : null),
      issueSession: async () => "f".repeat(32),
      countActiveWebCalls: async () => 0,
      findCallByToken: async () => null,
      widgetSettingsForAgent: async () => ({ showTranscript: true, allowedOrigins: [] }),
      ...deps,
    },
  });
  return app;
}

const sessionReq = (key = WIDGET_AGENT.widget.key, headers: Record<string, string> = {}) => ({
  method: "POST" as const,
  url: "/api/widget/session",
  payload: { key },
  headers: { host: "localhost:8080", ...headers },
});

// 1 ─ Kill-Switch: ohne WEBRTC_ENABLED liefert der Endpoint 404 (nicht unterscheidbar).
test("Session: Kill-Switch aus → 404", async () => {
  const app = makeApp();
  config.widget.enabled = false;
  try {
    const res = await app.inject(sessionReq());
    assert.equal(res.statusCode, 404);
  } finally {
    config.widget.enabled = true;
    await app.close();
  }
});

// 2 ─ Unbekannter/deaktivierter Key → 404 (kein Unterschied zu "gibt es nicht").
test("Session: unbekannter Key → 404", async () => {
  const app = makeApp();
  const res = await app.inject(sessionReq("f".repeat(32)));
  assert.equal(res.statusCode, 404);
  await app.close();
});

// 3 ─ Fremder Origin → 403 (der legitime Fetch kommt immer same-origin aus dem iframe).
test("Session: fremder Origin → 403", async () => {
  const app = makeApp();
  const res = await app.inject(sessionReq(WIDGET_AGENT.widget.key, { origin: "https://boese-seite.de" }));
  assert.equal(res.statusCode, 403);
  await app.close();
});

// 3b ─ Fremde, aber am Agenten gelistete Origin → 200. Ohne das ließe sich das Widget nur
// auf der Appliance selbst einbetten (0.10.2).
test("Session: gelistete fremde Origin → 200", async () => {
  const app = makeApp();
  const res = await app.inject(sessionReq(WIDGET_AGENT.widget.key, { origin: "https://kunde.de" }));
  assert.equal(res.statusCode, 200);
  await app.close();
});

// 3c ─ Leere Liste = heutiges Verhalten: nur die Appliance selbst.
test("Session: ohne allowedOrigins bleibt es bei same-origin", async () => {
  const bare = { ...WIDGET_AGENT, widget: { ...WIDGET_AGENT.widget, allowedOrigins: [] } };
  const app = makeApp({ findByWidgetKey: async () => bare });
  const res = await app.inject(sessionReq(bare.widget.key, { origin: "https://kunde.de" }));
  assert.equal(res.statusCode, 403);
  await app.close();
});

// 3d ─ Ein Eintrag, der die Einbettung erlaubt, muss auch die Session erlauben — sonst lädt
// derselbe Wert an zwei Stellen zu unterschiedlichem Verhalten ein. Deshalb dieselbe
// Wildcard-Semantik wie in CSP frame-ancestors.
test("widgetOriginAllowed: CSP-treue Semantik für Schema, Port und Unterdomänen", () => {
  const ok = (o: string, list: string[]) => widgetOriginAllowed(o, list);
  assert.equal(ok("https://kunde.de", ["https://kunde.de"]), true);
  assert.equal(ok("https://KUNDE.de", ["https://kunde.de/"]), true, "Groß/Klein und Schrägstrich");
  assert.equal(ok("http://kunde.de", ["https://kunde.de"]), false, "Schema muss stimmen");
  assert.equal(ok("https://kunde.de:8443", ["https://kunde.de"]), false, "Port muss stimmen");
  assert.equal(ok("https://shop.kunde.de", ["https://*.kunde.de"]), true);
  assert.equal(ok("https://a.b.kunde.de", ["https://*.kunde.de"]), true);
  assert.equal(ok("https://kunde.de", ["https://*.kunde.de"]), false, "Wildcard ≠ Domäne selbst");
  assert.equal(ok("https://boese-kunde.de", ["https://*.kunde.de"]), false, "kein Suffix-Trick");
  assert.equal(ok("null", ["https://kunde.de"]), false, "Opaque Origin (sandbox/data:)");
  assert.equal(ok("https://kunde.de", []), false);
});

// 4 ─ Happy Path: Creds + Exten; wss-URL wird hinter Traefik aus x-forwarded-proto abgeleitet.
test("Session: Happy Path mit wss-Ableitung hinter Proxy", async () => {
  const app = makeApp();
  const res = await app.inject(
    sessionReq(WIDGET_AGENT.widget.key, {
      host: "voh.example.com",
      "x-forwarded-proto": "https",
      origin: "https://voh.example.com",
    }),
  );
  assert.equal(res.statusCode, 200);
  const body = res.json() as Record<string, unknown>;
  assert.equal(body.wsUrl, "wss://voh.example.com/ws");
  assert.equal(body.domain, "voh.example.com");
  assert.equal(body.exten, "120");
  assert.equal(body.authUser, "webwidget");
  assert.equal(body.authPassword, "test-sip-pass");
  assert.equal(body.showTranscript, true);
  assert.ok(Array.isArray(body.iceServers));

  // Lokal (plain HTTP): same-origin über den Admin-Port — dort proxyt Fastify /ws an Asterisk.
  const local = await app.inject(sessionReq());
  assert.equal((local.json() as Record<string, unknown>).wsUrl, "ws://localhost:8080/ws");
  await app.close();
});

// 5 ─ IP-Rate-Limit greift (Pinning: 3/min pro IP).
test("Session: IP-Rate-Limit → 429", async () => {
  const app = makeApp();
  for (let i = 0; i < 3; i++) {
    const ok = await app.inject(sessionReq());
    assert.equal(ok.statusCode, 200, `Request ${i + 1} noch erlaubt`);
  }
  const blocked = await app.inject(sessionReq());
  assert.equal(blocked.statusCode, 429);
  await app.close();
});

// 5b ─ Ein Vermittler (Backend holt die Sitzung, damit der Widget-Schlüssel den Browser nie
// erreicht) ist kein Besucher: Der IP-Deckel zählte sonst Worker statt Besucher und wäre
// appliance-weit statt pro Besucher. Der Key hebt genau diesen Deckel auf — sonst nichts.
test("Session: gültiger x-api-key hebt den IP-Deckel auf", async () => {
  const app = makeApp();
  for (let i = 0; i < 3; i++) await app.inject(sessionReq());
  assert.equal((await app.inject(sessionReq())).statusCode, 429, "ohne Key gedeckelt");

  const withKey = await app.inject(sessionReq(WIDGET_AGENT.widget.key, { "x-api-key": "test-management-key" }));
  assert.equal(withKey.statusCode, 200);
  await app.close();
});

// Ein falscher Key darf nicht besser stehen als gar keiner — sonst wäre der Deckel eine
// Formalität, die ein beliebiger Header aushebelt.
test("Session: falscher x-api-key bleibt am IP-Deckel hängen", async () => {
  const app = makeApp();
  for (let i = 0; i < 3; i++) await app.inject(sessionReq());
  const res = await app.inject(sessionReq(WIDGET_AGENT.widget.key, { "x-api-key": "falsch" }));
  assert.equal(res.statusCode, 429);
  await app.close();
});

// Der Key-Deckel (je Widget-Schlüssel, also je Agent) bleibt: Er ist die richtige Größe
// für einen Vermittler und die einzige Bremse, die dann noch wirkt.
test("Session: x-api-key hebt den Key-Deckel NICHT auf", async () => {
  const app = makeApp();
  const key = WIDGET_AGENT.widget.key;
  // WIDGET_SESSION_RATE_KEY ist auf 10 gepinnt; mit Key läuft der IP-Deckel nicht mit.
  for (let i = 0; i < 10; i++) {
    const ok = await app.inject(sessionReq(key, { "x-api-key": "test-management-key" }));
    assert.equal(ok.statusCode, 200, `Request ${i + 1} noch erlaubt`);
  }
  const blocked = await app.inject(sessionReq(key, { "x-api-key": "test-management-key" }));
  assert.equal(blocked.statusCode, 429);
  await app.close();
});

// Der Key ersetzt keine Origin-Freigabe: Er sagt „kein Besucher", nicht „alles erlaubt".
test("Session: x-api-key ersetzt die Origin-Freigabe nicht", async () => {
  const app = makeApp();
  const res = await app.inject(
    sessionReq(WIDGET_AGENT.widget.key, {
      "x-api-key": "test-management-key",
      origin: "https://boese-seite.de",
    }),
  );
  assert.equal(res.statusCode, 403);
  await app.close();
});

// Das Anruf-Token kommt aus der Antwort — ohne es kommt seit 0.11.0 kein Web-Anruf zustande.
test("Session: Antwort trägt das ausgestellte callToken", async () => {
  const issued: Array<{ agentId: string; exten?: string }> = [];
  const app = makeApp({
    issueSession: async (agentId, exten) => {
      issued.push({ agentId, ...(exten ? { exten } : {}) });
      return "abc123abc123abc1";
    },
  });
  const res = await app.inject(sessionReq());
  assert.equal(res.statusCode, 200);
  assert.equal((res.json() as Record<string, unknown>).callToken, "abc123abc123abc1");
  assert.deepEqual(issued, [{ agentId: String(WIDGET_AGENT._id), exten: "120" }]);
  await app.close();
});

// 6 ─ Concurrent-Cap: alle Web-Leitungen belegt → 429 mit sprechender Meldung.
test("Session: Concurrent-Cap → 429", async () => {
  const app = makeApp({ countActiveWebCalls: async () => 2 });
  const res = await app.inject(sessionReq());
  assert.equal(res.statusCode, 429);
  assert.match((res.json() as { message: string }).message, /Web-Leitungen belegt/);
  await app.close();
});

// 7 ─ Widget-Seite: CSP frame-ancestors pro Agent; unbekannter Key → 404.
test("Widget-Seite: frame-ancestors-Header + 404-Fall", async () => {
  const app = makeApp();
  const ok = await app.inject({ method: "GET", url: `/widget/${WIDGET_AGENT.widget.key}` });
  assert.equal(ok.statusCode, 200);
  assert.equal(ok.headers["content-security-policy"], "frame-ancestors 'self' https://kunde.de");
  assert.match(ok.body, /Anruf starten/);

  const bad = await app.inject({ method: "GET", url: "/widget/unbekannt" });
  assert.equal(bad.statusCode, 404);
  await app.close();
});

// 8 ─ Transkript-Endpoint: token-gebunden, Grace-Fenster, showTranscript-Schalter.
test("Transkript: Token-Gate, Grace und Opt-out", async () => {
  const token = "a".repeat(32);
  const liveCall = {
    status: "in_progress",
    agentId: "agent-1",
    transcript: [
      { t: 1.2, speaker: "agent", text: "Willkommen!" },
      { t: 3.4, speaker: "caller", text: "Hallo" },
    ],
  };
  const app = makeApp({
    findCallByToken: async (t: string) => (t === token ? liveCall : null),
  });

  const ok = await app.inject({ method: "GET", url: `/api/widget/call/${token}` });
  assert.equal(ok.statusCode, 200);
  const body = ok.json() as { status: string; transcript: Array<{ speaker: string }> };
  assert.equal(body.status, "in_progress");
  assert.equal(body.transcript.length, 2);
  assert.equal(body.transcript[0]?.speaker, "agent");

  const unknown = await app.inject({ method: "GET", url: `/api/widget/call/${"b".repeat(32)}` });
  assert.equal(unknown.statusCode, 404);
  await app.close();

  // Terminal + frisches endedAt → noch erlaubt; altes endedAt → 404.
  const ended = (ageMs: number) => ({
    status: "completed",
    endedAt: new Date(Date.now() - ageMs),
    agentId: "agent-1",
    transcript: [],
  });
  const app2 = makeApp({ findCallByToken: async () => ended(30_000) });
  assert.equal((await app2.inject({ method: "GET", url: `/api/widget/call/${token}` })).statusCode, 200);
  await app2.close();
  const app3 = makeApp({ findCallByToken: async () => ended(200_000) });
  assert.equal((await app3.inject({ method: "GET", url: `/api/widget/call/${token}` })).statusCode, 404);
  await app3.close();

  // Betreiber hat das Transkript deaktiviert → 404 trotz gültigem Token.
  const app4 = makeApp({
    findCallByToken: async () => liveCall,
    widgetSettingsForAgent: async () => ({ showTranscript: false, allowedOrigins: [] }),
  });
  assert.equal((await app4.inject({ method: "GET", url: `/api/widget/call/${token}` })).statusCode, 404);
  await app4.close();
});

// 9 ─ Sliding-Window-Limiter: Fenster läuft ab, Zähler pro Schlüssel getrennt.
test("SlidingWindowLimiter: Fenster + Schlüsseltrennung", () => {
  let t = 0;
  const limiter = new SlidingWindowLimiter(2, 1000, () => t);
  assert.equal(limiter.allow("a"), true);
  assert.equal(limiter.allow("a"), true);
  assert.equal(limiter.allow("a"), false, "Limit im Fenster erreicht");
  assert.equal(limiter.allow("b"), true, "anderer Schlüssel unabhängig");
  t = 1001;
  assert.equal(limiter.allow("a"), true, "nach Fensterablauf wieder erlaubt");
});

// ── Live-Transkript als Strom (SSE, 0.11.1) ──────────────────────────────────

const TOKEN = "a".repeat(32);

/**
 * Öffnet den Strom über einen echten Port — `inject()` kann keine offene Antwort lesen.
 *
 * Bewusst `node:http` statt `fetch`: Undici hält je Origin eine Verbindung, und ein offener
 * SSE-Strom belegt sie dauerhaft — ein zweiter `fetch` gegen denselben Port würde ewig in
 * der Warteschlange stehen. Browser öffnen dafür eigene Verbindungen.
 */
async function serve(app: ReturnType<typeof makeApp>): Promise<number> {
  await app.listen({ host: "127.0.0.1", port: 0 });
  return (app.server.address() as { port: number }).port;
}

function openStream(
  port: number,
  headers: Record<string, string> = {},
  path = `/api/widget/call/${TOKEN}/stream`,
) {
  const chunks: string[] = [];
  return new Promise<{
    status: number;
    headers: Record<string, string | string[] | undefined>;
    text: () => string;
    until: (needle: string, ms?: number) => Promise<void>;
    close: () => Promise<void>;
  }>((resolve, reject) => {
    // `agent: false` = eigene Verbindung je Strom. Über den geteilten Agenten würde der
    // zweite Strom auf die Verbindung des ersten warten, die nie frei wird. Browser machen
    // es genauso — ein SSE-Strom belegt dauerhaft eine HTTP/1.1-Verbindung.
    const req = http.request({ host: "127.0.0.1", port, path, headers, agent: false }, (res) => {
      res.setEncoding("utf8");
      res.on("data", (c: string) => chunks.push(c));
      res.on("error", () => {});
      const text = () => chunks.join("");
      resolve({
        status: res.statusCode ?? 0,
        headers: res.headers,
        text,
        until: async (needle, ms = 3000) => {
          const start = Date.now();
          while (!text().includes(needle)) {
            if (Date.now() - start > ms) throw new Error(`nicht gesehen: ${needle} (bisher: ${text()})`);
            await new Promise((r) => setTimeout(r, 20));
          }
        },
        close: async () => {
          req.destroy();
          await new Promise((r) => setTimeout(r, 20)); // Server sieht das 'close'
        },
      });
    });
    req.on("error", reject);
    req.end();
  });
}

function callDoc(turns: Array<Record<string, unknown>>, status = "in_progress") {
  return { widgetToken: TOKEN, status, agentId: "a1", transcript: turns };
}

test("Strom: vorhandene Turns beim Verbinden, danach nur neue", async () => {
  let turns = [{ t: 0.5, speaker: "agent", text: "Guten Abend." }];
  const app = makeApp({
    findCallByToken: async () => callDoc(turns),
    findCallsByTokens: async () => [callDoc(turns)],
  });
  const s = await openStream(await serve(app));
  assert.equal(s.headers["content-type"], "text/event-stream; charset=utf-8");
  await s.until("Guten Abend.");
  assert.ok(s.text().includes("id: 0"), "Turn-Index als Ereignis-ID");

  turns = [...turns, { t: 3.1, speaker: "caller", text: "Hallo." }];
  await s.until("Hallo.");
  assert.equal(s.text().split("Guten Abend.").length - 1, 1, "kein Turn doppelt");
  await s.close();
  await app.close();
});

// Ohne das wiederholte ein Reconnect das ganze Transkript — und das Widget zeigte Turns
// doppelt, genau in dem Moment, in dem die Verbindung ohnehin gewackelt hat.
test("Strom: Last-Event-ID überspringt Bekanntes", async () => {
  const turns = [
    { t: 0.5, speaker: "agent", text: "eins" },
    { t: 1.5, speaker: "caller", text: "zwei" },
    { t: 2.5, speaker: "agent", text: "drei" },
  ];
  const app = makeApp({
    findCallByToken: async () => callDoc(turns),
    findCallsByTokens: async () => [callDoc(turns)],
  });
  const s = await openStream(await serve(app), { "last-event-id": "1" });
  await s.until("drei");
  assert.ok(!s.text().includes("eins"), "vor dem Wiedereinstieg gesehene Turns bleiben weg");
  assert.ok(!s.text().includes("zwei"));
  await s.close();
  await app.close();
});

test("Strom: Anrufende meldet status und schließt", async () => {
  let status = "in_progress";
  const app = makeApp({
    findCallByToken: async () => callDoc([], status),
    findCallsByTokens: async () => [callDoc([{ t: 0, speaker: "agent", text: "x" }], status)],
  });
  const s = await openStream(await serve(app));
  await s.until("event: turn");
  status = "completed";
  await s.until('"status":"completed"');
  await s.close();
  await app.close();
});

// Der Strom darf nicht das schwächere Tor sein: dieselben Prüfungen wie beim Polling.
test("Strom: unbekanntes Token und abgeschaltetes Transkript → 404", async () => {
  const app = makeApp({ findCallByToken: async () => null });
  const s = await openStream(await serve(app));
  assert.equal(s.status, 404);
  await s.close();
  await app.close();

  const app2 = makeApp({
    findCallByToken: async () => callDoc([]),
    widgetSettingsForAgent: async () => ({ showTranscript: false, allowedOrigins: [] }),
  });
  const s2 = await openStream(await serve(app2));
  assert.equal(s2.status, 404);
  await s2.close();
  await app2.close();
});

// Der Grund, warum es EINEN Ticker gibt: Sonst wüchse die Last mit der Zahl der Zuschauer,
// und der Deckel für gleichzeitige Web-Anrufe hält die nicht.
test("Strom: ein Nachschlag je Takt, nicht einer je Strom", async () => {
  let queries = 0;
  let seenTokens: string[] = [];
  const other = "b".repeat(32);
  const app = makeApp({
    findCallByToken: async () => callDoc([{ t: 0, speaker: "agent", text: "x" }]),
    findCallsByTokens: async (tokens) => {
      queries++;
      seenTokens = tokens;
      return [callDoc([{ t: 0, speaker: "agent", text: "x" }]), { ...callDoc([]), widgetToken: other }];
    },
  });
  const port = await serve(app);
  const a = await openStream(port);
  const b = await openStream(port, {}, `/api/widget/call/${other}/stream`);
  await a.until("event: turn");
  const before = queries;
  await new Promise((r) => setTimeout(r, 700)); // mehrere Takte
  const takte = queries - before;
  assert.ok(takte >= 2, `mindestens zwei Takte gelaufen (waren ${takte})`);
  assert.equal(seenTokens.length, 2, "beide Ströme in EINER Abfrage");
  await a.close();
  await b.close();
  await app.close();
});

// ── CORS (0.11.1) ────────────────────────────────────────────────────────────

// Ohne diese Kopfzeile hält der Browser die Antwort zurück — die Origin-Freigabe aus 0.10.2
// wäre für eine fremd eingebettete Seite wirkungslos geblieben.
test("CORS: gelistete Origin bekommt die Freigabe, fremde nicht", async () => {
  const app = makeApp({
    findCallByToken: async () => callDoc([]),
    widgetSettingsForAgent: async () => ({
      showTranscript: true,
      allowedOrigins: ["https://kunde.de"],
    }),
  });
  const ok = await app.inject({
    method: "GET",
    url: `/api/widget/call/${TOKEN}`,
    headers: { origin: "https://kunde.de" },
  });
  assert.equal(ok.headers["access-control-allow-origin"], "https://kunde.de");
  assert.equal(ok.headers["vary"], "Origin");

  const nope = await app.inject({
    method: "GET",
    url: `/api/widget/call/${TOKEN}`,
    headers: { origin: "https://boese-seite.de" },
  });
  assert.equal(nope.headers["access-control-allow-origin"], undefined);
  await app.close();
});

test("CORS: Session-Antwort trägt die Freigabe für eine gelistete Origin", async () => {
  const app = makeApp();
  const res = await app.inject(sessionReq(WIDGET_AGENT.widget.key, { origin: "https://kunde.de" }));
  assert.equal(res.statusCode, 200);
  assert.equal(res.headers["access-control-allow-origin"], "https://kunde.de");
  await app.close();
});

// Der Preflight kennt den Widget-Schlüssel nicht (kein Rumpf) und antwortet deshalb
// unspezifisch. Unbedenklich: Er gibt nichts heraus — ob die eigentliche Antwort lesbar
// ist, entscheidet deren eigene Kopfzeile.
test("CORS: Preflight des Session-Endpunkts erlaubt POST samt Headern", async () => {
  const app = makeApp();
  const res = await app.inject({
    method: "OPTIONS",
    url: "/api/widget/session",
    headers: { origin: "https://irgendwo.de" },
  });
  assert.equal(res.statusCode, 204);
  assert.equal(res.headers["access-control-allow-origin"], "https://irgendwo.de");
  assert.match(String(res.headers["access-control-allow-headers"]), /content-type/);
  assert.match(String(res.headers["access-control-allow-headers"]), /x-api-key/);
  await app.close();
});
