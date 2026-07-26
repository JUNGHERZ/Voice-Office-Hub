import "./helpers/env.js"; // MUSS erster Import bleiben (ENV-Pinning vor config-Load)

import assert from "node:assert/strict";
import { test, beforeEach, afterEach } from "node:test";

import { config } from "../src/config.js";
import {
  CallLocalizer,
  buildLocalizationCatalog,
  type LocalizerDeps,
} from "../src/llm/callLocalizer.js";
import type { LocalizeResult } from "../src/llm/localize.js";
import type { LanguageGuess } from "../src/llm/languageScorer.js";
import { settle, testAgent } from "./helpers/fakes.js";

// Der „active"-Gate verlangt einen Requesty-Key — für die aktiven Tests setzen.
let origKey: string;
beforeEach(() => {
  origKey = config.llm.requestyApiKey;
  config.llm.requestyApiKey = "test-key";
});
afterEach(() => {
  config.llm.requestyApiKey = origKey;
});

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const multiAgent = (over: Parameters<typeof testAgent>[0] = {}) =>
  testAgent({
    language: "multi",
    transferFailedAnnouncement: "Ich konnte niemanden erreichen.",
    fillers: { enabled: true, delayMs: 2000, phrases: ["Einen Moment.", "Kurz bitte."] },
    ...over,
  });

/** Baut einen CallLocalizer mit skriptbaren Fakes; gibt Aufzeichnungen mit zurück. */
function makeLocalizer(
  agentOver: Parameters<typeof testAgent>[0] = {},
  depsOver: Partial<LocalizerDeps> = {},
) {
  const localizeCalls: string[] = [];
  const langs: string[] = [];
  const deps: Partial<LocalizerDeps> = {
    localize: async (conversation) => {
      localizeCalls.push(conversation);
      return { language: "en", phrases: { transferFailed: "Could not reach anyone." } };
    },
    scoreLanguage: () => null,
    setLanguage: async (_id, lang) => {
      langs.push(lang);
    },
    ...depsOver,
  };
  const loc = new CallLocalizer(multiAgent(agentOver), "req-1", deps);
  return { loc, localizeCalls, langs };
}

// ── buildLocalizationCatalog ─────────────────────────────────────────────────

test("catalog: Einzelansage, Pool und Per-Tool-Keys", () => {
  const agent = multiAgent({
    transferFailedAnnouncement: "Niemand da.",
    fillers: { enabled: true, delayMs: 2000, phrases: ["A", "B"] },
    customTools: [
      {
        name: "crm",
        description: "",
        parameters: {},
        endpoint: { url: "https://x", method: "POST", headers: {}, timeoutMs: 8000 },
        enabled: true,
        fillerPhrase: "Ich sehe nach…",
      },
    ],
  });
  const { defaults, pools } = buildLocalizationCatalog(agent);
  assert.equal(defaults.transferFailed, "Niemand da.");
  assert.equal(defaults["filler.0"], "A");
  assert.equal(defaults["filler.1"], "B");
  assert.equal(pools.filler, 2);
  assert.equal(defaults["tool.crm"], "Ich sehe nach…");
});

test("catalog: transferFailed fällt auf den Config-Default zurück", () => {
  const { defaults } = buildLocalizationCatalog(multiAgent({ transferFailedAnnouncement: undefined }));
  assert.equal(defaults.transferFailed, config.announcements.transferFailed);
});

test("catalog: idle-Pool wird registriert; idleHangup nur bei hangupAfter", () => {
  const idlePrompts = {
    enabled: true,
    timeoutMs: 8000,
    maxPrompts: 2,
    phrases: ["Sind Sie noch da?", "Soll ich verbinden?"],
    hangupAfter: false,
  };
  const off = buildLocalizationCatalog(multiAgent({ idlePrompts }));
  assert.equal(off.defaults["idle.0"], "Sind Sie noch da?");
  assert.equal(off.defaults["idle.1"], "Soll ich verbinden?");
  assert.equal(off.pools.idle, 2);
  assert.equal(off.defaults.idleHangup, undefined, "ohne Auflegen bleibt der Katalog klein");

  const on = buildLocalizationCatalog(
    multiAgent({ idlePrompts: { ...idlePrompts, hangupAfter: true, hangupAnnouncement: "Tschüss." } }),
  );
  assert.equal(on.defaults.idleHangup, "Tschüss.");

  const fallback = buildLocalizationCatalog(
    multiAgent({ idlePrompts: { ...idlePrompts, hangupAfter: true } }),
  );
  assert.equal(fallback.defaults.idleHangup, config.announcements.idleHangup);
});

test("resolve('idle', stage): Zeilenreihenfolge = Eskalationsstufe, Cursor bleibt stehen", () => {
  const { loc } = makeLocalizer({
    idlePrompts: {
      enabled: true,
      timeoutMs: 8000,
      maxPrompts: 3,
      phrases: ["Stufe eins", "Stufe zwei"],
      hangupAfter: false,
    },
  });
  // Expliziter Index → deterministische Leiter (im Gegensatz zur Filler-Rotation).
  assert.equal(loc.resolve("idle", 0), "Stufe eins");
  assert.equal(loc.resolve("idle", 0), "Stufe eins", "wiederholter Abruf liefert dieselbe Stufe");
  assert.equal(loc.resolve("idle", 1), "Stufe zwei");
  assert.equal(loc.resolve("idle", 2), "Stufe eins", "mehr Stufen als Zeilen → Pool wickelt um");
});

test("resolve('idle'): ohne gepflegte Phrasen leer statt Absturz", () => {
  const { loc } = makeLocalizer({
    idlePrompts: {
      enabled: true, timeoutMs: 8000, maxPrompts: 2, phrases: [], hangupAfter: false,
    },
  });
  assert.equal(loc.resolve("idle", 0), "");
});

// ── Aktivierung / Inertheit ──────────────────────────────────────────────────

test("inaktiv (nicht multi) → kein LLM, resolve liefert Defaults", async () => {
  const { loc, localizeCalls, langs } = makeLocalizer({ language: "de" });
  loc.observeTurn("caller", "hello there my friend how are you");
  await settle();
  assert.equal(localizeCalls.length, 0, "kein Erkennungs-Call für Nicht-multi-Agent");
  assert.equal(langs.length, 0);
  assert.equal(loc.resolve("transferFailed"), "Ich konnte niemanden erreichen.");
});

test("inaktiv ohne Requesty-Key → kein LLM", async () => {
  config.llm.requestyApiKey = "";
  const { loc, localizeCalls } = makeLocalizer();
  loc.observeTurn("caller", "hello there my friend how are you");
  await settle();
  assert.equal(localizeCalls.length, 0);
});

// ── Trigger / Erkennung ──────────────────────────────────────────────────────

test("eager: feuert nicht auf kurzes erstes 'Hallo', dann genau einmal", async () => {
  const { loc, localizeCalls, langs } = makeLocalizer();
  loc.observeTurn("caller", "Hallo"); // 1 Wort, 1. Turn → kein Feuern
  await settle();
  assert.equal(localizeCalls.length, 0);
  loc.observeTurn("caller", "Ich hätte gerne einen Termin"); // ≥3 Wörter → feuert
  await settle();
  assert.equal(localizeCalls.length, 1);
  assert.deepEqual(langs, ["en"], "setLanguage mit erkannter Sprache");
  assert.equal(loc.resolve("transferFailed"), "Could not reach anyone.");
});

test("single-flight: überlappende Trigger → ein Call, danach genau ein Rerun", async () => {
  const d = deferred<LocalizeResult>();
  const { loc, localizeCalls } = makeLocalizer(
    {},
    { localize: async (c) => { localizeCalls.push(c); return d.promise; } },
  );
  loc.observeTurn("caller", "Ich hätte gerne einen Termin"); // Trigger 1 → detecting
  loc.observeTurn("caller", "und noch eine weitere Frage bitte"); // Trigger 2 → rerunPending
  await settle();
  assert.equal(localizeCalls.length, 1, "nur ein gleichzeitiger Call");
  d.resolve({ language: "en" });
  await settle();
  assert.equal(localizeCalls.length, 2, "Rerun nach Abschluss");
});

test("cache: de→en→de, Rücksprung ist ein Cache-Hit (kein LLM)", async () => {
  const results: LocalizeResult[] = [
    { language: "en", phrases: { transferFailed: "EN" } },
    { language: "de" },
  ];
  const guesses: Array<LanguageGuess | null> = [];
  let calls = 0;
  const { loc } = makeLocalizer(
    {},
    {
      localize: async () => {
        calls++;
        return results.shift() ?? { language: "en" };
      },
      scoreLanguage: () => guesses.shift() ?? null,
    },
  );

  loc.observeTurn("caller", "Please help me with this"); // Trigger → en (+phrases)
  await settle();
  assert.equal(calls, 1);
  assert.equal(loc.resolve("transferFailed"), "EN");

  // Zweimal „de" erkennen (Streak 2) → Re-Detection → liefert de (Default).
  guesses.push({ lang: "de", confidence: 0.4 }, { lang: "de", confidence: 0.4 });
  loc.observeTurn("caller", "Ich möchte doch lieber auf Deutsch");
  loc.observeTurn("caller", "Ja genau, bitte auf Deutsch weiter");
  await settle();
  assert.equal(calls, 2, "Re-Detection löste einen zweiten LLM-Call aus");
  assert.equal(loc.resolve("transferFailed"), "Ich konnte niemanden erreichen.", "de → Default");

  // Zurück zu „en" (Streak 2) → en ist gecacht → sofort umschalten, KEIN LLM.
  guesses.push({ lang: "en", confidence: 0.4 }, { lang: "en", confidence: 0.4 });
  loc.observeTurn("caller", "Actually let us continue in English");
  loc.observeTurn("caller", "Yes English is fine for me thanks");
  await settle();
  assert.equal(calls, 2, "Rücksprung nutzt den Cache, kein neuer LLM-Call");
  assert.equal(loc.resolve("transferFailed"), "EN", "Cache-Hit liefert die frühere Übersetzung");
});

test("Fallback: LLM wirft → currentLang bleibt, resolve liefert Default", async () => {
  const { loc, langs } = makeLocalizer({}, { localize: async () => { throw new Error("boom"); } });
  loc.observeTurn("caller", "Please help me with this request");
  await settle();
  assert.equal(loc.getLanguage(), undefined);
  assert.equal(langs.length, 0);
  assert.equal(loc.resolve("transferFailed"), "Ich konnte niemanden erreichen.");
});

// ── resolve / Rotation ───────────────────────────────────────────────────────

test("resolve: Pool rotiert; fehlender/leerer Key → Default bzw. ''", async () => {
  const { loc } = makeLocalizer();
  assert.equal(loc.resolve("filler"), "Einen Moment."); // filler.0
  assert.equal(loc.resolve("filler"), "Kurz bitte."); // filler.1
  assert.equal(loc.resolve("filler"), "Einen Moment."); // Rotation
  assert.equal(loc.resolve("filler", 1), "Kurz bitte."); // expliziter Index
  assert.equal(loc.resolve("unbekannt"), ""); // kein Key → ""
});

test("resolve: fehlende Übersetzung eines Pool-Glieds fällt auf den Default zurück", async () => {
  const { loc } = makeLocalizer(
    {},
    { localize: async () => ({ language: "en", phrases: { "filler.0": "One moment." } }) },
  );
  loc.observeTurn("caller", "Please help me here now");
  await settle();
  assert.equal(loc.resolve("filler", 0), "One moment."); // übersetzt
  assert.equal(loc.resolve("filler", 1), "Kurz bitte."); // nicht übersetzt → Default
});

// ── setLanguage-Dedup / close ────────────────────────────────────────────────

test("setLanguage: nur bei Änderung (dedupliziert)", async () => {
  const { loc, langs } = makeLocalizer(
    {},
    { localize: async () => ({ language: "en" }), scoreLanguage: () => ({ lang: "en", confidence: 0.5 }) },
  );
  loc.observeTurn("caller", "Please help me with this today");
  await settle();
  // Weitere en-Turns dürfen kein zweites setLanguage auslösen.
  loc.observeTurn("caller", "And one more question please thanks");
  loc.observeTurn("caller", "Also this other thing please now");
  await settle();
  assert.deepEqual(langs, ["en"], "setLanguage genau einmal");
});

test("close: bricht laufende Erkennung ab, spätes Ergebnis wird verworfen", async () => {
  const d = deferred<LocalizeResult>();
  const { loc, langs } = makeLocalizer({}, { localize: async () => d.promise });
  loc.observeTurn("caller", "Please help me with this task");
  await settle();
  loc.close();
  d.resolve({ language: "en", phrases: { transferFailed: "EN" } });
  await settle();
  assert.equal(loc.getLanguage(), undefined, "nach close kein Sprachwechsel mehr");
  assert.equal(langs.length, 0, "kein setLanguage nach close");
  loc.observeTurn("caller", "noch ein später Turn nach dem close"); // No-op
  await settle();
});
