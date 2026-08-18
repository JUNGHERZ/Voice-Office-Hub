import "./helpers/env.js"; // MUSS erster Import bleiben (ENV-Pinning vor config-Load)

import assert from "node:assert/strict";
import http from "node:http";
import { test } from "node:test";

import {
  pickSpeechifyFormat,
  SpeechifyTtsStream,
  stripRiffHeader,
  type SpeechifyTtsOptions,
} from "../src/native/ttsSpeechify.js";
import { waitFor } from "./helpers/fakes.js";

async function startServer(opts: { bytes?: number; riff?: boolean; status?: number } = {}) {
  const state: { requests: number; path?: string; auth?: string; bodies: Record<string, unknown>[] } = {
    requests: 0,
    bodies: [],
  };
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
        res.writeHead(opts.status);
        res.end("nope");
        return;
      }
      res.writeHead(200, { "Content-Type": "audio/pcm" });
      const pcm = Buffer.alloc(opts.bytes ?? 320, 5);
      if (opts.riff) {
        const head = Buffer.alloc(44);
        head.write("RIFF", 0, "ascii");
        head.writeUInt32LE(36 + pcm.length, 4);
        head.write("WAVE", 8, "ascii");
        head.write("fmt ", 12, "ascii");
        head.writeUInt32LE(16, 16);
        head.write("data", 36, "ascii");
        head.writeUInt32LE(pcm.length, 40);
        res.write(Buffer.concat([head, pcm]));
      } else {
        res.write(pcm);
      }
      res.end();
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const addr = server.address();
  return {
    state,
    port: typeof addr === "object" && addr ? addr.port : 0,
    close: () =>
      new Promise<void>((r) => {
        server.closeAllConnections();
        server.close(() => r());
      }),
  };
}

function makeOpts(port: number, over: Partial<SpeechifyTtsOptions> = {}): SpeechifyTtsOptions {
  return {
    baseUrl: `http://127.0.0.1:${port}/v1`,
    apiKey: "sp-test-key",
    voiceId: "harper_32",
    model: "simba-3.0",
    language: "de-DE",
    targetRate: 8000,
    concurrency: 1,
    ...over,
  };
}

// 1 ─ 8 und 16 kHz sind native Formate.
test("Speechify: Ausgabeformat je System-Rate", () => {
  assert.deepEqual(pickSpeechifyFormat(8000), { format: "pcm_8000", sourceRate: 8000 });
  assert.deepEqual(pickSpeechifyFormat(16000), { format: "pcm_16000", sourceRate: 16000 });
});

// 2 ─ Ein doch mitgelieferter WAV-Header wäre am Satzanfang als Knacks hörbar.
test("Speechify: RIFF-Header wird abgeschnitten, roher PCM bleibt unberührt", () => {
  const pcm = Buffer.alloc(8, 9);
  assert.deepEqual(stripRiffHeader(pcm), pcm, "ohne Header nichts anfassen");

  const head = Buffer.alloc(44);
  head.write("RIFF", 0, "ascii");
  head.write("WAVE", 8, "ascii");
  head.write("fmt ", 12, "ascii");
  head.writeUInt32LE(16, 16);
  head.write("data", 36, "ascii");
  head.writeUInt32LE(pcm.length, 40);
  assert.deepEqual(stripRiffHeader(Buffer.concat([head, pcm])), pcm);
});

// 3 ─ Request-Form: Pfad, Bearer-Auth, Body inkl. Default-Modell 3.0.
test("SpeechifyTtsStream: POST /audio/stream mit Bearer und pcm_8000", async () => {
  const srv = await startServer({ bytes: 640 });
  const tts = new SpeechifyTtsStream(makeOpts(srv.port), "call-1");
  const audio: Buffer[] = [];
  tts.on("audio", (b) => audio.push(b));
  tts.on("error", () => {});

  tts.sendText("Guten Tag.");
  await waitFor(() => audio.length > 0);

  assert.equal(srv.state.path, "/v1/audio/stream");
  assert.equal(srv.state.auth, "Bearer sp-test-key");
  assert.deepEqual(srv.state.bodies[0], {
    input: "Guten Tag.",
    voice_id: "harper_32",
    // simba-3.0, nicht 3.2 — nur 3.0 kann Deutsch.
    model: "simba-3.0",
    language: "de-DE",
    output_format: "pcm_8000",
  });
  assert.equal(audio.reduce((n, b) => n + b.length, 0), 640, "8 kHz nativ → keine Umrechnung");

  tts.close();
  await srv.close();
});

// 4 ─ Auch mit Container-Antwort kommt nur Nutzaudio heraus.
test("SpeechifyTtsStream: WAV-Antwort liefert trotzdem reines PCM", async () => {
  const srv = await startServer({ bytes: 320, riff: true });
  const tts = new SpeechifyTtsStream(makeOpts(srv.port), "call-2");
  const audio: Buffer[] = [];
  tts.on("audio", (b) => audio.push(b));
  tts.on("error", () => {});

  tts.sendText("Ein Satz.");
  await waitFor(() => audio.length > 0);
  assert.equal(audio.reduce((n, b) => n + b.length, 0), 320, "44 Byte Header müssen weg");

  tts.close();
  await srv.close();
});

// 5 ─ Ein Request je Satz, streng seriell.
test("SpeechifyTtsStream: ein Request pro Satz", async () => {
  const srv = await startServer();
  const tts = new SpeechifyTtsStream(makeOpts(srv.port), "call-3");
  const flushed: number[] = [];
  tts.on("flushed", () => flushed.push(1));
  tts.on("error", () => {});

  tts.sendText("Erster Satz.");
  tts.sendText("Zweiter Satz.");
  tts.flush();
  await waitFor(() => flushed.length === 1);
  assert.equal(srv.state.requests, 2);

  tts.close();
  await srv.close();
});

// 6 ─ HTTP-Fehler meldet sich mit Status.
test("SpeechifyTtsStream: HTTP-Fehler wird gemeldet", async () => {
  const srv = await startServer({ status: 401 });
  const tts = new SpeechifyTtsStream(makeOpts(srv.port), "call-4");
  const errors: string[] = [];
  tts.on("error", (e) => errors.push(e));

  tts.sendText("Ein Satz.");
  await waitFor(() => errors.length === 1);
  assert.match(errors[0] ?? "", /401/);

  tts.close();
  await srv.close();
});
