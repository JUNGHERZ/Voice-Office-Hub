import "./helpers/env.js"; // MUSS erster Import bleiben (ENV-Pinning vor config-Load)

import assert from "node:assert/strict";
import { test } from "node:test";

import { WebSocketServer, type WebSocket as ServerSocket } from "ws";

import { ElevenLabsTtsStream } from "../src/native/ttsElevenLabs.js";
import { waitFor } from "./helpers/fakes.js";

const PORT = 18092;

function makeOpts() {
  return {
    baseUrl: `ws://127.0.0.1:${PORT}`,
    apiKey: "xi-test-key",
    voiceId: "voice123",
    modelId: "eleven_flash_v2_5",
    outputFormat: "pcm_8000",
  };
}

function startServer() {
  const wss = new WebSocketServer({ port: PORT });
  const state: {
    connections: number;
    url?: string;
    apiKey?: string;
    socket?: ServerSocket;
    texts: string[];
  } = { connections: 0, texts: [] };
  wss.on("connection", (socket, req) => {
    state.connections += 1;
    state.url = req.url ?? "";
    state.apiKey = String(req.headers["xi-api-key"] ?? "");
    state.socket = socket;
    socket.on("message", (data: Buffer) => state.texts.push(data.toString()));
  });
  return { wss, state, close: () => new Promise<void>((r) => wss.close(() => r())) };
}

// 1 ─ Verbindung: URL (Voice-ID im Pfad, model_id/output_format/auto_mode), Key-Header,
//     Init-Message, Text- und Flush-Wire-Format.
test("ElevenLabsTtsStream: URL, Init und Wire-Format", async () => {
  const srv = startServer();
  const tts = new ElevenLabsTtsStream(makeOpts(), "call-1");
  await tts.start();

  assert.match(srv.state.url ?? "", /\/text-to-speech\/voice123\/stream-input\?/);
  const url = new URL(`ws://x${srv.state.url}`);
  assert.equal(url.searchParams.get("model_id"), "eleven_flash_v2_5");
  assert.equal(url.searchParams.get("output_format"), "pcm_8000");
  assert.equal(url.searchParams.get("auto_mode"), "true");
  assert.equal(srv.state.apiKey, "xi-test-key");

  tts.sendText("Hallo Welt.");
  tts.flush();
  await waitFor(() => srv.state.texts.length === 3);
  assert.deepEqual(JSON.parse(srv.state.texts[0]!), { text: " " }, "Init-Message");
  assert.deepEqual(JSON.parse(srv.state.texts[1]!), { text: "Hallo Welt. " }, "Trailing Space");
  assert.deepEqual(JSON.parse(srv.state.texts[2]!), { text: " ", flush: true });

  tts.close();
  await waitFor(() => srv.state.texts.some((t) => t === '{"text":""}'));
  await srv.close();
});

// 1b ─ voice_settings landen im Wire-Format der Init-Message (snake_case),
//      speed wird auf den erlaubten Bereich 0.7–1.2 geklemmt.
test("ElevenLabsTtsStream: voice_settings in der Init-Message", async () => {
  const srv = startServer();
  const tts = new ElevenLabsTtsStream(
    { ...makeOpts(), voiceSettings: { stability: 0.4, similarityBoost: 0.8, speed: 2 } },
    "call-1b",
  );
  await tts.start();

  await waitFor(() => srv.state.texts.length === 1);
  assert.deepEqual(JSON.parse(srv.state.texts[0]!), {
    text: " ",
    voice_settings: { stability: 0.4, similarity_boost: 0.8, speed: 1.2 },
  });

  tts.close();
  await srv.close();
});

// 2 ─ Audio kommt als Base64-JSON → dekodierter PCM-Buffer; isFinal → flushed.
test("ElevenLabsTtsStream: Base64-Audio und isFinal", async () => {
  const srv = startServer();
  const tts = new ElevenLabsTtsStream(makeOpts(), "call-2");
  const audio: Buffer[] = [];
  let flushed = 0;
  tts.on("audio", (b) => audio.push(b));
  tts.on("flushed", () => flushed++);
  await tts.start();

  const pcm = Buffer.from([1, 2, 3, 4, 5, 6]);
  srv.state.socket!.send(JSON.stringify({ audio: pcm.toString("base64") }));
  srv.state.socket!.send(JSON.stringify({ isFinal: true }));
  await waitFor(() => flushed === 1);
  assert.equal(audio.length, 1);
  assert.deepEqual([...audio[0]!], [...pcm]);

  tts.close();
  await srv.close();
});

// 2b ─ Verbrauchszählung: exakt die gesendeten text-Felder (Init-Space, Sätze inkl.
//      Trailing-Space, Flush-Space); Credits = Zeichen × 0,5 bei Flash-Modellen.
test("ElevenLabsTtsStream: usage() zählt gesendete Zeichen und Credits", async () => {
  const srv = startServer();
  const tts = new ElevenLabsTtsStream(makeOpts(), "call-2b");
  await tts.start();

  tts.sendText("Hallo Welt."); // → "Hallo Welt. " (12)
  tts.sendText("Zweiter Satz. "); // Trailing Space schon da (14)
  tts.flush(); // " " (1)
  await waitFor(() => srv.state.texts.length === 4);

  const u = tts.usage();
  assert.equal(u.provider, "eleven_labs");
  assert.equal(u.model, "eleven_flash_v2_5");
  assert.equal(u.characters, 1 + 12 + 14 + 1, "Init + zwei Sätze + Flush");
  assert.equal(u.credits, u.characters * 0.5, "Flash: 0,5 Credits/Zeichen");

  tts.close();
  await srv.close();
});

// 2c ─ Nicht gesendete Texte zählen nicht: clear() verwirft Gepuffertes vor dem Connect.
test("ElevenLabsTtsStream: usage() ignoriert per clear() verworfene Puffer", async () => {
  const srv = startServer();
  const tts = new ElevenLabsTtsStream(makeOpts(), "call-2c");
  tts.on("error", () => {}); // abgebrochener Lazy-Connect darf den Test nicht crashen
  // Ohne start(): sendText puffert und verbindet lazy — clear() räumt vorher ab.
  tts.sendText("Wird nie gesendet.");
  tts.clear();
  await new Promise((r) => setTimeout(r, 80));

  // Nur der ggf. schon aufgebaute Kontext (Init-Space) darf zählen, nie der Satz.
  assert.ok(tts.usage().characters <= 1, "verworfener Text wird nicht berechnet");
  tts.close();
  await srv.close();
});

// 3 ─ Barge-in: clear() trennt hart (kein Server-Clear) und stummschaltet in-flight-Audio;
//     der nächste Satz verbindet lazy neu (inkl. frischer Init-Message).
test("ElevenLabsTtsStream: clear() trennt, sendText verbindet neu", async () => {
  const srv = startServer();
  const tts = new ElevenLabsTtsStream(makeOpts(), "call-3");
  const audio: Buffer[] = [];
  tts.on("audio", (b) => audio.push(b));
  await tts.start();
  assert.equal(srv.state.connections, 1);

  tts.clear();
  // in-flight-Frame des alten Turns: Listener sind entfernt → bleibt stumm.
  srv.state.socket!.send(JSON.stringify({ audio: Buffer.from([7, 7]).toString("base64") }));
  await new Promise((r) => setTimeout(r, 80));
  assert.equal(audio.length, 0, "Audio nach clear() quarantänisiert");

  tts.sendText("Neuer Satz.");
  await waitFor(() => srv.state.connections === 2);
  await waitFor(() => srv.state.texts.some((t) => t.includes("Neuer Satz.")));
  const initCount = srv.state.texts.filter((t) => t === '{"text":" "}').length;
  assert.ok(initCount >= 2, "frische Init-Message auf der neuen Verbindung");

  srv.state.socket!.send(JSON.stringify({ audio: Buffer.from([8, 8]).toString("base64") }));
  await waitFor(() => audio.length === 1);
  assert.deepEqual([...audio[0]!], [8, 8]);

  tts.close();
  await srv.close();
});
