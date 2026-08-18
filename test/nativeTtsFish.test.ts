import "./helpers/env.js"; // MUSS erster Import bleiben (ENV-Pinning vor config-Load)

import assert from "node:assert/strict";
import { test } from "node:test";

import { decode, encode } from "@msgpack/msgpack";
import { WebSocketServer, type WebSocket as ServerSocket } from "ws";

import { FishTtsStream, type FishTtsOptions } from "../src/native/ttsFish.js";
import { waitFor } from "./helpers/fakes.js";

const PORT = 18100;

function makeOpts(over: Partial<FishTtsOptions> = {}): FishTtsOptions {
  return {
    url: `ws://127.0.0.1:${PORT}`,
    apiKey: "fish-test-key",
    model: "s2.1-pro",
    referenceId: "voice-123",
    sampleRate: 8000,
    latency: "low",
    ...over,
  };
}

function startServer() {
  const wss = new WebSocketServer({ port: PORT });
  const state: {
    connections: number;
    auth?: string;
    model?: string;
    socket?: ServerSocket;
    events: Record<string, unknown>[];
  } = { connections: 0, events: [] };
  wss.on("connection", (socket, req) => {
    state.connections += 1;
    state.auth = req.headers.authorization;
    state.model = req.headers.model as string;
    state.socket = socket;
    socket.on("message", (data: Buffer) => {
      state.events.push(decode(data) as Record<string, unknown>);
    });
  });
  return {
    state,
    send: (obj: unknown) => state.socket?.send(encode(obj)),
    close: () => new Promise<void>((r) => wss.close(() => r())),
  };
}

// 1 ─ Header und start-Event: alles Konfigurierbare steckt im start.
test("FishTtsStream: Auth-/Model-Header und start-Event", async () => {
  const srv = startServer();
  const tts = new FishTtsStream(makeOpts({ temperature: 0.6, topP: 0.8, speed: 1.1 }), "call-1");
  tts.on("error", () => {});
  await tts.start();
  await waitFor(() => srv.state.events.length >= 1);

  assert.equal(srv.state.auth, "Bearer fish-test-key");
  assert.equal(srv.state.model, "s2.1-pro");
  assert.deepEqual(srv.state.events[0], {
    event: "start",
    request: {
      text: "",
      reference_id: "voice-123",
      format: "pcm",
      sample_rate: 8000,
      latency: "low",
      temperature: 0.6,
      top_p: 0.8,
      prosody: { speed: 1.1 },
    },
  });

  tts.close();
  await srv.close();
});

// 2 ─ Text/Flush/Audio über MessagePack.
test("FishTtsStream: text-Events, Audio und finish", async () => {
  const srv = startServer();
  const tts = new FishTtsStream(makeOpts(), "call-2");
  const audio: Buffer[] = [];
  const flushed: number[] = [];
  tts.on("audio", (b) => audio.push(b));
  tts.on("flushed", () => flushed.push(1));
  tts.on("error", () => {});
  await tts.start();

  tts.sendText("Hallo.");
  await waitFor(() => srv.state.events.length >= 2);
  assert.deepEqual(srv.state.events[1], { event: "text", text: "Hallo." });

  srv.send({ event: "audio", audio: new Uint8Array(320).fill(4) });
  await waitFor(() => audio.length === 1);
  assert.equal(audio[0]?.length, 320);

  tts.flush();
  await waitFor(() => srv.state.events.some((e) => e.event === "flush"));
  srv.send({ event: "finish", reason: "stop" });
  await waitFor(() => flushed.length === 1);

  tts.close();
  await srv.close();
});

// 3 ─ Abrechnung in UTF-8-BYTES: Umlaute kosten bei Fish doppelt. Wer Zeichen
//     zählte, unterschätzte die Kosten systematisch.
test("FishTtsStream: usage() zählt UTF-8-Bytes, nicht Zeichen", async () => {
  const srv = startServer();
  const tts = new FishTtsStream(makeOpts(), "call-3");
  tts.on("error", () => {});
  await tts.start();

  tts.sendText("Grüße"); // 5 Zeichen, aber 7 Bytes (ü und ß je 2)
  await waitFor(() => srv.state.events.length >= 2);
  assert.equal(tts.usage().characters, 7);
  assert.equal(tts.usage().provider, "fish_audio");

  tts.close();
  await srv.close();
});

// 4 ─ Barge-in: kein serverseitiges Clear → harte Trennung, danach lazy Reconnect
//     samt erneutem start-Event (sonst wüsste der Server weder Stimme noch Format).
test("FishTtsStream: clear() trennt, der nächste Satz verbindet neu", async () => {
  const srv = startServer();
  const tts = new FishTtsStream(makeOpts(), "call-4");
  const audio: Buffer[] = [];
  tts.on("audio", (b) => audio.push(b));
  tts.on("error", () => {});
  await tts.start();
  await waitFor(() => srv.state.connections === 1);

  tts.clear();
  tts.sendText("Neuer Turn.");
  await waitFor(() => srv.state.connections === 2);
  // Nach dem Reconnect muss wieder ein start-Event kommen.
  const afterReconnect = srv.state.events.filter((e) => e.event === "start");
  assert.equal(afterReconnect.length, 2);

  tts.close();
  await srv.close();
});

// 5 ─ finish mit reason "error" ist ein Fehler, kein Turn-Ende.
test("FishTtsStream: finish reason=error meldet sich als Fehler", async () => {
  const srv = startServer();
  const tts = new FishTtsStream(makeOpts(), "call-5");
  const errors: string[] = [];
  const flushed: number[] = [];
  tts.on("error", (e) => errors.push(e));
  tts.on("flushed", () => flushed.push(1));
  await tts.start();

  srv.send({ event: "finish", reason: "error", message: "unsupported sample_rate" });
  await waitFor(() => errors.length === 1);
  assert.match(errors[0] ?? "", /sample_rate/);
  assert.equal(flushed.length, 0, "ein Fehler ist kein Turn-Ende");

  tts.close();
  await srv.close();
});
