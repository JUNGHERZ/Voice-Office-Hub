import "./helpers/env.js"; // MUSS erster Import bleiben (ENV-Pinning vor config-Load)

import assert from "node:assert/strict";
import http from "node:http";
import { test, before, after } from "node:test";

import { createSentenceChunker } from "../src/native/sentences.js";
import { ConversationHistory } from "../src/native/history.js";
import { streamChatCompletion, toOpenAiTools } from "../src/native/llmStream.js";

const PORT = 18095;
const BASE = `http://127.0.0.1:${PORT}`;

/** SSE-Zeile im Chat-Completions-Format (wie live gegen Requesty verifiziert). */
const sse = (obj: unknown) => `data: ${JSON.stringify(obj)}\n\n`;
const delta = (d: Record<string, unknown>, finish: string | null = null) =>
  sse({ choices: [{ delta: d, finish_reason: finish, index: 0 }] });

let lastRequestBody: Record<string, unknown> = {};
let server: http.Server;

before(async () => {
  server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      lastRequestBody = JSON.parse(body) as Record<string, unknown>;
      const model = String(lastRequestBody.model ?? "");

      if (model === "szenario/bad") {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end('{"error":{"message":"kaputtes Modell"}}');
        return;
      }

      res.writeHead(200, { "Content-Type": "text/event-stream" });
      if (model === "szenario/text") {
        res.write(delta({ role: "assistant" }));
        res.write(delta({ content: "Hal" }));
        res.write(delta({ content: "lo!" }));
        res.write(delta({}, "stop"));
        res.write("data: [DONE]\n\n");
        res.end();
      } else if (model === "szenario/tools") {
        // Zwei parallele Tool-Calls, Argumente in Fragmenten (index-basiert).
        res.write(delta({ role: "assistant", tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: "get_weather", arguments: "" } }] }));
        res.write(delta({ tool_calls: [{ index: 0, function: { arguments: '{"loc' } }] }));
        res.write(delta({ tool_calls: [{ index: 1, id: "call_2", type: "function", function: { name: "get_time", arguments: "{}" } }] }));
        res.write(delta({ tool_calls: [{ index: 0, function: { arguments: 'ation":"Berlin"}' } }] }));
        res.write(delta({}, "tool_calls"));
        res.write("data: [DONE]\n\n");
        res.end();
      } else if (model === "szenario/slow") {
        res.write(delta({ content: "tick " }));
        const timer = setInterval(() => res.write(delta({ content: "tick " })), 40);
        // res.on("close") = Verbindung/Response beendet (z. B. Client-Abort).
        // NICHT req.on("close"): das feuert schon direkt nach dem Body-Einlesen.
        res.on("close", () => clearInterval(timer));
      }
    });
  });
  await new Promise<void>((r) => server.listen(PORT, "127.0.0.1", r));
});

after(async () => {
  // Wichtig: undici (fetch) hält Keep-Alive-Sockets offen — ohne closeAllConnections()
  // wartet server.close() ewig und die Testdatei hängt bis zum Runner-Timeout.
  server.closeAllConnections();
  await new Promise<void>((r) => server.close(() => r()));
});

const baseReq = (model: string, signal = new AbortController().signal) => ({
  baseUrl: BASE,
  apiKey: "test-key",
  model,
  messages: [{ role: "user" as const, content: "Hi" }],
  signal,
});

// 1 ─ Text-Streaming: Deltas in Reihenfolge, Gesamttext, finish_reason.
test("streamChatCompletion: Text-Deltas und Ergebnis", async () => {
  const deltas: string[] = [];
  const res = await streamChatCompletion(baseReq("szenario/text"), (t) => deltas.push(t));
  assert.deepEqual(deltas, ["Hal", "lo!"]);
  assert.equal(res.content, "Hallo!");
  assert.equal(res.finishReason, "stop");
  assert.equal(res.toolCalls.length, 0);
});

// 2 ─ Tool-Calls: index-basierte Fragmente werden korrekt akkumuliert; tools gehen im Body raus.
test("streamChatCompletion: Tool-Call-Fragmente + toOpenAiTools", async () => {
  const tools = toOpenAiTools([
    { name: "get_weather", description: "Wetter", parameters: { type: "object", properties: {} } },
  ]);
  const res = await streamChatCompletion({ ...baseReq("szenario/tools"), tools }, () => {});
  assert.deepEqual(res.toolCalls, [
    { id: "call_1", type: "function", function: { name: "get_weather", arguments: '{"location":"Berlin"}' } },
    { id: "call_2", type: "function", function: { name: "get_time", arguments: "{}" } },
  ]);
  assert.equal(res.finishReason, "tool_calls");
  const sentTools = lastRequestBody.tools as Array<{ function: { name: string } }>;
  assert.equal(sentTools[0]?.function.name, "get_weather");
  assert.equal(lastRequestBody.stream, true);
});

// 3 ─ Abbruch (Barge-in): AbortError, danach kommen keine Deltas mehr an.
test("streamChatCompletion: Abort mid-stream", async () => {
  const ctrl = new AbortController();
  const deltas: string[] = [];
  const pending = streamChatCompletion(baseReq("szenario/slow", ctrl.signal), (t) => {
    deltas.push(t);
    if (deltas.length === 2) ctrl.abort();
  });
  await assert.rejects(pending, (err: Error) => err.name === "AbortError");
  const after = deltas.length;
  await new Promise((r) => setTimeout(r, 120));
  assert.equal(deltas.length, after, "nach Abort keine weiteren Deltas");
});

// 4 ─ HTTP-Fehler: Status + Body-Ausschnitt in der Fehlermeldung.
test("streamChatCompletion: HTTP 400 → Fehler mit Body", async () => {
  await assert.rejects(streamChatCompletion(baseReq("szenario/bad"), () => {}), /HTTP 400.*kaputtes Modell/s);
});

// 5 ─ Satz-Chunker: Grenzen, minChars, Abkürzungen/Zahlen, flush.
test("createSentenceChunker: Grenzen und Abkürzungs-Heuristik", () => {
  const c = createSentenceChunker(8);
  assert.deepEqual(c.push("Guten Tag! Wie kann ich"), ["Guten Tag!"]);
  // "Prima." (6 Zeichen) unterschreitet minChars → bleibt liegen bis flush.
  assert.deepEqual(c.push(" helfen? Prima."), ["Wie kann ich helfen?"]);
  assert.deepEqual(c.flush(), "Prima.");

  // Kein Split nach "z." / "B." (Einzelbuchstaben) und nicht in "1.50" (Ziffer).
  const abbr = createSentenceChunker(12);
  assert.deepEqual(abbr.push("Das kostet z. B. 1.50 Euro heute. Danach mehr."), [
    "Das kostet z. B. 1.50 Euro heute.",
    "Danach mehr.",
  ]);
  assert.equal(abbr.flush(), null);

  const dr = createSentenceChunker(3);
  assert.deepEqual(dr.push("Dr. Meier ist da. Ok?"), ["Dr. Meier ist da.", "Ok?"]);
  assert.equal(dr.flush(), null);

  // Zu kurze Grenze wird übersprungen: Mini-Satz verschmilzt mit dem Folgesatz.
  const merge = createSentenceChunker(12);
  assert.deepEqual(merge.push("Ja. Wie kann ich helfen?"), ["Ja. Wie kann ich helfen?"]);
});

// 6 ─ Historie: Trimming droppt tool_calls-Gruppe gemeinsam; System bleibt immer.
test("ConversationHistory: Budget-Trim hält tool_calls-Gruppen zusammen", () => {
  const h = new ConversationHistory("SYS", 60);
  h.addUser("Erste Frage mit einigem Text");
  h.addAssistantToolCalls("", [
    { id: "t1", type: "function", function: { name: "get_weather", arguments: '{"a":1}' } },
  ]);
  h.addToolResult("t1", "get_weather", { temp: 20 });
  h.addAssistant("Es sind 20 Grad.");
  h.addUser("Und morgen? Bitte ausführlich mit vielen Zeichen!!");

  const roles = h.messages().map((m) => m.role);
  // Budget zwingt zum Trimmen: die tool_calls-Gruppe verschwindet KOMPLETT (kein verwaistes tool).
  assert.equal(roles[0], "system");
  assert.ok(!h.messages().some((m) => m.role === "tool"), "keine verwaiste tool-Message");
  assert.ok(
    !h.messages().some((m) => m.tool_calls?.length),
    "assistant+tool_calls wurde mitsamt Antworten entfernt",
  );
});
