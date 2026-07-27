import "./helpers/env.js"; // MUSS erster Import bleiben (ENV-Pinning vor config-Load)

import assert from "node:assert/strict";
import { test } from "node:test";

import { fillContentLanguage } from "../src/admin/routes/agents.js";
import { config } from "../src/config.js";

const DE_PROMPT =
  "Du bist ein ruhiger, kompetenter technischer Support-Assistent am Telefon. Antworte in höchstens zwei kurzen Sätzen und stelle dann eine Rückfrage oder schweige.";
const EN_PROMPT =
  "You are a calm and competent technical support assistant on the phone. Please answer with not more than two short sentences and then ask a question or stay quiet.";

/**
 * `contentLanguage` beim Speichern auffüllen. Die Erkennung ist ein VORSCHLAG für den Fall
 * „Automatisch erkennen" — sie darf nie eine bewusste Auswahl überstimmen.
 */

// 1 ─ Neuer Agent ohne Auswahl: Sprache wird ermittelt und eingetragen.
test("Leeres Feld wird beim Anlegen aus Begrüßung und Prompt gefüllt", () => {
  const body: Record<string, unknown> = { greeting: "Hallo! Wie kann ich helfen?", prompt: DE_PROMPT };
  fillContentLanguage(body);
  assert.equal(body.contentLanguage, "de");
});

test("Englische Texte ergeben en", () => {
  const body: Record<string, unknown> = { greeting: "Hello! How can I help?", prompt: EN_PROMPT };
  fillContentLanguage(body);
  assert.equal(body.contentLanguage, "en");
});

// 2 ─ Der wichtigste Fall: eine bewusste Auswahl gewinnt immer gegen die Heuristik.
test("Gesetzter Wert wird nie überschrieben", () => {
  const body: Record<string, unknown> = { contentLanguage: "fr", greeting: "Hallo!", prompt: DE_PROMPT };
  fillContentLanguage(body);
  assert.equal(body.contentLanguage, "fr", "der Nutzer weiß es besser als der Scorer");
});

// 3 ─ Uneindeutig → Config-Default statt Rateversuch.
test("Ohne eindeutiges Ergebnis greift der Config-Default", () => {
  const body: Record<string, unknown> = { greeting: "...", prompt: "42" };
  fillContentLanguage(body);
  assert.equal(body.contentLanguage, config.defaultAgent.contentLanguage);
});

// 4 ─ Teil-Update, das nur den Prompt ändert: Der neue Prompt zählt, nicht der alte.
test("Teil-Update: neuer Prompt bestimmt die Sprache, gespeicherte Begrüßung ergänzt", () => {
  const body: Record<string, unknown> = { prompt: EN_PROMPT, contentLanguage: "" };
  fillContentLanguage(body, { greeting: "Hello!", prompt: DE_PROMPT, contentLanguage: "de" });
  assert.equal(body.contentLanguage, "en", "die Änderung schlägt durch");
});

// 5 ─ Teil-Update, das das Feld gar nicht mitschickt (API-Nutzer patcht nur ein Detail):
//     ein bereits gespeicherter Wert bleibt unangetastet.
test("Teil-Update ohne das Feld lässt einen gespeicherten Wert stehen", () => {
  const body: Record<string, unknown> = { greeting: "Hallo!" };
  fillContentLanguage(body, { greeting: "Hallo!", prompt: DE_PROMPT, contentLanguage: "fr" });
  assert.equal("contentLanguage" in body, false, "kein ungefragtes Überschreiben");
});

// 6 ─ Dasselbe, aber gespeichert ist noch nichts → jetzt ist der richtige Moment zu füllen.
test("Teil-Update ohne das Feld füllt einen leeren gespeicherten Wert", () => {
  const body: Record<string, unknown> = { greeting: "Hallo!" };
  fillContentLanguage(body, { greeting: "Hallo!", prompt: DE_PROMPT });
  assert.equal(body.contentLanguage, "de");
});

// 7 ─ Der Formular-Fall: das UI sendet den Leerstring, wenn „Automatisch erkennen" gewählt ist.
//     Das ist eine ausdrückliche Anweisung, neu zu erkennen — auch wenn schon etwas gespeichert war.
test("Ausdrücklich leer gesendet → wird neu erkannt, auch wenn schon etwas gespeichert war", () => {
  const body: Record<string, unknown> = { contentLanguage: "", greeting: "Hello!", prompt: EN_PROMPT };
  fillContentLanguage(body, { greeting: "Hallo!", prompt: DE_PROMPT, contentLanguage: "de" });
  assert.equal(body.contentLanguage, "en");
});

// 8 ─ Nur Leerzeichen zählen als leer.
test("Whitespace zählt als leer", () => {
  const body: Record<string, unknown> = { contentLanguage: "   ", greeting: "Hallo!", prompt: DE_PROMPT };
  fillContentLanguage(body);
  assert.equal(body.contentLanguage, "de");
});
