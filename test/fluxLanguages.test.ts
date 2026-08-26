import "./helpers/env.js"; // MUSS erster Import bleiben (ENV-Pinning vor config-Load)

import assert from "node:assert/strict";
import { test } from "node:test";

import { fromDoc } from "../src/ari/agentResolver.js";
import { config } from "../src/config.js";
import { languageHintsFor } from "../src/native/fluxLanguages.js";

test("languageHintsFor: genau ein Hinweis aus der Sprache der Agent-Texte", () => {
  assert.deepEqual(languageHintsFor("de"), ["de"]);
  assert.deepEqual(languageHintsFor("en"), ["en"]);
  assert.deepEqual(languageHintsFor("DE"), ["de"], "Grossschreibung egal");
  assert.deepEqual(languageHintsFor("de-DE"), ["de"], "Regionalcode wird abgeschnitten");
  assert.deepEqual(languageHintsFor("pt_BR"), ["pt"]);
});

// „multi" ist keine Sprache, sondern die Ansage „erkenn es selbst" — ein Hinweis
// darauf gäbe es bei Deepgram gar nicht.
test("languageHintsFor: multi und Leerwerte ergeben keinen Hinweis", () => {
  assert.deepEqual(languageHintsFor("multi"), []);
  assert.deepEqual(languageHintsFor(""), []);
  assert.deepEqual(languageHintsFor("   "), []);
  assert.deepEqual(languageHintsFor(undefined), []);
});

// Ein falscher Hinweis ist schlechter als keiner: Ohne Hinweis erkennt das Modell
// selbst, mit einem falschen rät es in die falsche Richtung.
test("languageHintsFor: nicht unterstützte Sprache bekommt lieber gar keinen Hinweis", () => {
  assert.deepEqual(languageHintsFor("pl"), []);
  assert.deepEqual(languageHintsFor("tr"), []);
  assert.deepEqual(languageHintsFor("zh"), []);
});

// ── Auflösung am Agenten ────────────────────────────────────────────────────
// Bis 0.13.x trug JEDER Agent ["de","en"] als unsichtbare Vorgabe — kein Feld im
// Panel, also von niemandem gewählt. Damit war Flux gesagt, auch Englisch zu
// erwarten; kurze deutsche Äusserungen kamen als englische Phantasiesätze zurück.
test("fromDoc: der Hinweis folgt contentLanguage, nicht einer gespeicherten Vorgabe", () => {
  assert.deepEqual(fromDoc({ _id: "x", name: "a", contentLanguage: "de" }).listen.language_hints, ["de"]);
  assert.deepEqual(fromDoc({ _id: "x", name: "a", contentLanguage: "en" }).listen.language_hints, ["en"]);
});

test("fromDoc: `language: multi` ändert den Hinweis nicht — es zählt die Textsprache", () => {
  // Genau der Fall aus dem Betrieb: Sprachfeld auf multi, Prompt und Ansagen deutsch.
  const a = fromDoc({ _id: "x", name: "a", language: "multi", contentLanguage: "de" });
  assert.equal(a.language, "multi");
  assert.deepEqual(a.listen.language_hints, ["de"]);
});

test("fromDoc: ohne contentLanguage greift der Config-Default", () => {
  const a = fromDoc({ _id: "x", name: "a" });
  assert.deepEqual(a.listen.language_hints, languageHintsFor(config.defaultAgent.contentLanguage));
});

// Der Regressionsschutz: Ein Altbestand-Dokument trägt das Feld noch in der DB.
// Es darf NICHT mehr durchschlagen, sonst kehrt der Fehler mit den Altdaten zurück.
test("fromDoc: ein gespeichertes language_hints aus der Altzeit wird ignoriert", () => {
  const a = fromDoc({
    _id: "x",
    name: "a",
    contentLanguage: "de",
    listen: { model: "flux-general-multi", language_hints: ["de", "en"] },
  } as Parameters<typeof fromDoc>[0]);
  assert.deepEqual(a.listen.language_hints, ["de"], "abgeleitet schlägt gespeichert");
});
