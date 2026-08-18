import "./helpers/env.js"; // MUSS erster Import bleiben (ENV-Pinning vor config-Load)

import assert from "node:assert/strict";
import http from "node:http";
import { test } from "node:test";

import {
  AZURE_SPEED_MAX,
  AZURE_SPEED_MIN,
  AzureTtsStream,
  azureCanServe,
  azureEndpointFor,
  azureRate,
  clampAzureSpeed,
  escapeXml,
  localeFromVoice,
  pickOutputFormat,
  type AzureTtsOptions,
} from "../src/native/ttsAzure.js";
import { waitFor } from "./helpers/fakes.js";

interface ServerState {
  requests: number;
  path?: string;
  headers: Record<string, string | undefined>[];
  bodies: string[];
}

async function startServer(opts: { bytes?: number; status?: number; hold?: boolean } = {}) {
  const state: ServerState = { requests: 0, headers: [], bodies: [] };
  let aborted = 0;
  const server = http.createServer((req, res) => {
    state.requests += 1;
    state.path = req.url ?? "";
    state.headers.push({
      key: req.headers["ocp-apim-subscription-key"] as string,
      ct: req.headers["content-type"] as string,
      fmt: req.headers["x-microsoft-outputformat"] as string,
      ua: req.headers["user-agent"] as string,
    });
    let body = "";
    req.on("data", (c: Buffer) => (body += c.toString()));
    req.on("end", () => {
      state.bodies.push(body);
      if (opts.status && opts.status >= 400) {
        res.writeHead(opts.status);
        res.end("nope");
        return;
      }
      res.writeHead(200, { "Content-Type": "audio/basic" });
      res.write(Buffer.alloc(opts.bytes ?? 320, 7));
      if (opts.hold) {
        res.on("close", () => {
          if (!res.writableEnded) aborted += 1;
        });
        return;
      }
      res.end();
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const addr = server.address();
  return {
    state,
    abortedCount: () => aborted,
    port: typeof addr === "object" && addr ? addr.port : 0,
    close: () =>
      new Promise<void>((r) => {
        server.closeAllConnections();
        server.close(() => r());
      }),
  };
}

function makeOpts(port: number, over: Partial<AzureTtsOptions> = {}): AzureTtsOptions {
  return {
    endpoint: `http://127.0.0.1:${port}/cognitiveservices/v1`,
    apiKey: "az-test-key",
    voice: "de-DE-KatjaNeural",
    targetRate: 8000,
    concurrency: 1,
    ...over,
  };
}

// 1 ─ 8 und 16 kHz sind native Formate; erst exotische Raten brauchen den Resampler.
test("Azure: Ausgabeformat je System-Rate", () => {
  assert.deepEqual(pickOutputFormat(8000), { format: "raw-8khz-16bit-mono-pcm", sourceRate: 8000 });
  assert.deepEqual(pickOutputFormat(16000), { format: "raw-16khz-16bit-mono-pcm", sourceRate: 16000 });
  // Nicht-natives Ziel → 24 kHz und resampeln.
  assert.equal(pickOutputFormat(12000).sourceRate, 24000);
  assert.equal(azureCanServe(8000), true);
});

// 2 ─ SSML-Escaping. Ohne das zerreißt ein "&" aus der LLM-Antwort das Dokument
//     und Azure antwortet mit 400 — der Satz fiele stumm aus.
test("Azure: Sonderzeichen werden XML-escaped", () => {
  assert.equal(escapeXml(`Meyer & Sohn <GmbH> "test"`), "Meyer &amp; Sohn &lt;GmbH&gt; &quot;test&quot;");
});

test("Azure: Locale kommt aus dem Stimmnamen", () => {
  assert.equal(localeFromVoice("de-DE-KatjaNeural"), "de-DE");
  assert.equal(localeFromVoice("en-GB-SoniaNeural"), "en-GB");
  assert.equal(localeFromVoice("kaputt"), "en-US");
});

test("Azure: Endpoint aus der Region", () => {
  assert.equal(
    azureEndpointFor("germanywestcentral"),
    "https://germanywestcentral.tts.speech.microsoft.com/cognitiveservices/v1",
  );
});

// 3 ─ Vollständige Request-Form gegen einen echten lokalen Server.
test("AzureTtsStream: Header, SSML-Body und Audio", async () => {
  const srv = await startServer({ bytes: 640 });
  const tts = new AzureTtsStream(makeOpts(srv.port), "call-1");
  const audio: Buffer[] = [];
  tts.on("audio", (b) => audio.push(b));
  tts.on("error", () => {});

  tts.sendText("Guten Tag & willkommen.");
  await waitFor(() => audio.length > 0);

  assert.equal(srv.state.path, "/cognitiveservices/v1");
  const h = srv.state.headers[0];
  assert.equal(h?.key, "az-test-key");
  assert.equal(h?.ct, "application/ssml+xml");
  assert.equal(h?.fmt, "raw-8khz-16bit-mono-pcm");
  assert.ok(h?.ua, "User-Agent ist laut Doku Pflicht");
  assert.equal(
    srv.state.bodies[0],
    "<speak version='1.0' xml:lang='de-DE'>" +
      "<voice name='de-DE-KatjaNeural'>Guten Tag &amp; willkommen.</voice></speak>",
  );
  // 8 kHz nativ → keine Umrechnung, Byte-Anzahl bleibt.
  assert.equal(audio.reduce((n, b) => n + b.length, 0), 640);

  tts.close();
  await srv.close();
});

// 4 ─ Explizit gesetzte Sprache schlägt die Ableitung aus dem Stimmnamen.
test("AzureTtsStream: speak.language überschreibt die Locale", async () => {
  const srv = await startServer();
  const tts = new AzureTtsStream(makeOpts(srv.port, { language: "de-AT" }), "call-2");
  tts.on("error", () => {});
  tts.sendText("Servus.");
  await waitFor(() => srv.state.bodies.length === 1);
  assert.ok(srv.state.bodies[0]?.includes("xml:lang='de-AT'"));
  tts.close();
  await srv.close();
});

// 5 ─ Ein Request je Satz, streng der Reihe nach.
test("AzureTtsStream: ein Request pro Satz", async () => {
  const srv = await startServer();
  const tts = new AzureTtsStream(makeOpts(srv.port), "call-3");
  const flushed: number[] = [];
  tts.on("flushed", () => flushed.push(1));
  tts.on("error", () => {});

  tts.sendText("Erster Satz.");
  tts.sendText("Zweiter Satz.");
  tts.flush();
  await waitFor(() => flushed.length === 1);

  assert.equal(srv.state.requests, 2);
  assert.ok(srv.state.bodies[1]?.includes("Zweiter Satz."));
  tts.close();
  await srv.close();
});

// 6 ─ Barge-in bricht den laufenden Request auf der Leitung ab.
test("AzureTtsStream: clear() bricht den laufenden Request ab", async () => {
  const srv = await startServer({ hold: true });
  const tts = new AzureTtsStream(makeOpts(srv.port), "call-4");
  const audio: Buffer[] = [];
  const errors: string[] = [];
  tts.on("audio", (b) => audio.push(b));
  tts.on("error", (e) => errors.push(e));

  tts.sendText("Ein langer Satz.");
  await waitFor(() => audio.length > 0);
  tts.clear();
  await waitFor(() => srv.abortedCount() === 1);
  assert.equal(errors.length, 0, "ein Abbruch ist kein Fehler");

  tts.close();
  await srv.close();
});

// 7 ─ HTTP-Fehler meldet sich mit Status (falscher Key, falsche Region …).
test("AzureTtsStream: HTTP-Fehler wird gemeldet", async () => {
  const srv = await startServer({ status: 401 });
  const tts = new AzureTtsStream(makeOpts(srv.port), "call-5");
  const errors: string[] = [];
  tts.on("error", (e) => errors.push(e));

  tts.sendText("Ein Satz.");
  await waitFor(() => errors.length === 1);
  assert.match(errors[0] ?? "", /401/);
  tts.close();
  await srv.close();
});

// ── Sprechtempo (0.8.10) ────────────────────────────────────────────────────

test("Azure: speak.speed wird zum prosody-Prozentwert", () => {
  assert.equal(azureRate(1), "+0%");
  assert.equal(azureRate(1.2), "+20%");
  assert.equal(azureRate(0.9), "-10%");
  // Ausserhalb des bedienten Bereichs wird geklemmt, nicht durchgereicht.
  assert.equal(azureRate(5), `+${Math.round((AZURE_SPEED_MAX - 1) * 100)}%`);
  assert.equal(azureRate(0.1), `${Math.round((AZURE_SPEED_MIN - 1) * 100)}%`);
});

test("Azure: clampAzureSpeed haelt die Grenzen ein", () => {
  assert.equal(clampAzureSpeed(1.2), 1.2);
  assert.equal(clampAzureSpeed(9), AZURE_SPEED_MAX);
  assert.equal(clampAzureSpeed(0), AZURE_SPEED_MIN);
});

test("AzureTtsStream: gesetztes Tempo landet als prosody im SSML", async () => {
  const srv = await startServer();
  const tts = new AzureTtsStream(makeOpts(srv.port, { speed: 1.2 }), "call-speed");
  tts.on("error", () => {});
  tts.sendText("Guten Tag.");
  await waitFor(() => srv.state.bodies.length === 1);
  const body = srv.state.bodies[0] ?? "";
  assert.ok(body.includes("<prosody rate='+20%'>"), body);
  assert.ok(body.includes("</prosody>"), body);
  tts.close();
  await srv.close();
});

test("AzureTtsStream: ohne Tempo bleibt das SSML unveraendert schlank", async () => {
  const srv = await startServer();
  const tts = new AzureTtsStream(makeOpts(srv.port), "call-nospeed");
  tts.on("error", () => {});
  tts.sendText("Guten Tag.");
  await waitFor(() => srv.state.bodies.length === 1);
  assert.ok(!(srv.state.bodies[0] ?? "").includes("prosody"));
  tts.close();
  await srv.close();
});

test("AzureTtsStream: speed=1 erzeugt kein wirkungsloses prosody-Tag", async () => {
  const srv = await startServer();
  const tts = new AzureTtsStream(makeOpts(srv.port, { speed: 1 }), "call-speed1");
  tts.on("error", () => {});
  tts.sendText("Guten Tag.");
  await waitFor(() => srv.state.bodies.length === 1);
  assert.ok(!(srv.state.bodies[0] ?? "").includes("prosody"));
  tts.close();
  await srv.close();
});
