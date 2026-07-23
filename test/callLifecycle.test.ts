import "./helpers/env.js"; // MUSS erster Import bleiben (ENV-Pinning vor config-Load)

import assert from "node:assert/strict";
import { test } from "node:test";

import { handleStasisStart, resetCallDedup, type CallHandlerDeps } from "../src/ari/callHandler.js";
import { registerAllTools } from "../src/tools/index.js";
import type { ResolvedAgent } from "../src/types.js";
import {
  FakeChannel,
  FakeClient,
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
  assert.deepEqual(s.repo.finalized, [{ id: "req-1", status: "completed" }]);
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
  assert.deepEqual(s.repo.finalized, [{ id: "req-1", status: "completed" }]);
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
  assert.deepEqual(s.repo.finalized, [{ id: "req-1", status: "failed" }]);
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
