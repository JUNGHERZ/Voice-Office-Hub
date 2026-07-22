import "./helpers/env.js"; // MUSS erster Import bleiben (ENV-Pinning vor config-Load)

import assert from "node:assert/strict";
import { test } from "node:test";

import { WebSocketServer, type WebSocket as ServerSocket } from "ws";

import { AuraTtsStream } from "../src/native/ttsStream.js";
import { waitFor } from "./helpers/fakes.js";

const PORT = 18096;

function makeOpts() {
  return {
    url: `ws://127.0.0.1:${PORT}`,
    apiKey: "test-dg-key",
    model: "aura-2-viktoria-de",
    encoding: "linear16",
    sampleRate: 8000,
  };
}

function startServer() {
  const wss = new WebSocketServer({ port: PORT });
  const state: {
    connections: number;
    url?: string;
    auth?: string;
    socket?: ServerSocket;
    texts: string[];
  } = { connections: 0, texts: [] };
  wss.on("connection", (socket, req) => {
    state.connections += 1;
    state.url = req.url ?? "";
    state.auth = req.headers.authorization;
    state.socket = socket;
    socket.on("message", (data: Buffer, isBinary: boolean) => {
      if (!isBinary) state.texts.push(data.toString());
    });
  });
  return { wss, state, close: () => new Promise<void>((r) => wss.close(() => r())) };
}

// 1 ─ Params/Auth, Speak/Flush-Wire-Format, Binär → audio, Flushed → flushed(sequence_id).
test("AuraTtsStream: Speak/Flush, Audio-Events und Flushed", async () => {
  const srv = startServer();
  const tts = new AuraTtsStream(makeOpts(), "call-1");
  const audio: Buffer[] = [];
  const flushed: Array<number | undefined> = [];
  tts.on("audio", (b) => audio.push(b));
  tts.on("flushed", (s) => flushed.push(s));
  await tts.start();

  const url = new URL(`ws://x${srv.state.url}`);
  assert.equal(url.searchParams.get("model"), "aura-2-viktoria-de");
  assert.equal(url.searchParams.get("encoding"), "linear16");
  assert.equal(url.searchParams.get("sample_rate"), "8000");
  assert.equal(url.searchParams.get("container"), "none");
  assert.equal(srv.state.auth, "Token test-dg-key");

  tts.sendText("Hallo Welt.");
  tts.flush();
  await waitFor(() => srv.state.texts.length === 2);
  assert.deepEqual(JSON.parse(srv.state.texts[0]!), { type: "Speak", text: "Hallo Welt." });
  assert.deepEqual(JSON.parse(srv.state.texts[1]!), { type: "Flush" });

  srv.state.socket!.send(Buffer.from([9, 9, 9, 9]));
  srv.state.socket!.send(JSON.stringify({ type: "Flushed", sequence_id: 0 }));
  await waitFor(() => flushed.length === 1);
  assert.equal(audio.length, 1);
  assert.deepEqual(flushed, [0]);

  tts.close();
  await srv.close();
});

// 2 ─ Clear-Fenster: nach clear() werden Frames unterdrückt, bis der Server Cleared bestätigt.
test("AuraTtsStream: Clear unterdrückt Audio bis Cleared", async () => {
  const srv = startServer();
  const tts = new AuraTtsStream(makeOpts(), "call-2");
  const audio: Buffer[] = [];
  tts.on("audio", (b) => audio.push(b));
  await tts.start();

  tts.clear();
  await waitFor(() => srv.state.texts.length === 1);
  assert.deepEqual(JSON.parse(srv.state.texts[0]!), { type: "Clear" });

  srv.state.socket!.send(Buffer.from([1, 1])); // verspäteter Frame des alten Turns → unterdrückt
  srv.state.socket!.send(JSON.stringify({ type: "Cleared", sequence_id: 0 }));
  srv.state.socket!.send(Buffer.from([2, 2])); // neuer Turn → fließt wieder
  await waitFor(() => audio.length === 1);
  assert.deepEqual([...audio[0]!], [2, 2]);

  tts.close();
  await srv.close();
});

// 3 ─ Idle-Robustheit: Server trennt; sendText() verbindet lazy neu und liefert den Text nach.
test("AuraTtsStream: Reconnect bei sendText nach Server-Trennung", async () => {
  const srv = startServer();
  const tts = new AuraTtsStream(makeOpts(), "call-3");
  let closeCode = 0;
  tts.on("close", (code) => (closeCode = code));
  await tts.start();
  assert.equal(srv.state.connections, 1);

  srv.state.socket!.close(4000); // Idle-Timeout simulieren
  await waitFor(() => closeCode === 4000);

  tts.sendText("Nach der Pause.");
  await waitFor(() => srv.state.connections === 2);
  await waitFor(() => srv.state.texts.some((t) => t.includes("Nach der Pause.")));
  const last = JSON.parse(srv.state.texts[srv.state.texts.length - 1]!);
  assert.deepEqual(last, { type: "Speak", text: "Nach der Pause." });

  tts.close();
  await srv.close();
});

// 4 ─ Verbrauchszählung: usage() zählt nur tatsächlich gesendete Speak-Texte.
test("AuraTtsStream: usage() zählt gesendete Zeichen", async () => {
  const srv = startServer();
  const tts = new AuraTtsStream(makeOpts(), "call-usage");
  await tts.start();

  tts.sendText("Hallo Welt."); // 11 Zeichen
  tts.sendText("Zweiter Satz."); // 13 Zeichen
  tts.flush(); // Flush ist kein Text → zählt nicht
  await waitFor(() => srv.state.texts.length === 3);

  const u = tts.usage();
  assert.equal(u.provider, "deepgram");
  assert.equal(u.model, "aura-2-viktoria-de");
  assert.equal(u.characters, 24, "nur Speak-Texte zählen");
  assert.equal(u.credits, undefined, "Deepgram hat kein Credit-Modell");

  tts.close();
  await srv.close();
});
