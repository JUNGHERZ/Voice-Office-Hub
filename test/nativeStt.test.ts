import "./helpers/env.js"; // MUSS erster Import bleiben (ENV-Pinning vor config-Load)

import assert from "node:assert/strict";
import { test } from "node:test";

import { WebSocketServer, type WebSocket as ServerSocket } from "ws";

import { FluxSttStream } from "../src/native/sttStream.js";
import { waitFor } from "./helpers/fakes.js";

const PORT = 18094;

function makeOpts(overrides: Partial<ConstructorParameters<typeof FluxSttStream>[0]> = {}) {
  return {
    url: `ws://127.0.0.1:${PORT}`,
    apiKey: "test-dg-key",
    model: "flux-general-multi",
    sampleRate: 8000,
    encoding: "linear16",
    languageHints: ["de", "en"],
    keyterms: ["Loupz"],
    eotThreshold: 0.7,
    eotTimeoutMs: 3000,
    ...overrides,
  };
}

/** Mini-Flux-Server: fängt Verbindung, URL, Header und Nachrichten ein. */
function startServer() {
  const wss = new WebSocketServer({ port: PORT });
  const state: {
    connections: number;
    url?: string;
    auth?: string;
    socket?: ServerSocket;
    binary: Buffer[];
    texts: string[];
  } = { connections: 0, binary: [], texts: [] };
  wss.on("connection", (socket, req) => {
    state.connections += 1;
    state.url = req.url ?? "";
    state.auth = req.headers.authorization;
    state.socket = socket;
    socket.on("message", (data: Buffer, isBinary: boolean) => {
      if (isBinary) state.binary.push(Buffer.from(data));
      else state.texts.push(data.toString());
    });
  });
  return { wss, state, close: () => new Promise<void>((r) => wss.close(() => r())) };
}

// 1 ─ Verbindung: Query-Parameter (inkl. wiederholter language_hint), Token-Auth, Audio-Durchreiche.
test("FluxSttStream: URL-Parameter, Auth und Audio-Durchreiche", async () => {
  const srv = startServer();
  const stt = new FluxSttStream(makeOpts(), "call-1");
  await stt.start();

  const url = new URL(`ws://x${srv.state.url}`);
  assert.equal(url.searchParams.get("model"), "flux-general-multi");
  assert.equal(url.searchParams.get("encoding"), "linear16");
  assert.equal(url.searchParams.get("sample_rate"), "8000");
  assert.deepEqual(url.searchParams.getAll("language_hint"), ["de", "en"]);
  assert.deepEqual(url.searchParams.getAll("keyterm"), ["Loupz"]);
  assert.equal(url.searchParams.get("eot_threshold"), "0.7");
  assert.equal(url.searchParams.get("eot_timeout_ms"), "3000");
  assert.equal(srv.state.auth, "Token test-dg-key");

  stt.sendAudio(Buffer.from([1, 2, 3, 4]));
  await waitFor(() => srv.state.binary.length === 1);
  assert.deepEqual([...srv.state.binary[0]!], [1, 2, 3, 4]);

  // close() meldet den Stream-Abschluss sauber an den Server.
  stt.close();
  await waitFor(() => srv.state.texts.some((t) => t.includes("CloseStream")));
  await srv.close();
});

// 2 ─ TurnInfo-Mapping: StartOfTurn/EndOfTurn → speechStarted/turnEnded(transcript).
test("FluxSttStream: TurnInfo → speechStarted/turnEnded", async () => {
  const srv = startServer();
  const stt = new FluxSttStream(makeOpts({ model: "flux-general-en" }), "call-2");
  const events: Array<[string, string?]> = [];
  stt.on("speechStarted", () => events.push(["speechStarted"]));
  stt.on("turnEnded", (t) => events.push(["turnEnded", t]));
  await stt.start();

  // flux-general-en: keine language_hints im Query (nur multi).
  assert.equal(new URL(`ws://x${srv.state.url}`).searchParams.getAll("language_hint").length, 0);

  srv.state.socket!.send(JSON.stringify({ type: "Connected", request_id: "r1" }));
  srv.state.socket!.send(JSON.stringify({ type: "TurnInfo", event: "StartOfTurn", transcript: "" }));
  srv.state.socket!.send(JSON.stringify({ type: "TurnInfo", event: "Update", transcript: "hal" }));
  srv.state.socket!.send(JSON.stringify({ type: "TurnInfo", event: "EndOfTurn", transcript: "hallo welt" }));
  await waitFor(() => events.length === 2);
  assert.deepEqual(events, [["speechStarted"], ["turnEnded", "hallo welt"]]);

  stt.close();
  await srv.close();
});

// 3 ─ Eager-Pfad: EagerEndOfTurn/TurnResumed werden 1:1 gemeldet (v1: nur geloggt).
test("FluxSttStream: EagerEndOfTurn/TurnResumed-Mapping", async () => {
  const srv = startServer();
  const stt = new FluxSttStream(makeOpts({ eagerEotThreshold: 0.5 }), "call-3");
  const events: Array<[string, string?]> = [];
  stt.on("eagerTurnEnded", (t) => events.push(["eager", t]));
  stt.on("turnResumed", () => events.push(["resumed"]));
  await stt.start();

  assert.equal(new URL(`ws://x${srv.state.url}`).searchParams.get("eager_eot_threshold"), "0.5");
  srv.state.socket!.send(JSON.stringify({ type: "TurnInfo", event: "EagerEndOfTurn", transcript: "ich möchte" }));
  srv.state.socket!.send(JSON.stringify({ type: "TurnInfo", event: "TurnResumed" }));
  await waitFor(() => events.length === 2);
  assert.deepEqual(events, [["eager", "ich möchte"], ["resumed"]]);

  stt.close();
  await srv.close();
});

// 4 ─ Fehlerpfade: Server-Close → close-Event + erneutes start() verbindet frisch;
//     toter Port → start() wirft.
test("FluxSttStream: Server-Close, Reconnect-Fähigkeit und Connect-Fehler", async () => {
  const srv = startServer();
  const stt = new FluxSttStream(makeOpts(), "call-4");
  let closeCode = 0;
  stt.on("close", (code) => (closeCode = code));
  await stt.start();
  srv.state.socket!.close(4001);
  await waitFor(() => closeCode === 4001);

  // Grundlage des Orchestrator-Reconnects: nach einem Drop ist start() erneut möglich.
  await stt.start();
  assert.equal(srv.state.connections, 2, "zweites start() baut eine frische Verbindung");
  stt.close();
  await srv.close();

  const dead = new FluxSttStream(makeOpts({ url: "ws://127.0.0.1:18093" }), "call-5");
  await assert.rejects(dead.start(), /Flux-STT-Verbindung/);
});

// ── Flux Update (0.12.2) ────────────────────────────────────────────────────
// Der einzige Kanal, über den wir erfahren, was der Anrufer sagt, WÄHREND er
// spricht. Bis 0.12.1 wurde er verworfen. `transcript` ist kumulativ, nicht das
// neue Stück — genau das macht ihn als Grundlage einer Gesprächssteuerung
// brauchbar und ist die Eigenschaft, die hier festgehalten wird.
test("FluxSttStream: Update wird mit kumulativem Transkript und Konfidenz gemeldet", async () => {
  const srv = startServer();
  const stt = new FluxSttStream(makeOpts(), "call-update");
  const updates: Array<{ transcript: string; confidence: number; turnIndex?: number }> = [];
  const other: string[] = [];
  stt.on("update", (ev) => updates.push(ev));
  stt.on("speechStarted", () => other.push("speechStarted"));
  stt.on("turnEnded", () => other.push("turnEnded"));
  await stt.start();

  const send = (m: Record<string, unknown>) =>
    srv.state.socket!.send(JSON.stringify({ type: "TurnInfo", ...m }));
  send({ event: "StartOfTurn", transcript: "" });
  send({ event: "Update", transcript: "ich", end_of_turn_confidence: 0.12, turn_index: 3 });
  send({ event: "Update", transcript: "ich möchte gern", end_of_turn_confidence: 0.48, turn_index: 3 });
  send({ event: "EndOfTurn", transcript: "ich möchte gern wissen", end_of_turn_confidence: 0.91 });
  await waitFor(() => other.length === 2);

  assert.deepEqual(updates, [
    { transcript: "ich", confidence: 0.12, turnIndex: 3 },
    { transcript: "ich möchte gern", confidence: 0.48, turnIndex: 3 },
  ]);
  assert.ok(
    updates[1]!.transcript.startsWith(updates[0]!.transcript),
    "kumulativ: jeder Stand enthält den vorigen",
  );
  assert.deepEqual(other, ["speechStarted", "turnEnded"], "Update ist ein eigener Kanal");

  stt.close();
  await srv.close();
});

test("FluxSttStream: Update ohne Konfidenzfeld meldet 0 statt undefined", async () => {
  const srv = startServer();
  const stt = new FluxSttStream(makeOpts(), "call-update-2");
  const updates: Array<{ confidence: number; turnIndex?: number }> = [];
  stt.on("update", (ev) => updates.push(ev));
  await stt.start();

  srv.state.socket!.send(JSON.stringify({ type: "TurnInfo", event: "Update", transcript: "hm" }));
  await waitFor(() => updates.length === 1);
  assert.equal(updates[0]!.confidence, 0);
  assert.equal("turnIndex" in updates[0]!, false, "fehlender Index wird nicht erfunden");

  stt.close();
  await srv.close();
});
