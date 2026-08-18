import "./helpers/env.js"; // MUSS erster Import bleiben (ENV-Pinning vor config-Load)

import assert from "node:assert/strict";
import { test } from "node:test";

import { WebSocketServer, type WebSocket as ServerSocket } from "ws";

import { clampFluxSpeed, FluxTtsStream, type FluxTtsOptions } from "../src/native/ttsFlux.js";
import { waitFor } from "./helpers/fakes.js";

const PORT = 18093;

function makeOpts(over: Partial<FluxTtsOptions> = {}): FluxTtsOptions {
  return {
    url: `ws://127.0.0.1:${PORT}`,
    apiKey: "test-dg-key",
    model: "flux-haley-en",
    encoding: "linear16",
    sampleRate: 8000,
    ...over,
  };
}

function startServer() {
  const wss = new WebSocketServer({ port: PORT });
  const state: {
    connections: number;
    url?: string;
    auth?: string;
    socket?: ServerSocket;
    msgs: Record<string, unknown>[];
  } = { connections: 0, msgs: [] };
  wss.on("connection", (socket, req) => {
    state.connections += 1;
    state.url = req.url ?? "";
    state.auth = req.headers.authorization;
    state.socket = socket;
    socket.on("message", (data: Buffer, isBinary: boolean) => {
      if (!isBinary) state.msgs.push(JSON.parse(data.toString()) as Record<string, unknown>);
    });
  });
  return {
    wss,
    state,
    send: (obj: unknown) => state.socket?.send(JSON.stringify(obj)),
    sendAudio: (bytes: number) => state.socket?.send(Buffer.alloc(bytes, 3)),
    close: () => new Promise<void>((r) => wss.close(() => r())),
  };
}

function collect(tts: FluxTtsStream) {
  const audio: Buffer[] = [];
  const flushed: number[] = [];
  const errors: string[] = [];
  const interrupted: { spokenText: string; audioPlayedMs: number }[] = [];
  tts.on("audio", (b) => audio.push(b));
  tts.on("flushed", () => flushed.push(1));
  tts.on("error", (e) => errors.push(e));
  tts.on("interrupted", (ev) => interrupted.push(ev));
  return { audio, flushed, errors, interrupted };
}

// 1 ─ Flux akzeptiert nur 0,85–1,15 in 0,05-Schritten.
test("Flux: Sprechtempo wird aufs Raster geklemmt", () => {
  assert.equal(clampFluxSpeed(1.0), 1.0);
  assert.equal(clampFluxSpeed(1.07), 1.05);
  assert.equal(clampFluxSpeed(2.0), 1.15);
  assert.equal(clampFluxSpeed(0.1), 0.85);
});

// 2 ─ URL/Auth und der Speak/Flush-Grundfluss.
test("FluxTtsStream: Params, Auth, Speak/Flush und Audio", async () => {
  const srv = startServer();
  const tts = new FluxTtsStream(makeOpts(), "call-1");
  const seen = collect(tts);
  await tts.start();

  assert.ok(srv.state.url?.includes("model=flux-haley-en"));
  assert.ok(srv.state.url?.includes("sample_rate=8000"));
  assert.equal(srv.state.auth, "Token test-dg-key");

  tts.sendText("Hallo.");
  await waitFor(() => srv.state.msgs.length >= 1);
  assert.deepEqual(srv.state.msgs[0], { type: "Speak", text: "Hallo." });

  srv.send({ type: "SpeechStarted", speech_id: "s1" });
  srv.sendAudio(320);
  await waitFor(() => seen.audio.length === 1);

  tts.flush();
  await waitFor(() => srv.state.msgs.some((m) => m.type === "Flush"));

  // Flushed ist nur die Empfangsbestätigung — das Audio kommt DANACH (live
  // gemessen). Wer hier schon "flushed" meldete, signalisierte das Turn-Ende,
  // bevor der erste Ton lief.
  srv.send({ type: "Flushed", speech_id: "s1" });
  srv.sendAudio(320);
  await waitFor(() => seen.audio.length === 2);
  assert.equal(seen.flushed.length, 0, "Flushed ist nicht das Turn-Ende");

  // SpeechMetadata schließt den Turn ab.
  srv.send({ type: "SpeechMetadata", speech_id: "s1", billable_character_count: 6 });
  await waitFor(() => seen.flushed.length === 1);

  tts.close();
  await srv.close();
});

// 3 ─ Configure kommt nach dem Open (und damit nach jedem Reconnect).
test("FluxTtsStream: Configure setzt das Sprechtempo nach dem Verbinden", async () => {
  const srv = startServer();
  const tts = new FluxTtsStream(makeOpts({ speed: 1.07 }), "call-2");
  collect(tts);
  await tts.start();
  await waitFor(() => srv.state.msgs.length >= 1);
  assert.deepEqual(srv.state.msgs[0], { type: "Configure", speed: 1.05 });
  tts.close();
  await srv.close();
});

// 4 ─ DER Kern: Barge-in meldet die GEHÖRTE Position, nicht die gesendete.
//     320 Byte @ 8 kHz = 20 ms gesendet; 8 ms stecken noch im Playout-Puffer.
test("FluxTtsStream: Interrupt zieht den Playout-Puffer ab", async () => {
  const srv = startServer();
  const tts = new FluxTtsStream(makeOpts(), "call-3");
  const seen = collect(tts);
  await tts.start();

  tts.sendText("Ein längerer Satz.");
  srv.send({ type: "SpeechStarted", speech_id: "s1" });
  srv.sendAudio(3200); // 200 ms @ 8 kHz, 16 bit
  await waitFor(() => seen.audio.length === 1);

  tts.clear(80); // 80 ms liegen noch ungehört in der Queue
  await waitFor(() => srv.state.msgs.some((m) => m.type === "Interrupt"));
  const iv = srv.state.msgs.find((m) => m.type === "Interrupt");
  assert.deepEqual(iv, {
    type: "Interrupt",
    playback_offset: { type: "time_ms", value: 120 },
  });

  tts.close();
  await srv.close();
});

// 5 ─ Quarantäne: nach Interrupt kein Audio mehr, bis SpeechInterrupted kommt —
//     und dann meldet der Client, was der Anrufer wirklich gehört hat.
test("FluxTtsStream: Quarantäne bis SpeechInterrupted, dann interrupted-Event", async () => {
  const srv = startServer();
  const tts = new FluxTtsStream(makeOpts(), "call-4");
  const seen = collect(tts);
  await tts.start();

  tts.sendText("Ihr Kontostand beträgt … Soll ich Ihnen …");
  srv.send({ type: "SpeechStarted", speech_id: "s1" });
  srv.sendAudio(320);
  await waitFor(() => seen.audio.length === 1);

  tts.clear(0);
  await waitFor(() => srv.state.msgs.some((m) => m.type === "Interrupt"));
  srv.sendAudio(320); // Nachzügler aus dem Server-Puffer
  await waitFor(() => true);
  assert.equal(seen.audio.length, 1, "nach Interrupt darf kein Audio mehr durch");

  srv.send({
    type: "SpeechInterrupted",
    audio_played_ms: 40,
    text_spoken: "Ihr Kontostand beträgt …",
    text_remaining: " Soll ich Ihnen …",
  });
  await waitFor(() => seen.interrupted.length === 1);
  assert.equal(seen.interrupted[0]?.spokenText, "Ihr Kontostand beträgt …");

  // Quarantäne ist freigegeben: neues Audio kommt wieder an.
  srv.send({ type: "SpeechStarted", speech_id: "s2" });
  srv.sendAudio(320);
  await waitFor(() => seen.audio.length === 2);

  tts.close();
  await srv.close();
});

// 6 ─ Kein Interrupt, wenn gar nichts läuft. cancelActiveTurn() feuert bei JEDEM
//     speechStarted des Anrufers — ohne diesen Guard bliebe die Quarantäne hängen.
test("FluxTtsStream: clear() ohne laufende Äußerung sendet nichts", async () => {
  const srv = startServer();
  const tts = new FluxTtsStream(makeOpts(), "call-5");
  const seen = collect(tts);
  await tts.start();

  tts.clear(0);
  await waitFor(() => true);
  assert.ok(!srv.state.msgs.some((m) => m.type === "Interrupt"));

  // Und der Kanal ist nicht stumm: Audio kommt weiterhin durch.
  srv.send({ type: "SpeechStarted", speech_id: "s1" });
  srv.sendAudio(320);
  await waitFor(() => seen.audio.length === 1);

  tts.close();
  await srv.close();
});

// 7 ─ Abrechnung bevorzugt die Server-Zählung.
test("FluxTtsStream: usage() nutzt billable_character_count", async () => {
  const srv = startServer();
  const tts = new FluxTtsStream(makeOpts(), "call-6");
  collect(tts);
  await tts.start();

  tts.sendText("Hallo.");
  await waitFor(() => srv.state.msgs.length >= 1);
  assert.equal(tts.usage().characters, 6, "vor SpeechMetadata gilt die lokale Zählung");

  srv.send({ type: "SpeechMetadata", speech_id: "s1", billable_character_count: 42 });
  await waitFor(() => tts.usage().characters === 42);
  assert.equal(tts.usage().provider, "deepgram_flux");

  tts.close();
  await srv.close();
});

// 8 ─ Flux kennt einen eigenen Fehlertyp (Aura nicht).
test("FluxTtsStream: Error-Nachricht wird gemeldet", async () => {
  const srv = startServer();
  const tts = new FluxTtsStream(makeOpts(), "call-7");
  const seen = collect(tts);
  await tts.start();

  srv.send({ type: "Error", code: "MESSAGE-0000", description: "The message could not be parsed." });
  await waitFor(() => seen.errors.length === 1);
  assert.match(seen.errors[0] ?? "", /could not be parsed/);

  tts.close();
  await srv.close();
});
