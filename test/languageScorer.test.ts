import "./helpers/env.js"; // MUSS erster Import bleiben (ENV-Pinning vor config-Load)

import assert from "node:assert/strict";
import { test } from "node:test";

import { scoreLanguage } from "../src/llm/languageScorer.js";

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
