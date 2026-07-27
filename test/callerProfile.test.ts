import "./helpers/env.js"; // MUSS erster Import bleiben (ENV-Pinning vor config-Load)

import assert from "node:assert/strict";
import { test, beforeEach, afterEach } from "node:test";

import { config } from "../src/config.js";
import { callerKey, learnAction, memoryActive } from "../src/llm/callerProfile.js";
import { testAgent } from "./helpers/fakes.js";

const withMemory = (over = {}) =>
  testAgent({ id: "6a411b273d84ad5c5d4d28ef", callerMemory: { language: true }, ...over });

let origSecret: string;
beforeEach(() => {
  origSecret = config.callerProfile.secret;
});
afterEach(() => {
  config.callerProfile.secret = origSecret;
});

// 1 ─ Ohne Secret gibt es keine Pseudonymisierung — dann bleibt das Gedächtnis aus,
//     statt Rufnummern im Klartext abzulegen.
test("Ohne CALLER_PROFILE_SECRET bleibt das Gedächtnis inaktiv", () => {
  config.callerProfile.secret = "";
  assert.equal(memoryActive(withMemory()), false);
  assert.equal(callerKey("+4915112345678"), null);
});

// 2 ─ Opt-in pro Agent: Default aus.
test("Ohne Opt-in am Agenten bleibt das Gedächtnis inaktiv", () => {
  assert.equal(memoryActive(testAgent({ id: "abc" })), false);
  assert.equal(memoryActive(withMemory()), true);
});

// 3 ─ Ein noch nie gespeicherter Agent hat keine ID — dann gibt es nichts zu verknüpfen.
test("Ohne Agent-ID bleibt das Gedächtnis inaktiv", () => {
  assert.equal(memoryActive(testAgent({ callerMemory: { language: true } })), false);
});

// 4 ─ Der entscheidende Fall aus der Live-Messung: Es kommt "0176…" an, nicht "+49176…".
//     Ohne Normalisierung wären das zwei Schlüssel und das Gedächtnis träfe nie.
test("Nationale und internationale Schreibweise ergeben denselben Schlüssel", () => {
  const a = callerKey("015112345678");
  const b = callerKey("+4915112345678");
  const c = callerKey("004915112345678");
  const d = callerKey("+49 151 1234 5678");

  assert.ok(a, "nationale Notation muss einen Schlüssel liefern");
  assert.equal(a, b);
  assert.equal(a, c);
  assert.equal(a, d, "Trennzeichen dürfen den Schlüssel nicht verändern");
});

// 5 ─ Pseudonym, kein Klartext: Die Nummer darf im Schlüssel nicht mehr auftauchen.
test("Schlüssel ist ein Hash, keine erkennbare Rufnummer", () => {
  const key = callerKey("+4915112345678")!;
  assert.match(key, /^[a-f0-9]{64}$/);
  assert.ok(!key.includes("15112345678"));
});

// 6 ─ Anderes Secret → anderer Schlüssel (Rotation entwertet alle Profile, wie dokumentiert).
test("Secret-Rotation entwertet bestehende Schlüssel", () => {
  const before = callerKey("+4915112345678");
  config.callerProfile.secret = "anderes-secret";
  assert.notEqual(callerKey("+4915112345678"), before);
});

// 7 ─ Verschiedene Nummern kollidieren nicht.
test("Verschiedene Nummern ergeben verschiedene Schlüssel", () => {
  assert.notEqual(callerKey("+4915112345678"), callerKey("+4915112345679"));
});

// 8 ─ Web-Token sind pro Anruf einmalig: Ein Eintrag dafür würde nie ein zweites Mal
//     getroffen und die Collection nur zumüllen.
test("Web-Anrufe bekommen kein Profil", () => {
  assert.equal(callerKey("web-a1b2c3d4e5f6"), null);
});

// 9 ─ Interne Durchwahlen identifizieren keinen Anrufer.
test("Interne Durchwahlen bekommen kein Profil", () => {
  assert.equal(callerKey("120"), null);
  assert.equal(callerKey("199"), null);
});

// 10 ─ Unterdrückte und leere Nummern.
test("Unterdrückte und leere Nummern bekommen kein Profil", () => {
  assert.equal(callerKey(undefined), null);
  assert.equal(callerKey(""), null);
  assert.equal(callerKey("   "), null);
  assert.equal(callerKey("anonymous"), null);
  assert.equal(callerKey("Unknown"), null);
});

// ── Asymmetrisches Lernen ────────────────────────────────────────────────────

// 11 ─ Erster Kontakt: freie Wahl des Anrufers, also echtes Wissen.
test("Ohne Prior wird die Sprache geschrieben", () => {
  assert.equal(learnAction("en"), "write");
});

// 12 ─ DER Kern: Wer auf Englisch begrüßt wird, antwortet eher auf Englisch — auch wenn ihm
//      Deutsch lieber wäre. Das darf nicht als neues Wissen zählen, sonst zementiert sich
//      ein einmaliger Fehlgriff für immer.
test("Bestätigter Prior zählt nur hoch, statt neu zu lernen", () => {
  assert.equal(learnAction("en", "en"), "confirm");
});

// 13 ─ Widerspruch ist ein bewusster Wechsel und schlägt sofort durch — aus einer falschen
//      Zuordnung kommt man mit einem einzigen Anruf wieder heraus.
test("Widersprochener Prior überschreibt sofort", () => {
  assert.equal(learnAction("de", "en"), "write");
});

// 14 ─ Der Rückweg: Auch die Standardsprache muss geschrieben werden. Sonst bliebe ein
//      einmal gesetztes "en" für immer stehen und Anruf 4 begrüßte wieder englisch.
test("Auch die Standardsprache wird geschrieben (Rückweg aus einem Fremdsprachen-Profil)", () => {
  assert.equal(learnAction("de", "en"), "write", "Wechsel zurück auf Deutsch muss ankommen");
  assert.equal(learnAction("de"), "write", "auch ohne Prior");
});
