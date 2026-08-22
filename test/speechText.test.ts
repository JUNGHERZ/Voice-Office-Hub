import "./helpers/env.js"; // MUSS erster Import bleiben (ENV-Pinning vor config-Load)

import assert from "node:assert/strict";
import { test } from "node:test";

import { createBreakNormalizer, sanitizeForSpeech } from "../src/native/speechText.js";

// ── Auszeichnung ─────────────────────────────────────────────────────────────

test("Fett, kursiv und Code verlieren ihre Marker, nicht ihren Inhalt", () => {
  assert.equal(sanitizeForSpeech("**Guten Tag**"), "Guten Tag");
  assert.equal(sanitizeForSpeech("*wichtig*"), "wichtig");
  assert.equal(sanitizeForSpeech("_wichtig_"), "wichtig");
  assert.equal(sanitizeForSpeech("***sehr***"), "sehr");
  assert.equal(sanitizeForSpeech("Der Wert `null` gilt"), "Der Wert null gilt");
  assert.equal(sanitizeForSpeech("```js\nconst a = 1;\n```"), "const a = 1;");
});

// Ein Unterstrich mitten im Wort ist keine Auszeichnung, ein Bindestrich kein Aufzählungs-
// punkt. Beides würde sonst mitten im Fachbegriff zuschlagen.
test("Was wie Auszeichnung aussieht, aber keine ist, bleibt stehen", () => {
  assert.equal(sanitizeForSpeech("snake_case_name"), "snake_case_name");
  assert.equal(sanitizeForSpeech("Die E-Mail-Adresse"), "Die E-Mail-Adresse");
  assert.equal(sanitizeForSpeech("Es sind 3-5 Werktage"), "Es sind 3-5 Werktage");
  assert.equal(sanitizeForSpeech("2 * 3 ergibt 6"), "2 * 3 ergibt 6");
});

test("Überschriften, Zitate und Trennlinien verschwinden", () => {
  assert.equal(sanitizeForSpeech("## Ihre Möglichkeiten"), "Ihre Möglichkeiten");
  assert.equal(sanitizeForSpeech("> Zitat"), "Zitat");
  assert.equal(sanitizeForSpeech("Oben\n---\nUnten"), "Oben. Unten");
});

test("Links: der Text wird gesprochen, das Ziel nicht", () => {
  assert.equal(sanitizeForSpeech("Siehe [unsere Seite](https://example.test/x)"), "Siehe unsere Seite");
  assert.equal(sanitizeForSpeech("![Bild](x.png)Danach"), "Danach");
});

// ── Piktogramme ──────────────────────────────────────────────────────────────

test("Emoji verschwinden samt ihrem unsichtbaren Beiwerk", () => {
  assert.equal(sanitizeForSpeech("**Guten Tag** 👋"), "Guten Tag");
  assert.equal(sanitizeForSpeech("Fertig ✅️"), "Fertig");
  assert.equal(sanitizeForSpeech("Team 👨‍👩‍👧 da"), "Team da");
  assert.equal(sanitizeForSpeech("Punkt 1️⃣ zuerst"), "Punkt zuerst");
});

// ── Aufzählungen ─────────────────────────────────────────────────────────────

// Die Abnahme: drei Punkte werden zu drei Sätzen, nicht zu dreimal „Bindestrich".
test("Aufzählung wird zu Sätzen, ohne den Marker zu sprechen", () => {
  assert.equal(
    sanitizeForSpeech("- Termin buchen\n- Rückruf anfordern\n- Nachricht hinterlassen"),
    "Termin buchen. Rückruf anfordern. Nachricht hinterlassen",
  );
  assert.equal(sanitizeForSpeech("1. Erstens\n2. Zweitens"), "Erstens. Zweitens");
  assert.equal(sanitizeForSpeech("• Eins\n• Zwei"), "Eins. Zwei");
});

test("Vorhandene Satzzeichen bekommen keinen zweiten Punkt", () => {
  assert.equal(sanitizeForSpeech("Guten Tag.\nWie geht es?"), "Guten Tag. Wie geht es?");
  assert.equal(sanitizeForSpeech("Frage?\nAntwort"), "Frage? Antwort");
});

// ── Reste über Sprechgrenzen hinweg ──────────────────────────────────────────

// Der Fall, der ohne die Schlussregel durchrutscht: Das Gegenstück der Auszeichnung steht
// im nächsten Satz, den die Synthese getrennt bekommt.
test("Unpaarige Marker bleiben nicht stehen", () => {
  assert.equal(sanitizeForSpeech("**Wichtig."), "Wichtig.");
  assert.equal(sanitizeForSpeech("Sehr wichtig**"), "Sehr wichtig");
  assert.equal(sanitizeForSpeech("`Rest"), "Rest");
});

test("Leerer oder reiner Formatierungstext ergibt nichts Sprechbares", () => {
  assert.equal(sanitizeForSpeech(""), "");
  assert.equal(sanitizeForSpeech("   \n\n  "), "");
  assert.equal(sanitizeForSpeech("👍"), "");
});

// ── Strom-Vorlauf ────────────────────────────────────────────────────────────

// Läuft vor dem Satz-Zerleger: Ohne Satzgrenzen hielte der eine Aufzählung bis zum
// Stream-Ende zurück, und der Sprechbeginn verschöbe sich um die ganze Antwort.
test("Break-Normalisierer setzt Satzgrenzen über Delta-Grenzen hinweg", () => {
  const norm = createBreakNormalizer();
  const out = ["- Termin buchen", "\n- Rück", "ruf anfordern\n"].map(norm).join("");
  assert.equal(out, "- Termin buchen. - Rückruf anfordern. ");
});

test("Break-Normalisierer verdoppelt keine Satzzeichen und keine Leerzeilen", () => {
  const norm = createBreakNormalizer();
  assert.equal(["Guten Tag.", "\n\nWie", " geht es?"].map(norm).join(""), "Guten Tag. Wie geht es?");
});
