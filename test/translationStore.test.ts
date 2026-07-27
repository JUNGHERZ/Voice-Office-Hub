import "./helpers/env.js"; // MUSS erster Import bleiben (ENV-Pinning vor config-Load)

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  catalogLabel,
  srcHash,
  staleKeys,
  translatableCatalog,
  usableEntries,
  type StoredEntry,
} from "../src/llm/translationStore.js";
import { parseTranslateResponse } from "../src/llm/localize.js";
import { testAgent } from "./helpers/fakes.js";

/** Baut Einträge so, wie sie nach einer Übersetzung des übergebenen Katalogs aussähen. */
function entriesFor(catalog: Record<string, string>, texts: Record<string, string>): Record<string, StoredEntry> {
  const out: Record<string, StoredEntry> = {};
  for (const [key, text] of Object.entries(texts)) {
    out[key] = { text, srcHash: srcHash(catalog[key]!) };
  }
  return out;
}

// 1 ─ Der Normalfall: unverändertes Original → Übersetzung ist verwendbar.
test("Übersetzung gilt, solange ihr Original unverändert ist", () => {
  const catalog = { greeting: "Hallo!", transferFailed: "Niemand da." };
  const entries = entriesFor(catalog, { greeting: "Hello!", transferFailed: "Nobody there." });

  assert.deepEqual(usableEntries(catalog, entries), {
    greeting: "Hello!",
    transferFailed: "Nobody there.",
  });
  assert.deepEqual(staleKeys(catalog, entries), []);
});

// 2 ─ Kern des Invalidierungs-Designs: das geänderte Original entwertet SEINEN Eintrag,
//     ohne dass irgendein Änderungspfad etwas löschen müsste.
test("Geändertes Original entwertet die Übersetzung — ohne Lösch-Hook", () => {
  const before = { greeting: "Hallo!", transferFailed: "Niemand da." };
  const entries = entriesFor(before, { greeting: "Hello!", transferFailed: "Nobody there." });

  const after = { ...before, greeting: "Guten Tag!" };
  const usable = usableEntries(after, entries);

  assert.equal(usable.greeting, undefined, "veraltete Begrüßung darf nicht ausgespielt werden");
  assert.equal(usable.transferFailed, "Nobody there.", "andere Einträge bleiben gültig");
  assert.deepEqual(staleKeys(after, entries), ["greeting"]);
});

// 3 ─ Eine Teiländerung darf nicht den ganzen Sprachstand wegwerfen (sonst wäre jede
//     Formulierungskorrektur ein Komplett-Neuübersetzen aller Sprachen).
test("Teiländerung invalidiert nur den betroffenen Key", () => {
  const before = { greeting: "Hallo!", "filler.0": "Moment.", "filler.1": "Gleich." };
  const entries = entriesFor(before, {
    greeting: "Hello!",
    "filler.0": "One moment.",
    "filler.1": "Just a sec.",
  });

  const after = { ...before, "filler.1": "Einen Augenblick." };
  assert.deepEqual(staleKeys(after, entries), ["filler.1"]);
  assert.equal(Object.keys(usableEntries(after, entries)).length, 2);
});

// 4 ─ Neu hinzugekommene Ansagen sind noch nicht übersetzt — kein Fehler, nur offen.
test("Neuer Katalog-Key gilt als offen, nicht als Fehler", () => {
  const catalog = { greeting: "Hallo!", "idle.0": "Sind Sie noch da?" };
  const entries = entriesFor({ greeting: "Hallo!" }, { greeting: "Hello!" });

  assert.deepEqual(staleKeys(catalog, entries), ["idle.0"]);
  assert.deepEqual(usableEntries(catalog, entries), { greeting: "Hello!" });
});

// 5 ─ Leerer Eintrag (Modell lieferte nichts) zählt als offen, nicht als gültig.
test("Leerer Übersetzungstext gilt nicht als gültiger Eintrag", () => {
  const catalog = { greeting: "Hallo!" };
  const entries = { greeting: { text: "", srcHash: srcHash("Hallo!") } };

  assert.deepEqual(usableEntries(catalog, entries), {});
  assert.deepEqual(staleKeys(catalog, entries), ["greeting"]);
});

// 6 ─ Ohne gespeicherte Sprache liefert die Prüfung ein leeres Ergebnis statt zu werfen.
test("Fehlende Sprache → leeres Ergebnis, alle Keys offen", () => {
  const catalog = { greeting: "Hallo!", transferFailed: "Niemand da." };
  assert.deepEqual(usableEntries(catalog, {}), {});
  assert.deepEqual(staleKeys(catalog, {}).sort(), ["greeting", "transferFailed"]);
});

// 7 ─ Das Greeting kommt NUR in den vorübersetzten Katalog: zur Laufzeit ist es längst
//     gesprochen, dort wäre es verschwendeter Prompt-Platz.
test("Vorübersetzter Katalog enthält das Greeting, der Laufzeit-Katalog nicht", () => {
  const agent = testAgent({
    greeting: "Hallo! Wie kann ich Ihnen helfen?",
    fillers: { enabled: true, delayMs: 2000, phrases: ["Moment."] },
  });
  const pre = translatableCatalog(agent);

  assert.equal(pre.greeting, "Hallo! Wie kann ich Ihnen helfen?");
  assert.equal(pre["filler.0"], "Moment.");
});

// 8 ─ Sprechende Labels: der Admin sieht Ansagen, keine internen Katalog-Keys.
test("Katalog-Keys bekommen sprechende Labels", () => {
  assert.equal(catalogLabel("greeting"), "Begrüßung");
  assert.equal(catalogLabel("idle.0"), "Stille-Ansage 1");
  assert.equal(catalogLabel("filler.2"), "Filler-Ansage 3");
  assert.equal(catalogLabel("tool.vorgang_status"), "Tool-Ansage: vorgang_status");
  assert.equal(catalogLabel("idleHangup"), "Abschied vor dem Auflegen");
});

// 9 ─ Wie beim Laufzeit-Parser überleben nur bekannte Keys; erfundene werden verworfen.
test("Übersetzungs-Antwort: unbekannte Keys werden verworfen", () => {
  const catalog = { greeting: "Hallo!", "filler.0": "Moment." };
  const phrases = parseTranslateResponse(
    JSON.stringify({
      formality: "formal",
      phrases: { greeting: "Hello!", "filler.0": "One moment.", erfunden: "Nope." },
    }),
    catalog,
  );
  assert.deepEqual(phrases, { greeting: "Hello!", "filler.0": "One moment." });
});

// 10 ─ Eine unvollständige Antwort ist kein Fehler: der Hash-Abgleich zeigt beim nächsten
//      Mal, was noch offen ist, und die Erzeugung holt es nach.
test("Übersetzungs-Antwort: fehlende Keys sind kein Fehler", () => {
  const catalog = { greeting: "Hallo!", "filler.0": "Moment." };
  const phrases = parseTranslateResponse(
    JSON.stringify({ formality: "formal", phrases: { greeting: "Hello!" } }),
    catalog,
  );
  assert.deepEqual(phrases, { greeting: "Hello!" });

  const entries = { greeting: { text: "Hello!", srcHash: srcHash("Hallo!") } };
  assert.deepEqual(staleKeys(catalog, entries), ["filler.0"]);
});

// 11 ─ Unbrauchbare Antwort wirft — der Aufrufer behält dann die Standardsprache.
test("Übersetzungs-Antwort ohne JSON wirft", () => {
  assert.throws(() => parseTranslateResponse("Tut mir leid, ich kann das nicht.", { a: "b" }));
});
