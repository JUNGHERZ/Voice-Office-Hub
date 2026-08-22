import "./helpers/env.js"; // MUSS erster Import bleiben (ENV-Pinning vor config-Load)

import assert from "node:assert/strict";
import { test } from "node:test";

import { handleStasisStart, resetCallDedup, type CallHandlerDeps } from "../src/ari/callHandler.js";
import { config } from "../src/config.js";
import {
  consumeWidgetSession,
  issueWidgetSession,
  memorySessionStore,
  type Admission,
} from "../src/db/widgetSessions.js";
import {
  FakeChannel,
  FakeClient,
  FakeMedia,
  FakeRepo,
  FakeVoiceAgentSession,
  testAgent,
} from "./helpers/fakes.js";

/**
 * Zulassung von Web-Anrufen (0.11.0): Ohne eingelöste Sitzung entsteht kein Anruf.
 *
 * Geprüft wird der Prüfpunkt im callHandler, nicht die Datenbank — die Einlöselogik selbst
 * (`consumeWidgetSession`) hängt an Mongoose und wird über die DI-Naht ersetzt.
 */

const WEB_ARGS = ["120", "web-1755769964.42", "a".repeat(32)];
const PHONE_ARGS = ["+4923629838194123", "+491711234567"];

function makeCall(admission: Admission, extra: Partial<CallHandlerDeps> = {}) {
  resetCallDedup();
  const client = new FakeClient();
  const channel = new FakeChannel();
  const repo = new FakeRepo();
  const seen: Array<{ token?: string; agentId?: string }> = [];
  let overlayCalls = 0;
  const deps: Partial<CallHandlerDeps> = {
    findAgent: async () => testAgent({ id: "6a411b273d84ad5c5d4d28ef" }),
    consumeWidgetSession: async (token, agentId) => {
      seen.push({ token, agentId });
      return admission;
    },
    resolveOverlay: async (agent) => {
      overlayCalls++;
      return { kind: "run", agent, report: true, announce: false };
    },
    createMedia: () => new FakeMedia() as never,
    createSession: () => new FakeVoiceAgentSession(),
    repo,
    startBridgeRecording: async () => null,
    runPostCallSummary: async () => {},
    lookupLanguage: async () => null,
    loadTranslations: async () => ({}),
    rememberLanguage: async () => {},
    ensureTranslations: async () => {},
    ...extra,
  };
  return {
    channel,
    repo,
    seen,
    overlayCalls: () => overlayCalls,
    start: (args: string[] = WEB_ARGS) =>
      handleStasisStart(client.asAri(), channel.asAri(), args, deps),
  };
}

// Der teuerste Fehler wäre, den Anruf trotzdem laufen zu lassen: Er belastet dann den
// Agenten, den er erreicht hat — nicht den, für den jemand eine Sitzung geholt hat.
test("Web-Anruf ohne Sitzung: kein Answer, kein Request, kein Hook-Aufruf", async () => {
  const s = makeCall({ ok: false, reason: "missing" });
  await s.start();
  assert.equal(s.channel.answered, false);
  assert.equal(s.repo.requests.length, 0, "kein Gesprächsdatensatz");
  assert.equal(s.overlayCalls(), 0, "der Overlay-Hook wird gar nicht erst gefragt");
  assert.deepEqual(s.channel.hangups, [{ reason: "unallocated" }]);
});

test("Web-Anruf mit fremder Durchwahl wird abgewiesen", async () => {
  const s = makeCall({ ok: false, reason: "foreign-agent" });
  await s.start();
  assert.equal(s.repo.requests.length, 0);
  assert.equal(s.channel.answered, false);
});

test("Web-Anruf mit gültiger Sitzung läuft normal", async () => {
  const s = makeCall({ ok: true });
  await s.start();
  assert.equal(s.channel.answered, true);
  assert.equal(s.repo.requests.length, 1);
  assert.deepEqual(s.seen, [{ token: "a".repeat(32), agentId: "6a411b273d84ad5c5d4d28ef" }]);
});

// Die Prüfung darf nur Web-Anrufe treffen. Der Caller-ID-Präfix kommt aus dem Dialplan
// ([webrtc-inbound]) und ist vom Client nicht wählbar — an ihm hängt die Unterscheidung.
test("Telefonat läuft ohne Sitzungsprüfung", async () => {
  const s = makeCall({ ok: false, reason: "missing" });
  await s.start(PHONE_ARGS);
  assert.equal(s.seen.length, 0, "gar nicht erst gefragt");
  assert.equal(s.channel.answered, true);
  assert.equal(s.repo.requests.length, 1);
});

// Notausgang für einen Fremdclient, der noch nicht umgezogen ist.
test("WIDGET_REQUIRE_SESSION=false: Verhalten wie vor 0.11.0", async () => {
  const before = config.widget.requireSession;
  config.widget.requireSession = false;
  try {
    const s = makeCall({ ok: false, reason: "missing" });
    await s.start();
    assert.equal(s.seen.length, 0);
    assert.equal(s.channel.answered, true);
    assert.equal(s.repo.requests.length, 1);
  } finally {
    config.widget.requireSession = before;
  }
});

// ── Einlöselogik isoliert (In-Memory-Store, keine Datenbank) ─────────────────

const AGENT_A = "6a411b273d84ad5c5d4d28ef";
const AGENT_B = "6a411b273d84ad5c5d4d28f0";
const T0 = 1_700_000_000_000;

test("Sitzung: ausgestellt → einlösbar, ein zweites Mal nicht", async () => {
  const store = memorySessionStore();
  const token = await issueWidgetSession(AGENT_A, "120", 300, T0, store);
  assert.match(token, /^[a-f0-9]{32}$/, "Form passt zum Transkript-Endpunkt");
  assert.deepEqual(await consumeWidgetSession(token, AGENT_A, T0 + 1000, store), { ok: true });
  assert.deepEqual(await consumeWidgetSession(token, AGENT_A, T0 + 2000, store), {
    ok: false,
    reason: "consumed",
  });
});

test("Sitzung: abgelaufen, obwohl das Dokument noch da ist", async () => {
  const store = memorySessionStore();
  const token = await issueWidgetSession(AGENT_A, "120", 300, T0, store);
  // Der TTL-Monitor räumt nur minütlich — die Gültigkeit muss der Code selbst prüfen.
  assert.deepEqual(await consumeWidgetSession(token, AGENT_A, T0 + 301_000, store), {
    ok: false,
    reason: "expired",
  });
  assert.equal(store.size(), 1, "das Dokument liegt noch da");
});

test("Sitzung: unbekanntes und fehlendes Token", async () => {
  const store = memorySessionStore();
  assert.deepEqual(await consumeWidgetSession("b".repeat(32), AGENT_A, T0, store), {
    ok: false,
    reason: "unknown",
  });
  assert.deepEqual(await consumeWidgetSession(undefined, AGENT_A, T0, store), {
    ok: false,
    reason: "missing",
  });
});

// Der Kern der Mandantentrennung — und die Sitzung darf dabei NICHT verbraucht werden:
// Sonst könnte, wer ein Token mitliest, damit die Sitzung eines fremden Besuchers
// abräumen, ohne selbst je durchzukommen.
test("Sitzung: fremde Durchwahl wird abgewiesen und verbraucht die Sitzung nicht", async () => {
  const store = memorySessionStore();
  const token = await issueWidgetSession(AGENT_A, "120", 300, T0, store);
  assert.deepEqual(await consumeWidgetSession(token, AGENT_B, T0 + 1000, store), {
    ok: false,
    reason: "foreign-agent",
  });
  assert.deepEqual(
    await consumeWidgetSession(token, AGENT_A, T0 + 2000, store),
    { ok: true },
    "der rechtmäßige Besucher kommt weiterhin durch",
  );
});
