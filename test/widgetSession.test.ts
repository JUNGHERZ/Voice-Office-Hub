import "./helpers/env.js"; // MUSS erster Import bleiben (ENV-Pinning vor config-Load)

// Widget-spezifisches Pinning VOR dem dynamischen config-Import (ESM-Hoisting umgehen).
process.env.WEBRTC_ENABLED = "true";
process.env.WIDGET_SIP_PASSWORD = "test-sip-pass";
process.env.WIDGET_SESSION_RATE_IP = "3";
process.env.WIDGET_SESSION_RATE_KEY = "10";
process.env.WIDGET_MAX_CONCURRENT = "2";

import assert from "node:assert/strict";
import { test } from "node:test";

import Fastify from "fastify";

const { config } = await import("../src/config.js");
const { widgetRoutes } = await import("../src/admin/routes/widget.js");
const { SlidingWindowLimiter } = await import("../src/admin/rateLimit.js");

type Deps = Partial<import("../src/admin/routes/widget.js").WidgetRouteDeps>;

const WIDGET_AGENT = {
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
  const app = Fastify({ logger: false, trustProxy: true });
  void app.register(widgetRoutes, {
    deps: {
      findByWidgetKey: async (key: string) => (key === WIDGET_AGENT.widget.key ? WIDGET_AGENT : null),
      countActiveWebCalls: async () => 0,
      findCallByToken: async () => null,
      showTranscriptForAgent: async () => true,
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
    showTranscriptForAgent: async () => false,
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
