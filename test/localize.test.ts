import "./helpers/env.js"; // MUSS erster Import bleiben (ENV-Pinning vor config-Load)

import assert from "node:assert/strict";
import http from "node:http";
import { test, before, after } from "node:test";

import { config } from "../src/config.js";
import { detectAndLocalize, parseLocalizeResponse } from "../src/llm/localize.js";

const CATALOG = { transferFailed: "Ich konnte niemanden erreichen.", "filler.0": "Einen Moment." };

// ── Reines Parsen/Validieren (parseLocalizeResponse) ─────────────────────────

test("parse: nur language (kein phrases-Feld) bleibt gültig — Defaults greifen dann", () => {
  const r = parseLocalizeResponse('{"language":"de"}', CATALOG);
  assert.deepEqual(r, { language: "de" });
});

test("parse: catalogLanguage wird übernommen (nur plausible Codes)", () => {
  const r = parseLocalizeResponse('{"catalogLanguage":"DE","language":"en","phrases":{}}', CATALOG);
  assert.equal(r.catalogLanguage, "de", "wird kleingeschrieben");
  assert.equal(parseLocalizeResponse('{"language":"en"}', CATALOG).catalogLanguage, undefined);
  const junk = '{"catalogLanguage":"viel_zu_lang","language":"en"}';
  assert.equal(parseLocalizeResponse(junk, CATALOG).catalogLanguage, undefined);
});

test("parse: Übersetzung → Keys erhalten", () => {
  const raw = '{"language":"en","phrases":{"transferFailed":"Could not reach anyone.","filler.0":"One moment."}}';
  const r = parseLocalizeResponse(raw, CATALOG);
  assert.equal(r.language, "en");
  assert.equal(r.phrases?.transferFailed, "Could not reach anyone.");
  assert.equal(r.phrases?.["filler.0"], "One moment.");
});

test("parse: code-fenced JSON wird geparst", () => {
  const raw = "```json\n{\"language\":\"it\",\"phrases\":{\"filler.0\":\"Un attimo\"}}\n```";
  const r = parseLocalizeResponse(raw, CATALOG);
  assert.equal(r.language, "it");
  assert.equal(r.phrases?.["filler.0"], "Un attimo");
});

test("parse: unbekannte Keys / Nicht-Strings / leere Werte werden verworfen", () => {
  const raw = JSON.stringify({
    language: "en",
    phrases: { transferFailed: "OK", unknownKey: "drop", "filler.0": "", bad: 42 },
  });
  const r = parseLocalizeResponse(raw, CATALOG);
  assert.deepEqual(r.phrases, { transferFailed: "OK" });
});

test("parse: Register bleibt erhalten (informelle Übersetzung wird durchgereicht)", () => {
  const raw = '{"language":"it","phrases":{"filler.0":"Un attimo"}}'; // informell statt "Un momento, prego"
  assert.equal(parseLocalizeResponse(raw, CATALOG).phrases?.["filler.0"], "Un attimo");
});

test("parse: formality-Zwischenentscheidung wird übernommen (nur gültige Werte)", () => {
  const informal = '{"language":"es","formality":"informal","phrases":{"filler.0":"Un momento"}}';
  assert.equal(parseLocalizeResponse(informal, CATALOG).formality, "informal");
  const formal = '{"language":"fr","formality":"formal","phrases":{"filler.0":"Un instant"}}';
  assert.equal(parseLocalizeResponse(formal, CATALOG).formality, "formal");
  // Unsinnige/fehlende Werte werden verworfen — das Feld ist reine Diagnose, nie Steuerung.
  const junk = '{"language":"es","formality":"vielleicht","phrases":{"filler.0":"Un momento"}}';
  assert.equal(parseLocalizeResponse(junk, CATALOG).formality, undefined);
  assert.equal(parseLocalizeResponse('{"language":"de"}', CATALOG).formality, undefined);
});

test("parse: Müll / fehlendes language → wirft", () => {
  assert.throws(() => parseLocalizeResponse("kein json hier", CATALOG));
  assert.throws(() => parseLocalizeResponse('{"phrases":{}}', CATALOG));
  assert.throws(() => parseLocalizeResponse('{"language":"viel_zu_langer_code"}', CATALOG));
});

// ── HTTP-Pfad (detectAndLocalize gegen Loopback-Server) ──────────────────────

const PORT = 18099;
const BASE = `http://127.0.0.1:${PORT}`;
let lastBody: Record<string, unknown> = {};
let server: http.Server;
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
      lastBody = JSON.parse(body) as Record<string, unknown>;
      const model = String(lastBody.model ?? "");
      if (model === "bad/model") {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end('{"error":{"message":"kaputt"}}');
        return;
      }
      if (model === "slow/model") return; // nie antworten → Client-Abort greift
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          choices: [
            {
              message: {
                content: '{"language":"en","phrases":{"transferFailed":"Could not reach anyone."}}',
              },
            },
          ],
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

test("detectAndLocalize: Body korrekt (temperature 0, Modell, caller-only + Register-Instruktion)", async () => {
  const r = await detectAndLocalize("caller: Hello, could you help me?\nagent: Guten Tag!", CATALOG);
  assert.equal(r.language, "en");
  assert.equal(r.phrases?.transferFailed, "Could not reach anyone.");

  assert.equal(lastBody.temperature, 0);
  assert.equal(lastBody.model, config.localize.model);
  const messages = lastBody.messages as Array<{ role: string; content: string }>;
  const system = messages[0]!.content;
  assert.match(system, /caller:/, "Prompt bestimmt die Sprache aus den caller-Zeilen");
  assert.match(system, /Anrede|Höflichkeitsform/, "Prompt enthält die Register-Instruktion");
  assert.match(system, /Person|Perspektive/, "Prompt wahrt Sprecher-Perspektive (1. Person)");
  assert.match(system, /catalogLanguage/, "Modell muss die Ausgangssprache benennen");
  assert.match(messages[1]!.content, /CATALOG/, "Katalog geht als JSON in den User-Turn");
});

// Regression 0.6.28: Der Prompt darf dem Modell KEINEN Weg lassen, die Übersetzung auszulassen.
// Genau daran ist 0.6.27 live gescheitert (gpt-4.1-mini lieferte bei englischen Anrufern
// reproduzierbar nur {"language":"en"} ohne phrases).
test("Prompt: keine Erlaubnis, phrases wegzulassen oder unverändert zurückzugeben", async () => {
  await detectAndLocalize("caller: Hello there", CATALOG);
  const messages = lastBody.messages as Array<{ role: string; content: string }>;
  const system = messages[0]!.content;
  assert.match(system, /IMMER alle vier Felder/, "phrases sind bedingungslos Pflicht");
  assert.doesNotMatch(
    system,
    /ohne phrases|darfst du phrases weglassen|unverändert zurück/,
    "keine Abkürzung und keine 'lass es wie es ist'-Erlaubnis im Prompt",
  );
});

test("detectAndLocalize: HTTP 400 → wirft", async () => {
  await assert.rejects(() => detectAndLocalize("caller: hi", CATALOG, { model: "bad/model" }));
});

test("detectAndLocalize: Abbruch via signal → wirft", async () => {
  const ctrl = new AbortController();
  const p = detectAndLocalize("caller: hi", CATALOG, { model: "slow/model", signal: ctrl.signal });
  ctrl.abort();
  await assert.rejects(() => p);
});
