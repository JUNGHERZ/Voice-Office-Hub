import "./helpers/env.js"; // MUSS erster Import bleiben (ENV-Pinning vor config-Load)

import assert from "node:assert/strict";
import { test } from "node:test";

import { DEFAULT_LANGUAGE_LOCK, LanguageLock } from "../src/native/languageLock.js";

const LONG_DE = "Ich hätte da mal eine Frage zu meinem Vertrag, geht das jetzt?";
const LONG_EN = "I would like to practise a little bit of English with you today.";

test("Sprachnachführung: gleiche Sprache schaltet nie um", () => {
  const lock = new LanguageLock(["de"]);
  for (let i = 0; i < 5; i += 1) {
    assert.equal(lock.observe(LONG_DE, ["de"]), undefined);
  }
  assert.equal(lock.active(), "de");
});

test("Sprachnachführung: erst der zweite Turn derselben Fremdsprache schaltet um", () => {
  const lock = new LanguageLock(["de"]);
  assert.equal(lock.observe(LONG_EN, ["en"]), undefined, "einer reicht nicht");
  assert.deepEqual(lock.observe(LONG_EN, ["en"]), ["en"]);
  assert.equal(lock.active(), "en");
  assert.equal(lock.observe(LONG_EN, ["en"]), undefined, "danach ist Ruhe");
});

// Der Kern der Sache: Genau bei kurzen Äusserungen verhaspelt sich die Erkennung
// („Ja, ja" → „Yep. Yep."). Würden sie umschalten, verstärkte sich der Fehler selbst.
test("Sprachnachführung: kurze Turns schalten nicht um", () => {
  const lock = new LanguageLock(["de"]);
  for (let i = 0; i < 6; i += 1) {
    assert.equal(lock.observe("Yep. Yep.", ["en"]), undefined);
  }
  assert.equal(lock.active(), "de", "der Hinweis bleibt");
});

test("Sprachnachführung: ein zwischengeschobener deutscher Turn bricht die Serie", () => {
  const lock = new LanguageLock(["de"]);
  lock.observe(LONG_EN, ["en"]);
  assert.equal(lock.observe(LONG_DE, ["de"]), undefined, "zurück auf Los");
  assert.equal(lock.observe(LONG_EN, ["en"]), undefined, "Serie beginnt neu");
  assert.deepEqual(lock.observe(LONG_EN, ["en"]), ["en"]);
});

test("Sprachnachführung: unbekannte oder fehlende Sprache wird ignoriert", () => {
  const lock = new LanguageLock(["de"]);
  assert.equal(lock.observe(LONG_EN, ["pl"]), undefined, "kennt flux-general-multi nicht");
  assert.equal(lock.observe(LONG_EN, []), undefined);
  assert.equal(lock.observe(LONG_EN, undefined), undefined);
  assert.equal(lock.active(), "de");
});

test("Sprachnachführung: ohne Start-Hinweis wird die erste sichere Sprache gesetzt", () => {
  const lock = new LanguageLock([]);
  assert.equal(lock.active(), "");
  assert.equal(lock.observe(LONG_EN, ["en"]), undefined);
  assert.deepEqual(lock.observe(LONG_EN, ["en"]), ["en"]);
});

test("Sprachnachführung: Regionalcodes werden auf die Basissprache reduziert", () => {
  const lock = new LanguageLock(["de"]);
  lock.observe(LONG_EN, ["en-US"]);
  assert.deepEqual(lock.observe(LONG_EN, ["en-GB"]), ["en"]);
});

test("Sprachnachführung: Schwellen sind die dokumentierten", () => {
  assert.equal(DEFAULT_LANGUAGE_LOCK.confirmTurns, 2);
  assert.equal(DEFAULT_LANGUAGE_LOCK.minChars, 25);
});
