import "./helpers/env.js"; // MUSS erster Import bleiben (ENV-Pinning vor config-Load)

import assert from "node:assert/strict";
import { test } from "node:test";

import { IdleWatcher, type IdleWatcherHooks } from "../src/ari/idleWatcher.js";
import type { ResolvedIdlePrompts } from "../src/types.js";

const cfg = (over: Partial<ResolvedIdlePrompts> = {}): ResolvedIdlePrompts => ({
  enabled: true,
  timeoutMs: 8000,
  maxPrompts: 2,
  phrases: ["Sind Sie noch da?", "Soll ich Sie verbinden?"],
  hangupAfter: false,
  ...over,
});

interface Harness {
  watcher: IdleWatcher;
  spoken: string[];
  /** Mitgelieferte Eskalationsstufe je Ansage (fürs Logging im callHandler). */
  stages: number[];
  hangups: number;
  audible: boolean;
  blocked: boolean;
}

/** `random: () => 0` → kein Jitter, die Fälligkeiten sind exakt vorhersagbar. */
function makeWatcher(over: Partial<ResolvedIdlePrompts> = {}, random = () => 0): Harness {
  const h: Harness = {
    watcher: undefined as unknown as IdleWatcher,
    spoken: [],
    stages: [],
    hangups: 0,
    audible: false,
    blocked: false,
  };
  const phrases = over.phrases ?? cfg().phrases;
  const hooks: IdleWatcherHooks = {
    isAgentAudible: () => h.audible,
    isBlocked: () => h.blocked,
    phrase: (stage) => phrases[stage] ?? "",
    speak: (text, stage) => {
      h.spoken.push(text);
      h.stages.push(stage);
    },
    hangup: () => { h.hangups += 1; },
  };
  h.watcher = new IdleWatcher(cfg(over), hooks, random);
  return h;
}

/** Taktet den Watcher wie der callHandler: alle 250 ms ab `from` bis `to`. */
function run(h: Harness, from: number, to: number): void {
  for (let t = from; t <= to; t += 250) h.watcher.tick(t);
}

// ── Grundverhalten ───────────────────────────────────────────────────────────

test("IdleWatcher: erste Ansage genau nach timeoutMs", () => {
  const h = makeWatcher();
  h.watcher.noteCallerActivity(0);
  run(h, 0, 7750);
  assert.deepEqual(h.spoken, [], "vor Ablauf schweigt der Wächter");
  h.watcher.tick(8000);
  assert.deepEqual(h.spoken, ["Sind Sie noch da?"]);
});

test("IdleWatcher: ohne vorherige Anrufer-Aktivität verankert der erste Tick", () => {
  // Regressionsschutz: Ein Anker von 0 (Epoch) läge immer in der Vergangenheit — der
  // Wächter hätte direkt beim Anrufaufbau gesprochen, noch vor dem ersten Wort.
  const h = makeWatcher();
  run(h, 1_700_000_000_000, 1_700_000_007_750);
  assert.deepEqual(h.spoken, [], "die Stille zählt ab dem ersten Tick, nicht seit Epoch");
  h.watcher.tick(1_700_000_008_250);
  assert.deepEqual(h.spoken, ["Sind Sie noch da?"]);
});

test("IdleWatcher: deaktiviert → nie eine Ansage", () => {
  const h = makeWatcher({ enabled: false });
  h.watcher.noteCallerActivity(0);
  run(h, 0, 60_000);
  assert.deepEqual(h.spoken, []);
  assert.equal(h.hangups, 0);
});

test("IdleWatcher: hörbarer Agent zieht den Anker mit (keine Ansage)", () => {
  const h = makeWatcher();
  h.watcher.noteCallerActivity(0);
  h.audible = true;
  run(h, 0, 30_000);
  assert.deepEqual(h.spoken, [], "solange der Agent spricht, beginnt die Stille nicht");
  // Agent verstummt bei 30 s → volle Wartezeit ab dort, nicht rückwirkend.
  h.audible = false;
  run(h, 30_000, 37_750);
  assert.deepEqual(h.spoken, []);
  h.watcher.tick(38_000);
  assert.deepEqual(h.spoken, ["Sind Sie noch da?"]);
});

test("IdleWatcher: gesperrt (Transfer/Tool/Auflegen) → keine Ansage", () => {
  const h = makeWatcher();
  h.watcher.noteCallerActivity(0);
  h.blocked = true;
  run(h, 0, 30_000);
  assert.deepEqual(h.spoken, [], "während einer Sperre schweigt der Wächter");
  h.blocked = false;
  run(h, 30_000, 38_000);
  assert.deepEqual(h.spoken, ["Sind Sie noch da?"]);
});

test("IdleWatcher: Anrufer-Aktivität setzt die Leiter zurück", () => {
  const h = makeWatcher();
  h.watcher.noteCallerActivity(0);
  h.watcher.tick(8000);
  assert.deepEqual(h.spoken, ["Sind Sie noch da?"]);

  h.watcher.noteCallerActivity(9000); // Anrufer antwortet → neue Episode
  run(h, 9000, 16_750);
  assert.deepEqual(h.spoken, ["Sind Sie noch da?"], "Stufe 0 wartet wieder die volle Zeit");
  h.watcher.tick(17_000);
  assert.deepEqual(
    h.spoken,
    ["Sind Sie noch da?", "Sind Sie noch da?"],
    "neue Episode beginnt wieder bei Stufe 1 des Pools",
  );
});

// ── Eskalation, Backoff, Jitter ──────────────────────────────────────────────

test("IdleWatcher: Backoff — Stufe 2 wartet 1,5×, die Gnadenfrist 2×", () => {
  const h = makeWatcher({ hangupAfter: true });
  h.watcher.noteCallerActivity(0);
  h.watcher.tick(8000); // Stufe 1 nach 1,0 × 8000
  assert.deepEqual(h.spoken, ["Sind Sie noch da?"]);

  run(h, 8000, 19_750);
  assert.equal(h.spoken.length, 1, "Stufe 2 erst nach 1,5 × 8000 = 12 s");
  h.watcher.tick(20_000);
  assert.deepEqual(h.spoken, ["Sind Sie noch da?", "Soll ich Sie verbinden?"]);

  run(h, 20_000, 35_750);
  assert.equal(h.hangups, 0, "Gnadenfrist ist 2 × 8000 = 16 s");
  h.watcher.tick(36_000);
  assert.equal(h.hangups, 1);
});

test("IdleWatcher: speak() bekommt die Eskalationsstufe mitgeliefert", () => {
  const h = makeWatcher();
  h.watcher.noteCallerActivity(0);
  h.watcher.tick(8000);
  h.watcher.tick(20_000); // Stufe 2 nach 1,5 × 8000
  assert.deepEqual(h.stages, [0, 1], "0-basiert und aufsteigend");

  h.watcher.noteCallerActivity(21_000); // neue Episode → Zähler beginnt wieder bei 0
  h.watcher.tick(29_000);
  assert.deepEqual(h.stages, [0, 1, 0]);
});

test("IdleWatcher: Jitter streckt nur nach oben, nie darunter", () => {
  const h = makeWatcher({}, () => 1); // Maximaler Jitter: +20 %
  h.watcher.noteCallerActivity(0);
  run(h, 0, 9500);
  assert.deepEqual(h.spoken, [], "8000 ist eine Zusage nach unten — mit Jitter wird es später");
  h.watcher.tick(9600); // 8000 × 1,2
  assert.deepEqual(h.spoken, ["Sind Sie noch da?"]);
});

test("IdleWatcher: maxPrompts begrenzt die Leiter; ohne hangupAfter kehrt Ruhe ein", () => {
  const h = makeWatcher({ maxPrompts: 1 });
  h.watcher.noteCallerActivity(0);
  run(h, 0, 120_000);
  assert.deepEqual(h.spoken, ["Sind Sie noch da?"], "genau eine Ansage");
  assert.equal(h.hangups, 0, "ohne hangupAfter wird nicht aufgelegt");
});

test("IdleWatcher: hangupAfter legt genau einmal auf", () => {
  const h = makeWatcher({ maxPrompts: 1, hangupAfter: true });
  h.watcher.noteCallerActivity(0);
  run(h, 0, 120_000);
  assert.equal(h.hangups, 1, "kein Dauerfeuer nach dem Auflegen");
});

test("IdleWatcher: leere Phrase spricht nicht, die Stufe läuft trotzdem weiter", () => {
  const h = makeWatcher({ phrases: [], maxPrompts: 2, hangupAfter: true });
  h.watcher.noteCallerActivity(0);
  run(h, 0, 40_000);
  assert.deepEqual(h.spoken, [], "ohne gepflegte Phrasen bleibt es still");
  assert.equal(h.hangups, 1, "die Leiter läuft trotzdem bis zum Auflegen durch");
});

test("IdleWatcher: eine Stufe ohne Text bricht die Leiter nicht ab", () => {
  // Der Watcher fragt jede Stufe einzeln ab; liefert der Localizer für eine nichts,
  // wird sie übersprungen statt die Leiter zu beenden. (Das Umwickeln des Pools bei
  // mehr Stufen als Zeilen macht der Localizer — siehe callLocalizer.test.ts.)
  const h = makeWatcher({ phrases: ["Nur eine.", ""], maxPrompts: 3, hangupAfter: true });
  h.watcher.noteCallerActivity(0);
  run(h, 0, 80_000);
  assert.deepEqual(h.spoken, ["Nur eine."]);
  assert.equal(h.hangups, 1, "nach der letzten Stufe wird trotzdem aufgelegt");
});
