import "./helpers/env.js"; // MUSS erster Import bleiben (ENV-Pinning vor config-Load)

import assert from "node:assert/strict";
import { test } from "node:test";

import { detectContentLanguage, scoreLanguage } from "../src/llm/languageScorer.js";

test("languageScorer: erkennt klare Sätze", () => {
  assert.equal(scoreLanguage("Ich möchte gerne einen Termin haben bitte")?.lang, "de");
  assert.equal(scoreLanguage("I would like to have some help please and thanks")?.lang, "en");
  assert.equal(scoreLanguage("je voudrais un rendez vous pour demain merci")?.lang, "fr");
  assert.equal(scoreLanguage("hola quiero un buenos dias por favor gracias")?.lang, "es");
});

test("languageScorer: zu kurz / leer → null", () => {
  assert.equal(scoreLanguage("Okay."), null);
  assert.equal(scoreLanguage("Ja."), null);
  assert.equal(scoreLanguage(""), null);
  assert.equal(scoreLanguage("   "), null);
});

test("languageScorer: uneindeutig (zu knapper Abstand) → null", () => {
  // "le" liegt in fr UND it → gleiche Trefferquote, Abstand 0 → unsicher.
  assert.equal(scoreLanguage("le le le"), null);
});

test("languageScorer: zu wenig Funktionswörter → null", () => {
  // Drei Inhaltswörter ohne Stopwort-Treffer bleiben unter der Schwelle.
  assert.equal(scoreLanguage("Apfel Banane Kirsche"), null);
});

// ── Ausgangssprache der Agent-Texte (0.7.0) ──────────────────────────────────

// Anders als beim Anrufer ist hier viel Text da (ein System-Prompt hat mehrere hundert
// Zeichen) — in dieser Länge ist die Stopwort-Heuristik sicher genug, und ein LLM-Call
// wäre Verschwendung.
test("detectContentLanguage: erkennt Deutsch aus Begrüßung und Prompt", () => {
  const lang = detectContentLanguage(
    "Hallo! Wie kann ich Ihnen helfen?",
    "Du bist ein ruhiger, kompetenter technischer Support-Assistent am Telefon. Antworte in höchstens zwei kurzen Sätzen und stelle dann eine Rückfrage.",
  );
  assert.equal(lang, "de");
});

test("detectContentLanguage: erkennt Englisch", () => {
  const lang = detectContentLanguage(
    "Hello! How can I help you today?",
    "You are a calm and competent technical support assistant on the phone. Please answer with not more than two short sentences and then ask a question.",
  );
  assert.equal(lang, "en");
});

test("detectContentLanguage: kombiniert beide Quellen", () => {
  // Die Begrüßung allein wäre zu kurz für ein sicheres Urteil — der Prompt trägt es.
  const nurGruss = detectContentLanguage("Bonjour !");
  const beides = detectContentLanguage(
    "Bonjour !",
    "Vous êtes un assistant téléphonique. Je ne peux pas vous aider avec cette question, mais je vous propose de vous mettre en relation avec un collègue.",
  );
  assert.equal(nurGruss, null, "zu wenig Text → kein Urteil");
  assert.equal(beides, "fr");
});

test("detectContentLanguage: leere Eingabe und Unentscheidbares liefern null", () => {
  assert.equal(detectContentLanguage(), null);
  assert.equal(detectContentLanguage("", ""), null);
  assert.equal(detectContentLanguage(undefined, "   "), null);
  assert.equal(detectContentLanguage("...", "42"), null);
});
