import "./helpers/env.js"; // MUSS erster Import bleiben (ENV-Pinning vor config-Load)

import assert from "node:assert/strict";
import { test } from "node:test";

import { handleStasisStart, resetCallDedup, type CallHandlerDeps } from "../src/ari/callHandler.js";
import { config } from "../src/config.js";
import { registerAllTools } from "../src/tools/index.js";
import type { ResolvedAgent } from "../src/types.js";
import {
  FakeChannel,
  FakeClient,
  FakeLocalizer,
  FakeMedia,
  FakeRepo,
  FakeVoiceAgentSession,
  settle,
  testAgent,
  waitFor,
} from "./helpers/fakes.js";

registerAllTools(); // idempotent; end_call/transfer_call für die Real-Dispatch-Fälle

const CALL_ARGS = ["120", "+4915100000000"];

function makeCall(opts: { agent?: ResolvedAgent; deps?: Partial<CallHandlerDeps> } = {}) {
  resetCallDedup();
  const client = new FakeClient();
  const channel = new FakeChannel();
  const media = new FakeMedia();
  const session = new FakeVoiceAgentSession();
  const repo = new FakeRepo();
  const agent = opts.agent ?? testAgent();
  const deps: Partial<CallHandlerDeps> = {
    findAgent: async () => agent,
    createMedia: () => media,
    createSession: () => session,
    repo,
    startBridgeRecording: async () => null,
    runPostCallSummary: async () => {},
    resolveOutboundTransfer: (_agent, target) => ({ target }),
    transferIntoBridge: async () => ({ connected: false }),
    // Anrufer-Gedächtnis und Vorübersetzung greifen auf die DB zu — in der Suite
    // grundsätzlich stillgelegt; die Tests dazu reichen eigene Fakes ein.
    lookupLanguage: async () => null,
    loadTranslations: async () => ({}),
    rememberLanguage: async () => {},
    ensureTranslations: async () => {},
    ...opts.deps,
  };
  const start = (args: string[] = CALL_ARGS) =>
    handleStasisStart(client.asAri(), channel.asAri(), args, deps);
  return { client, channel, media, session, repo, deps, agent, start };
}

// 1 ─ Dedup: Doppel-INVITE des Trunks (sipgate) wird verworfen, keine zweite Session.
test("Dedup: zweiter Anruf gleicher Caller→DDI im Fenster wird aufgelegt", async () => {
  let findAgentCalls = 0;
  const s = makeCall({
    deps: { findAgent: async () => { findAgentCalls++; return testAgent(); } },
  });
  await s.start();
  const channel2 = new FakeChannel("chan-2");
  await handleStasisStart(s.client.asAri(), channel2.asAri(), CALL_ARGS, s.deps);
  assert.equal(findAgentCalls, 1, "findAgent nur für den ersten Anruf");
  assert.equal(channel2.hangups.length, 1, "Duplikat wird aufgelegt");
  assert.equal(s.repo.requests.length, 1, "nur ein Request-Dokument");
});

// 2 ─ Unbekannte DDI → Reject ohne Answer, ohne Request, ohne Session (Härtung 0.5.8).
test("Unbekannte DDI: Reject mit 'unallocated', keine Session/kein Request", async () => {
  let sessionsCreated = 0;
  const s = makeCall({
    deps: {
      findAgent: async () => null,
      createSession: () => { sessionsCreated++; return new FakeVoiceAgentSession(); },
    },
  });
  await s.start(["999999", "+4915100000000"]);
  assert.equal(s.channel.answered, false);
  assert.equal(s.channel.hangups.length, 1);
  assert.equal((s.channel.hangups[0] as Record<string, unknown>)?.reason, "unallocated");
  assert.equal(s.repo.requests.length, 0);
  assert.equal(sessionsCreated, 0);
});

// 3 ─ Happy-Path-Verdrahtung: Bridge, Media, Session-Start, Audio in beide Richtungen.
test("Happy Path: Verdrahtung + Audio-Bridging in beide Richtungen", async () => {
  const s = makeCall();
  await s.start();
  assert.equal(s.channel.answered, true);
  assert.ok(s.client.bridge.channels.includes("chan-1"), "Anrufer in der Bridge");
  assert.ok(s.client.bridge.channels.includes("ext-1"), "externalMedia in der Bridge");
  assert.equal(s.media.started, true);
  assert.equal(s.session.started, true, "session.start() wurde aufgerufen");

  s.media.pushCallerAudio(Buffer.from([1, 2]));
  assert.equal(s.session.sentAudio.length, 1, "Anrufer-Audio → Session");
  s.session.emitAudio(Buffer.from([3, 4]));
  assert.equal(s.media.sentAudio.length, 1, "TTS-Audio → Media");
});

// 4 ─ Barge-in: userStartedSpeaking → genau ein flush().
test("Barge-in: userStartedSpeaking flusht den Playout genau einmal", async () => {
  const s = makeCall();
  await s.start();
  s.session.emitUserStartedSpeaking();
  assert.equal(s.media.flushCount, 1);
});

// 5 ─ Transkript: Reihenfolge + Rollen-Mapping assistant→agent / user→caller.
test("Transkript: Turns landen in Reihenfolge mit gemappten Sprechern im Repo", async () => {
  const s = makeCall();
  await s.start();
  s.session.emitConversationText("assistant", "Hallo, wie kann ich helfen?");
  s.session.emitConversationText("user", "Ich habe eine Frage.");
  await settle();
  assert.equal(s.repo.transcript.length, 2);
  assert.equal(s.repo.transcript[0]?.speaker, "agent");
  assert.equal(s.repo.transcript[0]?.text, "Hallo, wie kann ich helfen?");
  assert.equal(s.repo.transcript[1]?.speaker, "caller");
});

// 6 ─ FunctionCall-Dispatch: id-Korrelation, ToolContext.callId, clientSide:false übersprungen.
test("FunctionCall: Dispatch mit korrelierter Response; server-side wird übersprungen", async () => {
  const dispatched: Array<{ name: string; rawArgs: string; callId: string }> = [];
  const s = makeCall({
    deps: {
      buildCallToolset: async () => ({
        definitions: [],
        dispatch: async (name, rawArgs, ctx) => {
          dispatched.push({ name, rawArgs, callId: ctx.callId });
          return { ok: true, result: { ok: true } };
        },
        close: async () => {},
      }),
    },
  });
  await s.start();
  await s.session.emitFunctionCall([
    { id: "f1", name: "crm_lookup", argumentsJson: '{"a":1}' },
    { id: "f2", name: "server_thing", clientSide: false },
  ]);
  assert.equal(dispatched.length, 1, "nur client_side wird dispatcht");
  assert.equal(dispatched[0]?.name, "crm_lookup");
  assert.equal(dispatched[0]?.rawArgs, '{"a":1}');
  assert.equal(dispatched[0]?.callId, "req-1", "ToolContext.callId = Mongo-requestId");
  assert.equal(s.session.functionResponses.length, 1);
  assert.equal(s.session.functionResponses[0]?.id, "f1");
  assert.deepEqual(s.session.functionResponses[0]?.result, { ok: true });
  assert.equal(s.repo.functionCalls.length, 1);
  assert.equal(s.repo.functionCalls[0]?.status, "ok");
  assert.deepEqual(s.repo.functionCalls[0]?.arguments, { a: 1 });
});

// 7 ─ Unbekanntes Tool (realer Dispatch): Fehlertext als Response + status "error", Call lebt weiter.
test("FunctionCall: unbekanntes Tool → error-Result mit korrelierter id", async () => {
  const s = makeCall();
  await s.start();
  await s.session.emitFunctionCall([{ id: "f9", name: "gibts_nicht" }]);
  assert.equal(s.session.functionResponses.length, 1);
  assert.equal(s.session.functionResponses[0]?.id, "f9");
  const result = s.session.functionResponses[0]?.result as { error?: string };
  assert.match(String(result.error), /Unbekanntes Tool/);
  assert.equal(s.repo.functionCalls[0]?.status, "error", "Fehlschlag wird als error protokolliert");
  assert.equal(s.repo.finalized.length, 0, "Call läuft weiter");
});

// 8 ─ end_call: keine FunctionCallResponse; Hangup erst nach Abschieds-Drain.
test("end_call: keine Response, Hangup nach Puffer-Drain + Idle (Mock-Timer)", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"], now: 100_000 });
  const s = makeCall();
  await s.start();

  await s.session.emitFunctionCall([{ id: "e1", name: "end_call" }]);
  assert.equal(s.session.functionResponses.length, 0, "end_call bekommt keine Response");
  assert.equal(s.channel.hangups.length, 0, "noch nicht aufgelegt (Abschied läuft)");

  s.session.emitAudio(); // der Abschied fließt (audioSinceEnd)
  s.media.pending = 0;

  t.mock.timers.tick(150); // Drain-Poller: Audio kam gerade → warten
  await settle();
  assert.equal(s.channel.hangups.length, 0);

  t.mock.timers.tick(700); // idle ≤ 800 ms → weiter warten
  await settle();
  t.mock.timers.tick(200); // idle > 800 ms + Puffer leer + Abschied gespielt → auflegen
  await settle();
  assert.equal(s.channel.hangups.length, 1, "genau ein Hangup nach Drain");

  s.client.emitStasisEnd(s.channel);
  await settle(6);
  assert.deepEqual(s.repo.finalized, [
    { id: "req-1", status: "completed", endedReason: "agent" },
  ], "der Assistent hat aufgelegt, nicht der Anrufer");
});

// 9 ─ Transfer connected: Gates zu, Callee-Hangup beendet den Anruf.
test("Transfer connected: Voll-Mute beider Richtungen, Callee-Ende beendet Call", async () => {
  const callee = new FakeChannel("callee-1");
  const s = makeCall({
    deps: { transferIntoBridge: async () => ({ connected: true, channel: callee.asAri() }) },
  });
  await s.start();
  await s.session.emitFunctionCall([
    { id: "t1", name: "transfer_call", argumentsJson: JSON.stringify({ target: "101" }) },
  ]);

  assert.deepEqual(s.repo.transfers, [
    { attempted: true, target: "101" },
    { attempted: true, target: "101", connected: true },
  ]);
  const result = s.session.functionResponses[0]?.result as { connected?: boolean };
  assert.equal(result.connected, true);

  s.media.pushCallerAudio();
  assert.equal(s.session.sentAudio.length, 0, "Anrufer-Audio geht nicht mehr zur Session");
  s.session.emitAudio();
  assert.equal(s.media.sentAudio.length, 0, "Session-Audio geht nicht mehr zum Anrufer");
  // Sofortannahme-Leck (0.6.20): die beim Connect noch gepufferte Restansage wird verworfen,
  // damit der zugeschaltete Mitarbeiter sie nicht hört.
  assert.equal(s.media.flushCount, 1, "Playout-Puffer wird beim Connect geflusht");

  s.client.emitChannelDestroyed(callee);
  await waitFor(() => s.repo.finalized.length === 1);
  assert.equal(s.repo.finalized[0]?.status, "completed");
  assert.equal(callee.hangups.length, 1, "Callee wird im Teardown aufgelegt");
});

// 10 ─ Transfer failed: injectMessage, Gates wieder offen, Response mit connected:false.
test("Transfer failed: Agent übernimmt wieder (injectMessage, Gates offen)", async () => {
  const s = makeCall(); // transferIntoBridge-Default: connected:false
  await s.start();
  await s.session.emitFunctionCall([
    { id: "t1", name: "transfer_call", argumentsJson: JSON.stringify({ target: "101" }) },
  ]);

  assert.equal(s.session.injectedMessages.length, 1);
  assert.match(s.session.injectedMessages[0] ?? "", /niemanden erreichen/);
  const result = s.session.functionResponses[0]?.result as { connected?: boolean };
  assert.equal(result.connected, false);
  assert.equal(s.repo.transfers[1]?.connected, false);

  s.media.pushCallerAudio();
  assert.equal(s.session.sentAudio.length, 1, "Anrufer-Audio fließt wieder zur Session");
});

// 11 ─ Klingelphase: Agent hört nicht zu, Ansage darf noch raus.
test("Transfer-Klingelphase: Caller-Audio blockiert, Ansage fließt weiter", async () => {
  let resolveTransfer!: (r: { connected: boolean }) => void;
  const s = makeCall({
    deps: {
      transferIntoBridge: () =>
        new Promise<{ connected: boolean }>((res) => { resolveTransfer = res; }),
    },
  });
  await s.start();
  void s.session.emitFunctionCall([
    { id: "t1", name: "transfer_call", argumentsJson: JSON.stringify({ target: "101" }) },
  ]);
  await settle();

  s.media.pushCallerAudio();
  assert.equal(s.session.sentAudio.length, 0, "Klingelphase: Agent hört nicht zu");
  s.session.emitAudio();
  assert.equal(s.media.sentAudio.length, 1, "Ansage wird noch ausgespielt");

  resolveTransfer({ connected: false });
  await settle();
  s.media.pushCallerAudio();
  assert.equal(s.session.sentAudio.length, 1, "nach Fehlschlag: Gates wieder offen");
});

// 12 ─ Cleanup-Idempotenz: StasisEnd + ChannelDestroyed → genau ein Teardown.
test("Cleanup: StasisEnd und ChannelDestroyed führen zu genau einem Teardown", async () => {
  const s = makeCall();
  await s.start();
  s.client.emitStasisEnd(s.channel);
  s.channel.emit("ChannelDestroyed");
  await waitFor(() => s.repo.finalized.length >= 1);
  await settle(6);
  assert.deepEqual(s.repo.finalized, [
    { id: "req-1", status: "completed", endedReason: "caller" },
  ]);
  assert.equal(s.client.bridge.destroyed, 1);
  assert.equal(s.session.closed, true);
  assert.equal(s.media.closed, true);
  assert.equal(s.client.externalChannel.hangups.length, 1);
});

// 13 ─ Session-Fehler mid-call: kein Teardown (nur Log), Call endet normal.
test("Session-error: kein Teardown, Anruf endet regulär mit completed", async () => {
  const s = makeCall();
  await s.start();
  s.session.emitError("boom");
  await settle();
  assert.equal(s.repo.finalized.length, 0, "error alleine beendet den Call nicht");
  s.client.emitStasisEnd(s.channel);
  await waitFor(() => s.repo.finalized.length === 1);
  assert.equal(s.repo.finalized[0]?.status, "completed");
});

// 14 ─ start()-Fehler: sauberes failed-Teardown statt stummem Hängen.
test("start()-Fehler: cleanup('failed') + Hangup", async () => {
  const s = makeCall();
  s.session.startError = new Error("connect refused");
  await s.start();
  assert.deepEqual(s.repo.finalized, [
    { id: "req-1", status: "failed", endedReason: "failed" },
  ]);
  assert.ok(s.channel.hangups.length >= 1, "Anrufer wird aufgelegt");
});

// 15 ─ Metriken: firstAudio-Zeit, Barge-in-Guard (zählt nur bei hörbarem Agent), Tool-Zähler.
test("Metriken: timeToFirstAudio/bargeIns/toolCalls landen im finalizeRequest", async () => {
  const s = makeCall();
  await s.start();

  s.session.emitUserStartedSpeaking(); // VOR jedem Agent-Audio → kein Barge-in
  s.session.emitAudio(); // erstes TTS-Audio → timeToFirstAudioMs
  s.session.emitUserStartedSpeaking(); // Agent gerade hörbar → Barge-in
  await s.session.emitFunctionCall([{ id: "f1", name: "gibts_nicht" }]); // toolCalls+1, toolErrors+1

  s.client.emitStasisEnd(s.channel);
  await waitFor(() => s.repo.finalized.length === 1);
  const m = s.repo.metrics;
  assert.ok(m, "Metriken werden ans Repo übergeben");
  assert.ok(typeof m.timeToFirstAudioMs === "number" && m.timeToFirstAudioMs >= 0);
  assert.equal(m.bargeIns, 1, "nur das Reinreden bei hörbarem Agent zählt");
  assert.equal(m.toolCalls, 1);
  assert.equal(m.toolErrors, 1);
  assert.equal(m.voiceProvider, "deepgram");
  assert.equal(m.sttModel, "nova-3");
});

// 16 ─ Toolset-Lebenszyklus: close() läuft im Teardown (Hook für MCP-Verbindungen).
test("Toolset: close() wird im Teardown aufgerufen", async () => {
  let closed = 0;
  const s = makeCall({
    deps: {
      buildCallToolset: async () => ({
        definitions: [],
        dispatch: async () => ({ ok: true, result: {} }),
        close: async () => { closed++; },
      }),
    },
  });
  await s.start();
  s.client.emitStasisEnd(s.channel);
  await waitFor(() => s.repo.finalized.length === 1);
  assert.equal(closed, 1);
});

// 17 ─ Ambience: Agent-Konfiguration wird transportneutral an createMedia durchgereicht.
test("Ambience: Konfiguration erreicht createMedia", async () => {
  let captured: unknown;
  const media = new FakeMedia();
  const s = makeCall({
    agent: testAgent({ ambience: { enabled: true, preset: "office", volume: 0.3 } }),
    deps: {
      createMedia: (_callId, _uuid, ambience) => {
        captured = ambience;
        return media;
      },
    },
  });
  await s.start();
  assert.deepEqual(captured, { enabled: true, preset: "office", volume: 0.3 });
});

// 18 ─ Ambience: Bei erfolgreichem Transfer an einen Menschen wird sie pausiert.
test("Ambience: Transfer connected pausiert die Ambience", async () => {
  const callee = new FakeChannel("callee-1");
  const s = makeCall({
    deps: { transferIntoBridge: async () => ({ connected: true, channel: callee.asAri() }) },
  });
  await s.start();
  await s.session.emitFunctionCall([
    { id: "t1", name: "transfer_call", argumentsJson: JSON.stringify({ target: "101" }) },
  ]);
  assert.deepEqual(s.media.ambiencePauses, [true], "genau eine Pause, kein Resume");
});

// 19 ─ Web-Widget: drittes Stasis-Arg (X-Widget-Token) landet als widgetToken am Request.
test("Widget-Token: args[2] wird in createRequest durchgereicht", async () => {
  const s = makeCall();
  await s.start(["120", "web-1234", "a".repeat(32)]);
  assert.equal(s.repo.requests[0]?.widgetToken, "a".repeat(32));

  const s2 = makeCall();
  await s2.start(); // Telefonie: kein drittes Arg
  assert.equal(s2.repo.requests[0]?.widgetToken, undefined);
});

// 17 ─ TTS-Verbrauch: getUsage() der Session landet in den finalisierten Metriken.
test("Metriken: TTS-Verbrauch (Zeichen/Credits) landet im finalizeRequest", async () => {
  const s = makeCall();
  s.session.usage = {
    ttsProvider: "eleven_labs",
    ttsModel: "eleven_flash_v2_5",
    ttsCharacters: 4714,
    ttsCredits: 2357,
  };
  await s.start();

  s.client.emitStasisEnd(s.channel);
  await waitFor(() => s.repo.finalized.length === 1);
  const m = s.repo.metrics;
  assert.equal(m?.ttsProvider, "eleven_labs");
  assert.equal(m?.ttsModel, "eleven_flash_v2_5");
  assert.equal(m?.ttsCharacters, 4714);
  assert.equal(m?.ttsCredits, 2357);
});

// 18 ─ Lokalisierung: Transfer-Fehlschlag-Ansage kommt aus dem Localizer (beide Provider).
test("Lokalisierung: Transfer-Ansage über localizer.resolve", async () => {
  const localizer = new FakeLocalizer();
  localizer.phrases.transferFailed = "Could not reach anyone.";
  const s = makeCall({ deps: { createLocalizer: () => localizer } });
  await s.start();
  await s.session.emitFunctionCall([
    { id: "t1", name: "transfer_call", argumentsJson: JSON.stringify({ target: "101" }) },
  ]);
  assert.equal(s.session.injectedMessages[0], "Could not reach anyone.", "lokalisierte Ansage");
});

// 19 ─ Lokalisierung: conversationText füttert observeTurn (beide Rollen), close im Teardown.
test("Lokalisierung: observeTurn wird gefüttert, close beim Teardown", async () => {
  const localizer = new FakeLocalizer();
  const s = makeCall({ deps: { createLocalizer: () => localizer } });
  await s.start();
  s.session.emitConversationText("assistant", "Hallo!");
  s.session.emitConversationText("user", "Guten Tag, ich brauche Hilfe.");
  await settle();
  assert.deepEqual(
    localizer.observed,
    [
      { speaker: "agent", text: "Hallo!" },
      { speaker: "caller", text: "Guten Tag, ich brauche Hilfe." },
    ],
    "beide Rollen mit gemappten Sprechern",
  );

  s.client.emitStasisEnd(s.channel);
  await waitFor(() => s.repo.finalized.length === 1);
  assert.equal(localizer.closed, true, "Localizer wird im Teardown geschlossen");
});

// ── Stille-Reengagement (0.6.27) ─────────────────────────────────────────────
// Alle Tests hier mit Mock-Timern: der Wächter wird vom callHandler alle 250 ms getaktet.
//
// WICHTIG zum Verständnis der Zahlen: Node-Mock-Timer bündeln. Innerhalb eines `tick(ms)`
// sieht JEDER Interval-Callback bereits `Date.now()` = Ende des Fensters. Die effektive
// Auflösung ist also der tick()-Aufruf, nicht der 250-ms-Takt — deshalb wird hier bewusst in
// Etappen getickt, und `startIdleCall` setzt mit einem ersten Mini-Tick den Stille-Anker.

const idleAgent = (over: Partial<ResolvedAgent["idlePrompts"]> = {}) =>
  testAgent({
    idlePrompts: {
      enabled: true,
      timeoutMs: 8000,
      maxPrompts: 2,
      phrases: ["Sind Sie noch da?", "Soll ich Sie verbinden?"],
      hangupAfter: false,
      ...over,
    },
  });

/** Localizer-Fake, der den idle-Pool nach Stufe bedient (wie der echte über resolve(key, index)). */
function idleLocalizer(phrases: string[], farewell = "Auf Wiederhören."): FakeLocalizer {
  const loc = new FakeLocalizer();
  loc.resolve = (key: string, index?: number) => {
    if (key === "idle") return phrases[(index ?? 0) % Math.max(phrases.length, 1)] ?? "";
    if (key === "idleHangup") return farewell;
    return key;
  };
  return loc;
}

type TimerCtx = {
  mock: { timers: { enable(o: { apis: string[]; now: number }): void; tick(ms: number): void } };
};

/**
 * Startet einen Anruf mit aktiven Mock-Timern und verankert die Stille mit einem ersten
 * Mini-Tick. `random: () => 0` schaltet den Jitter aus → Fälligkeiten sind exakt rechenbar.
 * Ab Rückkehr zählt die Stille bei 0.
 */
async function startIdleCall(
  t: TimerCtx,
  over: Partial<ResolvedAgent["idlePrompts"]> = {},
  localizer: FakeLocalizer = idleLocalizer(["Sind Sie noch da?", "Soll ich Sie verbinden?"]),
  depsOver: Partial<CallHandlerDeps> = {},
) {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"], now: 100_000 });
  const s = makeCall({
    agent: idleAgent(over),
    deps: { createLocalizer: () => localizer, random: () => 0, ...depsOver },
  });
  await s.start();
  t.mock.timers.tick(250); // erster Tick: verankert den Stille-Beginn
  await settle();
  return s;
}

// 20 ─ Grundfall: nach timeoutMs Stille kommt die Ansage über injectMessage (providerneutral).
test("Stille: Ansage nach timeoutMs, eskaliert mit wachsendem Abstand (Mock-Timer)", async (t) => {
  const s = await startIdleCall(t);

  t.mock.timers.tick(7_500);
  await settle();
  assert.deepEqual(s.session.injectedMessages, [], "vor Ablauf bleibt es still");

  t.mock.timers.tick(500);
  await settle();
  assert.deepEqual(s.session.injectedMessages, ["Sind Sie noch da?"], "Stufe 1 nach 8 s");

  // Stufe 2 wartet 1,5 × 8000 = 12 s (Backoff), nicht wieder 8 s.
  t.mock.timers.tick(8_000);
  await settle();
  assert.equal(s.session.injectedMessages.length, 1, "nach weiteren 8 s noch nichts");
  t.mock.timers.tick(4_000);
  await settle();
  assert.deepEqual(s.session.injectedMessages, ["Sind Sie noch da?", "Soll ich Sie verbinden?"]);

  // Leiter erschöpft, ohne hangupAfter kehrt Ruhe ein.
  t.mock.timers.tick(120_000);
  await settle();
  assert.equal(s.session.injectedMessages.length, 2, "kein Nörgeln nach der letzten Stufe");
  assert.equal(s.channel.hangups.length, 0);
});

// 21 ─ Hörbarer Agent: der Playout-Puffer verhindert die Ansage (Kern der callHandler-Platzierung).
test("Stille: laufendes Playout (pendingMs) unterdrückt die Ansage", async (t) => {
  const s = await startIdleCall(t);
  s.media.pending = 4_000; // Agent redet noch, obwohl kein TTS-Chunk mehr fließt

  t.mock.timers.tick(30_000);
  await settle();
  assert.deepEqual(s.session.injectedMessages, [], "solange der Puffer spielt, gilt es nicht als Stille");

  s.media.pending = 0;
  t.mock.timers.tick(250); // Anker rückt auf den Moment, in dem der Puffer leer ist
  await settle();
  t.mock.timers.tick(8_000);
  await settle();
  assert.deepEqual(s.session.injectedMessages, ["Sind Sie noch da?"], "erst danach läuft die Uhr");
});

// 22 ─ Anrufer spricht → Leiter zurück auf Stufe 1.
test("Stille: Anrufer-Aktivität setzt die Eskalation zurück", async (t) => {
  const s = await startIdleCall(t);

  t.mock.timers.tick(8_000);
  await settle();
  assert.deepEqual(s.session.injectedMessages, ["Sind Sie noch da?"]);

  s.session.emitUserStartedSpeaking();
  s.session.emitConversationText("user", "Ja, ich bin noch dran.");
  await settle();

  t.mock.timers.tick(8_000);
  await settle();
  assert.deepEqual(
    s.session.injectedMessages,
    ["Sind Sie noch da?", "Sind Sie noch da?"],
    "neue Episode beginnt wieder bei Stufe 1",
  );
});

// 23 ─ Während eines Tool-Dispatches schweigt der Wächter (die Wartezeit gehört dem Filler).
test("Stille: keine Ansage während eines laufenden Tool-Calls", async (t) => {
  let release!: () => void;
  const gate = new Promise<void>((res) => { release = res; });
  const s = await startIdleCall(t, {}, idleLocalizer(["Sind Sie noch da?"]), {
    buildCallToolset: async () => ({
      definitions: [],
      dispatch: async () => { await gate; return { ok: true, result: { done: true } }; },
      close: async () => {},
    }),
  });

  void s.session.emitFunctionCall([{ id: "slow", name: "crm_lookup" }]);
  await settle();
  t.mock.timers.tick(30_000);
  await settle();
  assert.deepEqual(s.session.injectedMessages, [], "während das Tool läuft, schweigt der Wächter");

  release();
  await settle();
  t.mock.timers.tick(250); // Anker rückt auf das Tool-Ende
  await settle();
  t.mock.timers.tick(8_000);
  await settle();
  assert.deepEqual(
    s.session.injectedMessages,
    ["Sind Sie noch da?"],
    "nach dem Tool läuft die Stille-Uhr wieder",
  );
});

// 24 ─ Klingelphase: der Anrufer hört das Freizeichen, nicht "Sind Sie noch da?".
test("Stille: keine Ansage während der Transfer-Klingelphase", async (t) => {
  let connect!: (v: { connected: boolean }) => void;
  const ringing = new Promise<{ connected: boolean }>((res) => { connect = res; });
  const s = await startIdleCall(t, {}, idleLocalizer(["Sind Sie noch da?"]), {
    transferIntoBridge: () => ringing,
  });

  void s.session.emitFunctionCall([
    { id: "t1", name: "transfer_call", argumentsJson: JSON.stringify({ target: "101" }) },
  ]);
  await settle();
  t.mock.timers.tick(30_000);
  await settle();
  assert.deepEqual(s.session.injectedMessages, [], "während es klingelt, schweigt der Wächter");

  connect({ connected: false });
  await settle();
});

// 25 ─ hangupAfter: Abschied wird gesprochen, aufgelegt wird erst nach dem Drain.
test("Stille: hangupAfter spricht den Abschied und legt nach dem Drain auf", async (t) => {
  const s = await startIdleCall(t, { maxPrompts: 1, hangupAfter: true });

  t.mock.timers.tick(8_000);
  await settle();
  assert.deepEqual(s.session.injectedMessages, ["Sind Sie noch da?"]);

  // Gnadenfrist = 2 × 8000 = 16 s nach der letzten Ansage.
  t.mock.timers.tick(16_000);
  await settle();
  assert.deepEqual(
    s.session.injectedMessages,
    ["Sind Sie noch da?", "Auf Wiederhören."],
    "Abschied vor dem Auflegen",
  );
  assert.equal(s.channel.hangups.length, 0, "noch nicht aufgelegt — der Abschied läuft");

  s.session.emitAudio(); // der Abschied fließt als TTS-Audio
  s.media.pending = 0;
  t.mock.timers.tick(1_100); // Drain: Puffer leer + >800 ms kein Audio
  await settle();
  assert.equal(s.channel.hangups.length, 1, "genau ein Hangup nach dem Drain");

  s.client.emitStasisEnd(s.channel);
  await settle(6);
  assert.equal(s.repo.metrics?.idlePrompts, 1);
  assert.equal(s.repo.metrics?.idleHangup, true);
});

// 26 ─ Opt-in: ohne idlePrompts.enabled läuft gar kein Wächter.
test("Stille: deaktiviert (Default) → keine Ansage, kein Auflegen", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"], now: 100_000 });
  const s = makeCall({ deps: { createLocalizer: () => idleLocalizer(["Hallo?"]) } });
  await s.start();
  t.mock.timers.tick(300_000);
  await settle();
  assert.deepEqual(s.session.injectedMessages, []);
  assert.equal(s.channel.hangups.length, 0);
});

// ── Begrüßung in der Sprache des Anrufers (0.7.0) ────────────────────────────

/** Fängt den Agenten ein, mit dem die Session tatsächlich gebaut wurde. */
function capturingCall(depsOver: Partial<CallHandlerDeps> = {}, agent?: ResolvedAgent) {
  let built: ResolvedAgent | undefined;
  const localizer = new FakeLocalizer();
  const s = makeCall({
    agent,
    deps: {
      createLocalizer: () => localizer,
      ...depsOver,
    },
  });
  const inner = s.deps.createSession!;
  s.deps.createSession = ((a: ResolvedAgent, o: never) => {
    built = a;
    return inner(a, o);
  }) as typeof s.deps.createSession;
  return { ...s, localizer, builtAgent: () => built };
}

// 27 ─ Der Kern: bekannte Nummer → die Begrüßung geht in der Anrufersprache raus, obwohl
//      noch kein Wort gefallen ist. Wirkt über den Agenten und damit für beide Provider.
test("Prior: bekannte Nummer → Begrüßung in der Anrufersprache", async () => {
  const s = capturingCall({
    lookupLanguage: async () => ({ lang: "en", source: "profile" as const }),
    loadTranslations: async () => ({ greeting: "Hello! How can I help you?" }),
  });
  await s.start();
  await settle();

  assert.equal(s.builtAgent()?.greeting, "Hello! How can I help you?");
  assert.equal(s.localizer.preloaded?.lang, "en", "auch die Ansagen sind vorgewärmt");

  s.client.emitStasisEnd(s.channel);
  await settle(6);
  assert.equal(s.repo.metrics?.greetingLanguage, "en");
  assert.equal(s.repo.metrics?.priorSource, "profile");
});

// 28 ─ Ohne Treffer bleibt alles wie bisher — der Regelfall darf sich nicht ändern.
test("Prior: unbekannte Nummer → Verhalten unverändert", async () => {
  const s = capturingCall({ lookupLanguage: async () => null });
  await s.start();
  await settle();

  assert.equal(s.builtAgent()?.greeting, "Hallo", "Standardsprache");
  assert.equal(s.localizer.preloaded, undefined);
});

// 29 ─ Lieber deutsch als veraltet-englisch: ohne gültige Übersetzung der BEGRÜSSUNG wird
//      der Prior nicht angewandt (translationStore filtert veraltete Einträge weg).
test("Prior: ohne gültige Greeting-Übersetzung bleibt die Standardsprache", async () => {
  const s = capturingCall({
    lookupLanguage: async () => ({ lang: "en", source: "profile" as const }),
    // Begrüßung fehlt (Original geändert), andere Ansagen wären da.
    loadTranslations: async () => ({ transferFailed: "Nobody there." }),
  });
  await s.start();
  await settle();

  assert.equal(s.builtAgent()?.greeting, "Hallo");
  assert.equal(s.localizer.preloaded, undefined, "kein halb angewandter Prior");
});

// 30 ─ Eine hängende Datenbank darf den Anrufaufbau nicht blockieren.
test("Prior: Lookup-Timeout blockiert den Anrufaufbau nicht", async () => {
  const s = capturingCall({
    lookupLanguage: () => new Promise(() => {}), // löst nie auf
  });
  await s.start();
  await settle();

  assert.equal(s.session.started, true, "Session steht trotzdem");
  assert.equal(s.builtAgent()?.greeting, "Hallo");
});

// 31 ─ Ein Fehler im Prior-Pfad darf den Anruf nicht kosten.
test("Prior: Fehler beim Lookup wird verschluckt", async () => {
  const s = capturingCall({
    lookupLanguage: async () => {
      throw new Error("DB weg");
    },
  });
  await s.start();
  await settle();
  assert.equal(s.session.started, true);
  assert.equal(s.builtAgent()?.greeting, "Hallo");
});

// 32 ─ Nach dem Gespräch: Sprache merken + fehlende Übersetzung nachziehen. Beides nur mit
//      LLM-bestätigter Sprache — eine Scorer-Vermutung darf keine Begrüßung steuern.
test("Post-Call: bestätigte Sprache landet im Profil und stößt die Übersetzung an", async () => {
  const remembered: Array<{ lang: string; prior?: string }> = [];
  const ensured: string[] = [];
  const s = capturingCall({
    rememberLanguage: async (_a, _n, lang, prior) => {
      remembered.push({ lang, ...(prior ? { prior } : {}) });
    },
    ensureTranslations: async (_a, lang) => {
      ensured.push(lang);
    },
  });
  await s.start();
  s.localizer.state = { lang: "en", confirmed: true };

  s.client.emitStasisEnd(s.channel);
  await settle(6);

  assert.deepEqual(remembered, [{ lang: "en" }]);
  assert.deepEqual(ensured, ["en"], "ab dem nächsten Anruf sitzt auch die Begrüßung");
});

test("Post-Call: unbestätigte Sprache wird nicht gemerkt", async () => {
  const remembered: string[] = [];
  const s = capturingCall({
    rememberLanguage: async (_a, _n, lang) => {
      remembered.push(lang);
    },
  });
  await s.start();
  s.localizer.state = { lang: "en", confirmed: false };

  s.client.emitStasisEnd(s.channel);
  await settle(6);
  assert.deepEqual(remembered, [], "eine Vermutung darf keine künftige Begrüßung steuern");
});

// 33 ─ Widerspruch wird als solcher weitergereicht (die Lernregel wertet ihn dann aus).
test("Post-Call: Widerspruch zum Prior wird mitgegeben", async () => {
  const seen: Array<{ lang: string; prior?: string }> = [];
  const s = capturingCall({
    lookupLanguage: async () => ({ lang: "en", source: "profile" as const }),
    loadTranslations: async () => ({ greeting: "Hello!" }),
    rememberLanguage: async (_a, _n, lang, prior) => {
      seen.push({ lang, prior });
    },
  });
  await s.start();
  // Der Anrufer sprach doch Deutsch.
  s.localizer.state = { lang: "de", confirmed: true, priorLang: "en" };

  s.client.emitStasisEnd(s.channel);
  await settle(6);

  assert.deepEqual(seen, [{ lang: "de", prior: "en" }]);
  assert.equal(s.repo.metrics?.priorConfirmed, false, "der Prior lag daneben — messbar machen");
});

// ── Konfigurations-Overlay pro Anruf (0.9.0) ─────────────────────────────────

// 34 ─ Der Normalfall: ein überlagerter Prompt greift, und die Vorübersetzung läuft weiter.
// Letzteres ist die eigentliche Falle: Ein Overlay trägt IMMER einen Prompt — würde das
// Vorübersetzen deshalb aussetzen, wäre die Mehrsprachigkeit still abgeschaltet.
test("Overlay: Prompt erreicht die Session, agentRef am Request, Vorübersetzung läuft weiter", async () => {
  const ensured: string[] = [];
  const s = capturingCall({
    resolveOverlay: async (agent) => ({
      kind: "run",
      agent: { ...agent, prompt: "Laufzeit-Prompt" },
      agentRef: "cust-7",
      resolverStatus: "ok",
      report: true,
      announce: false,
    }),
    ensureTranslations: async (_a, lang) => {
      ensured.push(lang);
    },
  });
  await s.start();
  assert.equal(s.builtAgent()?.prompt, "Laufzeit-Prompt");
  assert.equal(s.builtAgent()?.name, "test", "Identität bleibt der gespeicherte Agent");
  assert.equal(s.repo.requests[0]?.agentRef, "cust-7");
  assert.equal(s.repo.requests[0]?.resolverStatus, "ok");

  s.localizer.state = { lang: "en", confirmed: true };
  s.client.emitStasisEnd(s.channel);
  await settle(6);
  assert.deepEqual(ensured, ["en"], "ein Overlay darf die Vorübersetzung nicht stilllegen");
});

// 35 ─ Ablehnung geht VOR UNKNOWN_NUMBER_BEHAVIOR: kein Answer, kein Default-Agent.
test("Overlay reject: kein Answer, kein Request — auch mit UNKNOWN_NUMBER_BEHAVIOR=agent", async () => {
  const before = config.unknownNumber.behavior;
  config.unknownNumber.behavior = "agent";
  try {
    let sessions = 0;
    const s = makeCall({
      deps: {
        resolveOverlay: async () => ({ kind: "reject" }),
        createSession: () => { sessions++; return new FakeVoiceAgentSession(); },
      },
    });
    await s.start();
    assert.equal(s.channel.answered, false, "vor dem Answer abgelehnt");
    assert.equal(s.channel.hangups.length, 1);
    assert.equal((s.channel.hangups[0] as Record<string, unknown>)?.reason, "unallocated");
    assert.equal(s.repo.requests.length, 0);
    assert.equal(sessions, 0);
  } finally {
    config.unknownNumber.behavior = before;
  }
});

// 36 ─ Ansage: Der Satz wird zu Ende gesprochen (Drain), erst danach wird aufgelegt.
test("Overlay announce: Ansage läuft aus, dann genau ein Hangup (Mock-Timer)", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"], now: 100_000 });
  const s = makeCall({
    deps: {
      resolveOverlay: async (agent) => ({ kind: "run", agent, report: true, announce: true }),
    },
  });
  await s.start();
  assert.equal(s.session.started, true);
  assert.equal(s.channel.hangups.length, 0, "die Ansage läuft noch");

  s.session.emitAudio(); // die Begrüßung fließt
  s.media.pending = 0;
  t.mock.timers.tick(150);
  await settle();
  assert.equal(s.channel.hangups.length, 0, "Audio kam gerade — noch nicht auflegen");

  t.mock.timers.tick(900);
  await settle();
  assert.equal(s.channel.hangups.length, 1, "nach dem Drain genau ein Hangup");
});

// 37 ─ report:false hinterlässt keine Spur.
test("Overlay report:false: kein Request, keine Aufnahme, keine Post-Call-Arbeiten", async () => {
  let recordings = 0;
  let summaries = 0;
  const ensured: string[] = [];
  const s = capturingCall({
    resolveOverlay: async (agent) => ({ kind: "run", agent, report: false, announce: false }),
    startBridgeRecording: async () => { recordings++; return null; },
    runPostCallSummary: async () => { summaries++; },
    ensureTranslations: async (_a, lang) => { ensured.push(lang); },
  });
  await s.start();
  s.session.emitConversationText("assistant", "Hallo");
  await settle();
  s.localizer.state = { lang: "en", confirmed: true };
  s.client.emitStasisEnd(s.channel);
  await settle(6);

  assert.deepEqual(s.repo.requests, [], "kein requests-Dokument");
  assert.deepEqual(s.repo.transcript, [], "kein Transkript");
  assert.deepEqual(s.repo.finalized, [], "kein Abschluss-Write");
  assert.equal(recordings, 0, "keine Aufnahme");
  assert.equal(summaries, 0);
  assert.deepEqual(ensured, []);
});

// ── Aufnahme abwählbar (0.10.0) ──────────────────────────────────────────────

// Ein Widerspruch gegen den Mitschnitt muss VOR der Aufnahme greifen, nicht erst beim
// Hochladen — sonst liegt die Datei bereits auf der Platte.
test("recording.enabled:false: keine Bridge-Aufnahme, kein Upload", async () => {
  let started = 0;
  let uploaded = 0;
  const s = makeCall({
    agent: testAgent({ recording: { enabled: false } }),
    deps: {
      startBridgeRecording: async () => { started++; return null; },
      uploadRecording: async () => { uploaded++; return "gridfs-1" as never; },
    },
  });
  await s.start();
  s.client.emitStasisEnd(s.channel);
  await settle(6);

  assert.equal(started, 0, "startBridgeRecording gar nicht erst gerufen");
  assert.equal(uploaded, 0);
  assert.deepEqual(
    s.repo.finalized,
    [{ id: "req-1", status: "completed", endedReason: "caller" }],
    "Anruf läuft normal",
  );
});

test("recording.enabled (Default): Aufnahme läuft wie bisher", async () => {
  let started = 0;
  const s = makeCall({
    deps: { startBridgeRecording: async () => { started++; return null; } },
  });
  await s.start();
  assert.equal(started, 1);
});

// ── Begrüßungs-Prompt (0.10.0) ───────────────────────────────────────────────

// Der erzeugte Satz muss den Provider erreichen: Beide Adapter bauen ihre Begrüßung aus
// dem übergebenen Agenten, ein getauschtes `greeting` wirkt deshalb ohne Provider-Code.
test("greetingPrompt: erzeugter Satz erreicht die Session und den Request", async () => {
  const seen: Array<{ prompt: string; lang: string }> = [];
  const s = capturingCall({
    generateGreeting: async (prompt, lang) => {
      seen.push({ prompt, lang });
      return "Guten Morgen bei Musterfirma.";
    },
  }, testAgent({ greetingPrompt: "Begrüße für Musterfirma, es ist Vormittag." }));

  await s.start();
  assert.deepEqual(seen, [
    { prompt: "Begrüße für Musterfirma, es ist Vormittag.", lang: "de" },
  ], "Sprache ist contentLanguage, solange kein Prior bekannt ist");
  assert.equal(s.builtAgent()?.greeting, "Guten Morgen bei Musterfirma.");
  assert.deepEqual(s.repo.greetingTexts, ["Guten Morgen bei Musterfirma."]);
});

// Der statische Text ist ab hier das Sicherheitsnetz — genau deshalb bleibt er Pflicht.
test("greetingPrompt: Fehlschlag fällt auf den statischen Text zurück, Anruf läuft", async () => {
  const s = capturingCall({
    generateGreeting: async () => { throw new Error("LLM aus"); },
  }, testAgent({ greetingPrompt: "Begrüße kurz." }));

  await s.start();
  assert.equal(s.builtAgent()?.greeting, "Hallo", "gespeicherter Text");
  assert.equal(s.session.started, true, "der Anruf läuft trotzdem");
  assert.deepEqual(s.repo.greetingTexts, ["Hallo"]);
});

test("greetingPrompt: leere Antwort zählt wie ein Fehlschlag", async () => {
  const s = capturingCall({
    generateGreeting: async () => undefined,
  }, testAgent({ greetingPrompt: "Begrüße kurz." }));
  await s.start();
  assert.equal(s.builtAgent()?.greeting, "Hallo");
});

// Ohne greetingPrompt darf sich nichts ändern — und der gesprochene Satz steht trotzdem
// am Gespräch, damit später belegbar bleibt, was gesagt wurde.
test("Ohne greetingPrompt: kein Modellaufruf, greetingText trotzdem gesetzt", async () => {
  let calls = 0;
  const s = makeCall({
    deps: { generateGreeting: async () => { calls++; return "x"; } },
  });
  await s.start();
  assert.equal(calls, 0);
  assert.deepEqual(s.repo.greetingTexts, ["Hallo"]);
});

// Legt der Anrufer noch im Rufton auf, muss der Modellaufruf abbrechen.
test("greetingPrompt: Auflegen im Rufton bricht die Erzeugung ab", async () => {
  let signal: AbortSignal | undefined;
  const s = makeCall({
    agent: testAgent({ greetingPrompt: "Begrüße kurz." }),
    deps: {
      generateGreeting: async (_p, _l, opts) =>
        new Promise<string | undefined>((resolve) => {
          signal = opts?.signal;
          opts?.signal?.addEventListener("abort", () => resolve(undefined));
        }),
    },
  });
  const running = s.start();
  await settle(4);
  assert.equal(signal?.aborted, false, "läuft, während der Anrufer klingeln hört");

  s.client.emitStasisEnd(s.channel); // Anrufer legt auf, bevor abgehoben wurde
  await settle(4);
  assert.equal(signal?.aborted, true, "Modellaufruf abgebrochen");
  await running;
});

// Der Prior trägt die Sprache auch dann, wenn es KEINE Greeting-Übersetzung gibt: Der Satz
// wird ja erzeugt. Die übrigen Ansagen (transferFailed, Filler, Stille) müssen trotzdem
// vorgeladen werden — sonst spräche der Agent seine Begrüßung englisch und den Rest deutsch.
test("greetingPrompt + Prior: Erzeugung in der Anrufersprache, Ansagen trotzdem vorgeladen", async () => {
  const seen: string[] = [];
  const s = capturingCall({
    lookupLanguage: async () => ({ lang: "en", source: "profile" as const }),
    loadTranslations: async () => ({ transferFailed: "Could not reach anyone." }),
    generateGreeting: async (_p, lang) => { seen.push(lang); return "Good morning."; },
  }, testAgent({ greetingPrompt: "Greet briefly." }));

  await s.start();
  assert.deepEqual(seen, ["en"], "Sprache kommt aus dem Anrufer-Profil");
  assert.equal(s.builtAgent()?.greeting, "Good morning.");
  assert.equal(s.localizer.preloaded?.lang, "en", "Ansagen-Cache vorgewärmt");
  assert.equal(s.repo.metrics?.greetingLanguage, undefined, "erst beim Finalisieren");
});

// ── Dauergrenze und Endgrund (0.10.0) ────────────────────────────────────────

test("maxDurationSec: Anruf endet nach Ablauf über die Drain-Logik (Mock-Timer)", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"], now: 100_000 });
  const s = makeCall({ agent: testAgent({ maxDurationSec: 20 }) });
  await s.start();

  t.mock.timers.tick(19_000);
  await settle();
  assert.equal(s.channel.hangups.length, 0, "vor der Grenze passiert nichts");

  t.mock.timers.tick(1_500); // Grenze erreicht → requestHangup("maxDuration")
  await settle();
  s.session.emitAudio(); // letzter Satz fließt noch
  s.media.pending = 0;
  t.mock.timers.tick(1_000); // Puffer leer + kein Audio mehr → auflegen
  await settle();
  assert.equal(s.channel.hangups.length, 1, "genau ein Hangup");

  s.client.emitStasisEnd(s.channel);
  await settle(6);
  assert.equal(s.repo.finalized[0]?.endedReason, "maxDuration");
});

test("Ohne maxDurationSec läuft das Gespräch unbegrenzt weiter (Mock-Timer)", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"], now: 100_000 });
  const s = makeCall();
  await s.start();
  t.mock.timers.tick(3_600_000); // eine Stunde
  await settle();
  assert.equal(s.channel.hangups.length, 0);
});

// Eine Weiterleitung läuft NICHT über requestHangup — beide Beine legen einfach auf. Ohne
// eigene Regel sähe der Erfolgsfall aus wie ein Anrufer, der frühzeitig aufgelegt hat.
test("endedReason: durchgestelltes Gespräch heißt transfer, nicht caller", async () => {
  const callee = new FakeChannel("callee-1");
  const s = makeCall({
    deps: { transferIntoBridge: async () => ({ connected: true, channel: callee.asAri() }) },
  });
  await s.start();
  await s.session.emitFunctionCall([
    { id: "t1", name: "transfer_call", argumentsJson: JSON.stringify({ target: "101" }) },
  ]);

  s.client.emitChannelDestroyed(callee); // der Mitarbeiter legt auf
  await waitFor(() => s.repo.finalized.length === 1);
  assert.equal(s.repo.finalized[0]?.endedReason, "transfer");
});

test("endedReason: auch wenn der ANRUFER nach dem Durchstellen auflegt", async () => {
  const callee = new FakeChannel("callee-1");
  const s = makeCall({
    deps: { transferIntoBridge: async () => ({ connected: true, channel: callee.asAri() }) },
  });
  await s.start();
  await s.session.emitFunctionCall([
    { id: "t1", name: "transfer_call", argumentsJson: JSON.stringify({ target: "101" }) },
  ]);

  s.client.emitStasisEnd(s.channel);
  await waitFor(() => s.repo.finalized.length === 1);
  assert.equal(s.repo.finalized[0]?.endedReason, "transfer");
});

// Gescheiterter Transfer: der Agent macht weiter, das Gespräch endet ganz normal.
test("endedReason: gescheiterter Transfer bleibt bei caller", async () => {
  const s = makeCall(); // transferIntoBridge liefert connected:false (Default im Fake-Setup)
  await s.start();
  await s.session.emitFunctionCall([
    { id: "t1", name: "transfer_call", argumentsJson: JSON.stringify({ target: "101" }) },
  ]);
  s.client.emitStasisEnd(s.channel);
  await waitFor(() => s.repo.finalized.length === 1);
  assert.equal(s.repo.finalized[0]?.endedReason, "caller");
});

// ── Verbrauchsmengen (0.10.0) ────────────────────────────────────────────────

test("Metriken: LLM-Mengen der Session landen im finalizeRequest", async () => {
  const s = makeCall();
  await s.start();
  s.session.usage = {
    llmModel: "bedrock/claude-haiku-4-5@eu-central-1",
    llmPromptTokens: 1900,
    llmCachedPromptTokens: 1700,
    llmCompletionTokens: 50,
    llmRequests: 2,
  };
  s.client.emitStasisEnd(s.channel);
  await settle(6);

  assert.equal(s.repo.metrics?.llmModel, "bedrock/claude-haiku-4-5@eu-central-1");
  assert.equal(s.repo.metrics?.llmPromptTokens, 1900);
  assert.equal(s.repo.metrics?.llmCachedPromptTokens, 1700);
  assert.equal(s.repo.metrics?.llmCompletionTokens, 50);
  assert.equal(s.repo.metrics?.llmRequests, 2);
});

// Gebündelter Provider: kein Token-Bericht → die Felder bleiben leer statt falsch.
test("Metriken: ohne LLM-Bericht bleiben die Felder leer", async () => {
  const s = makeCall();
  await s.start();
  s.client.emitStasisEnd(s.channel);
  await settle(6);
  assert.equal(s.repo.metrics?.llmRequests, undefined);
  assert.equal(s.repo.metrics?.llmModel, undefined);
});

// 8 kHz × 16 Bit = 16.000 Bytes je Sekunde (Testumgebung, siehe helpers/env.ts).
test("Metriken: sttSeconds zählt das an den Provider gestreamte Anrufer-Audio", async () => {
  const s = makeCall();
  await s.start();
  for (let i = 0; i < 100; i++) s.media.pushCallerAudio(Buffer.alloc(320)); // 100 × 20 ms = 2 s
  s.client.emitStasisEnd(s.channel);
  await settle(6);
  assert.equal(s.repo.metrics?.sttSeconds, 2);
});

// Während ein Mensch übernommen hat, fließt nichts mehr zur Session — und wird deshalb
// auch nicht abgerechnet.
test("Metriken: durchgestellte Zeit zählt nicht in sttSeconds", async () => {
  const callee = new FakeChannel("callee-1");
  const s = makeCall({
    deps: { transferIntoBridge: async () => ({ connected: true, channel: callee.asAri() }) },
  });
  await s.start();
  for (let i = 0; i < 50; i++) s.media.pushCallerAudio(Buffer.alloc(320)); // 1 s vor dem Transfer
  await s.session.emitFunctionCall([
    { id: "t1", name: "transfer_call", argumentsJson: JSON.stringify({ target: "101" }) },
  ]);
  for (let i = 0; i < 200; i++) s.media.pushCallerAudio(Buffer.alloc(320)); // 4 s im Gespräch

  s.client.emitChannelDestroyed(callee);
  await waitFor(() => s.repo.finalized.length === 1);
  assert.equal(s.repo.metrics?.sttSeconds, 1, "nur die Zeit mit dem Assistenten");
});
