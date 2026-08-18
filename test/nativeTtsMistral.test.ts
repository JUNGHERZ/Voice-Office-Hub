import "./helpers/env.js"; // MUSS erster Import bleiben (ENV-Pinning vor config-Load)

import assert from "node:assert/strict";
import http from "node:http";
import { test } from "node:test";

import { detectWidth, MistralTtsStream, type MistralTtsOptions } from "../src/native/ttsMistral.js";
import { waitFor } from "./helpers/fakes.js";

/** float32-PCM @ 24 kHz als base64 (so beschreibt Mistrals Cookbook die Deltas). */
function floatDelta(samples: number, freqHz = 440): string {
  const f = Buffer.alloc(samples * 4);
  for (let i = 0; i < samples; i++) {
    f.writeFloatLE(0.5 * Math.sin((2 * Math.PI * freqHz * i) / 24000), i * 4);
  }
  return f.toString("base64");
}

/** Dieselbe Welle als linear16 — für den Fall, dass die API doch 16 Bit liefert. */
function int16Delta(samples: number, freqHz = 440): string {
  const b = Buffer.alloc(samples * 2);
  for (let i = 0; i < samples; i++) {
    b.writeInt16LE(Math.round(16000 * Math.sin((2 * Math.PI * freqHz * i) / 24000)), i * 2);
  }
  return b.toString("base64");
}

interface ServerState {
  requests: number;
  path?: string;
  auth?: string;
  bodies: Record<string, unknown>[];
  aborted: number;
}

/**
 * @param plan  Deltas pro Request; `hold` hält die Verbindung offen (Abbruch-Test).
 */
async function startServer(opts: { deltas?: string[]; status?: number; hold?: boolean } = {}) {
  const state: ServerState = { requests: 0, bodies: [], aborted: 0 };
  const server = http.createServer((req, res) => {
    state.requests += 1;
    state.path = req.url ?? "";
    state.auth = req.headers.authorization;
    let body = "";
    req.on("data", (c: Buffer) => (body += c.toString()));
    req.on("end", () => {
      try {
        state.bodies.push(JSON.parse(body) as Record<string, unknown>);
      } catch {
        state.bodies.push({});
      }
      if (opts.status && opts.status >= 400) {
        res.writeHead(opts.status, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "nope" }));
        return;
      }
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      for (const d of opts.deltas ?? []) {
        res.write(`event: speech.audio.delta\ndata: ${JSON.stringify({ type: "speech.audio.delta", audio_data: d })}\n\n`);
      }
      if (opts.hold) {
        res.on("close", () => {
          if (!res.writableEnded) state.aborted += 1;
        });
        return; // offen lassen
      }
      res.write("data: [DONE]\n\n");
      res.end();
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;
  // closeAllConnections: der Abbruch-Test lässt bewusst einen Socket offen —
  // server.close() allein würde ewig auf ihn warten.
  return {
    state,
    port,
    close: () =>
      new Promise<void>((r) => {
        server.closeAllConnections();
        server.close(() => r());
      }),
  };
}

function makeOpts(port: number, over: Partial<MistralTtsOptions> = {}): MistralTtsOptions {
  return {
    baseUrl: `http://127.0.0.1:${port}/v1`,
    apiKey: "test-mistral-key",
    model: "voxtral-mini-tts-latest",
    voiceId: "de_female",
    targetRate: 8000,
    concurrency: 1,
    ...over,
  };
}

// 1 ─ PCM-Breitenerkennung: float32 und int16 sicher unterscheiden, Stille offen lassen.
test("detectWidth: float32 vs. int16 vs. Stille", () => {
  assert.equal(detectWidth(Buffer.from(floatDelta(240), "base64")), "f32");
  assert.equal(detectWidth(Buffer.from(int16Delta(240), "base64")), "i16");
  assert.equal(detectWidth(Buffer.alloc(240)), undefined, "Stille ist nicht entscheidbar");
  assert.equal(detectWidth(Buffer.alloc(6)), "i16", "ungerade Wortzahl kann kein float32 sein");
});

// 2 ─ Request-Form: Pfad, Bearer-Auth und Body-Felder.
test("MistralTtsStream: POST /audio/speech mit Bearer und stream:true", async () => {
  const srv = await startServer({ deltas: [floatDelta(240)] });
  const tts = new MistralTtsStream(makeOpts(srv.port), "call-1");
  const audio: Buffer[] = [];
  const errors: string[] = [];
  tts.on("audio", (b) => audio.push(b));
  tts.on("error", (e) => errors.push(e));

  tts.sendText("Guten Tag.");
  await waitFor(() => srv.state.requests === 1 && audio.length > 0);

  assert.equal(srv.state.path, "/v1/audio/speech");
  assert.equal(srv.state.auth, "Bearer test-mistral-key");
  assert.deepEqual(srv.state.bodies[0], {
    model: "voxtral-mini-tts-latest",
    input: "Guten Tag.",
    voice_id: "de_female",
    response_format: "pcm",
    stream: true,
  });

  tts.close();
  await srv.close();
});

// 3 ─ 24-kHz-Deltas werden auf die System-Rate (8 kHz) heruntergerechnet.
test("MistralTtsStream: resampelt 24 kHz → 8 kHz", async () => {
  const srv = await startServer({ deltas: [floatDelta(2400)] });
  const tts = new MistralTtsStream(makeOpts(srv.port), "call-2");
  const audio: Buffer[] = [];
  const flushed: number[] = [];
  tts.on("audio", (b) => audio.push(b));
  tts.on("flushed", () => flushed.push(1));
  tts.on("error", () => {});

  tts.sendText("Ein Satz.");
  tts.flush();
  await waitFor(() => flushed.length === 1);

  const samples = audio.reduce((n, b) => n + b.length / 2, 0);
  assert.ok(Math.abs(samples - 800) <= 2, `erwartet ~800 Samples @ 8 kHz, waren ${samples}`);

  tts.close();
  await srv.close();
});

// 4 ─ int16-Deltas (falls die API doch 16 Bit liefert) laufen ohne Sonderfall durch.
test("MistralTtsStream: int16-Deltas werden erkannt und verarbeitet", async () => {
  const srv = await startServer({ deltas: [int16Delta(2400)] });
  const tts = new MistralTtsStream(makeOpts(srv.port), "call-3");
  const audio: Buffer[] = [];
  tts.on("audio", (b) => audio.push(b));
  tts.on("error", () => {});

  tts.sendText("Ein Satz.");
  await waitFor(() => audio.length > 0);

  const samples = audio.reduce((n, b) => n + b.length / 2, 0);
  assert.ok(Math.abs(samples - 800) <= 2, `erwartet ~800 Samples, waren ${samples}`);

  tts.close();
  await srv.close();
});

// 5 ─ Zwei Sätze = zwei Requests, streng nacheinander (Reihenfolge des Audios).
test("MistralTtsStream: ein Request pro Satz, seriell", async () => {
  const srv = await startServer({ deltas: [floatDelta(240)] });
  const tts = new MistralTtsStream(makeOpts(srv.port), "call-4");
  const flushed: number[] = [];
  tts.on("flushed", () => flushed.push(1));
  tts.on("error", () => {});

  tts.sendText("Erster Satz.");
  tts.sendText("Zweiter Satz.");
  tts.flush();
  await waitFor(() => flushed.length === 1);

  assert.equal(srv.state.requests, 2);
  assert.equal(srv.state.bodies[0]?.input, "Erster Satz.");
  assert.equal(srv.state.bodies[1]?.input, "Zweiter Satz.");

  tts.close();
  await srv.close();
});

// 6 ─ Barge-in bricht den laufenden Request wirklich auf der Leitung ab.
test("MistralTtsStream: clear() bricht den laufenden Request ab", async () => {
  const srv = await startServer({ deltas: [floatDelta(240)], hold: true });
  const tts = new MistralTtsStream(makeOpts(srv.port), "call-5");
  const audio: Buffer[] = [];
  const errors: string[] = [];
  tts.on("audio", (b) => audio.push(b));
  tts.on("error", (e) => errors.push(e));

  tts.sendText("Ein langer Satz.");
  await waitFor(() => audio.length > 0);

  tts.clear();
  await waitFor(() => srv.state.aborted === 1);
  assert.equal(errors.length, 0, "ein Abbruch ist kein Fehler");

  tts.close();
  await srv.close();
});

// 7 ─ HTTP-Fehler meldet sich als error-Event samt Status (Key widerrufen o. Ä.).
test("MistralTtsStream: HTTP-Fehler wird gemeldet", async () => {
  const srv = await startServer({ status: 401 });
  const tts = new MistralTtsStream(makeOpts(srv.port), "call-6");
  const errors: string[] = [];
  tts.on("error", (e) => errors.push(e));

  tts.sendText("Ein Satz.");
  await waitFor(() => errors.length === 1);
  assert.match(errors[0] ?? "", /401/);

  tts.close();
  await srv.close();
});
