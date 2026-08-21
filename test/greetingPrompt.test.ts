import "./helpers/env.js"; // MUSS erster Import bleiben (ENV-Pinning vor config-Load)

import assert from "node:assert/strict";
import http from "node:http";
import { after, before, test } from "node:test";

import { config } from "../src/config.js";
import { generateGreeting, parseGreetingResponse } from "../src/llm/greetingPrompt.js";

// ── Reines Parsen ────────────────────────────────────────────────────────────

test("parse: gültiges JSON liefert den Satz", () => {
  assert.equal(parseGreetingResponse('{"greeting":"Guten Morgen bei Musterfirma."}'), "Guten Morgen bei Musterfirma.");
});

test("parse: Code-Zaun und Prosa drumherum überleben", () => {
  const raw = 'Klar!\n```json\n{"greeting":"Guten Abend."}\n```';
  assert.equal(parseGreetingResponse(raw), "Guten Abend.");
});

test("parse: Zeilenumbrüche werden geglättet — der Satz geht direkt in die Synthese", () => {
  assert.equal(parseGreetingResponse('{"greeting":"Guten Tag,\\n  wie kann ich helfen?"}'), "Guten Tag, wie kann ich helfen?");
});

// Alles, was kein brauchbarer Satz ist, gilt als „nichts geliefert" — der Aufrufer nimmt
// dann den statischen Text. Ein leerer String darf NIE als Begrüßung durchgehen.
test("parse: Unbrauchbares ergibt undefined statt eines leeren Satzes", () => {
  assert.equal(parseGreetingResponse("kein JSON"), undefined);
  assert.equal(parseGreetingResponse('{"greeting":""}'), undefined);
  assert.equal(parseGreetingResponse('{"greeting":"   "}'), undefined);
  assert.equal(parseGreetingResponse('{"greeting":42}'), undefined);
  assert.equal(parseGreetingResponse('{"foo":"bar"}'), undefined);
});

// ── Aufruf gegen einen lokalen Endpunkt ──────────────────────────────────────

const PORT = 45231;
const BASE = `http://127.0.0.1:${PORT}/v1`;
let server: http.Server;
let lastBody: Record<string, any> = {};
let origBaseUrl: string;
let origApiKey: string;

before(async () => {
  origBaseUrl = config.llm.requestyBaseUrl;
  origApiKey = config.llm.requestyApiKey;
  config.llm.requestyBaseUrl = BASE;
  config.llm.requestyApiKey = "test-key";
  server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      lastBody = JSON.parse(body) as Record<string, any>;
      if (String(lastBody.model) === "slow/model") return; // nie antworten → Abbruch greift
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          choices: [{ message: { content: '{"greeting":"Good afternoon."}' } }],
        }),
      );
    });
  });
  await new Promise<void>((r) => server.listen(PORT, "127.0.0.1", r));
});

after(async () => {
  config.llm.requestyBaseUrl = origBaseUrl;
  config.llm.requestyApiKey = origApiKey;
  server.closeAllConnections();
  await new Promise<void>((r) => server.close(() => r()));
});

test("Erzeugung: Sprache und Anweisung gehen mit, Satz kommt zurück", async () => {
  const text = await generateGreeting("Begrüße für Musterfirma, es ist Nachmittag.", "en");
  assert.equal(text, "Good afternoon.");
  const user = String(lastBody.messages?.[1]?.content ?? "");
  assert.match(user, /SPRACHE: en/);
  assert.match(user, /Musterfirma/);
  assert.equal(lastBody.model, config.localize.model, "günstiger One-Shot-Pfad, kein Konversationsmodell");
});

test("Erzeugung: leerer Prompt fragt gar nicht erst", async () => {
  lastBody = {};
  assert.equal(await generateGreeting("   ", "de"), undefined);
  assert.deepEqual(lastBody, {}, "kein ausgehender Verkehr");
});

// Der Anrufer legt im Rufton auf: Der Modellaufruf muss abbrechen, sonst zahlt jeder
// Klingelabbrecher ein Modell für ein Gespräch, das nie stattgefunden hat.
test("Erzeugung: Abbruch-Signal beendet den laufenden Aufruf", async () => {
  const ctrl = new AbortController();
  const pending = generateGreeting("Begrüße kurz.", "de", {
    model: "slow/model",
    signal: ctrl.signal,
  });
  setTimeout(() => ctrl.abort(), 20);
  await assert.rejects(pending, /abort/i);
});
