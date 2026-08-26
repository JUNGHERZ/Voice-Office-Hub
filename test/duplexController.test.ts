import "./helpers/env.js"; // MUSS erster Import bleiben (ENV-Pinning vor config-Load)

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import {
  DEFAULT_HOLD_OFF,
  decideTurnEnd,
  endsSentence,
  type TurnVerdict,
} from "../src/duplex/controller.js";

interface TraceTurn {
  turnIndex: number;
  confidence: number;
  transcript: string;
  expected: "answer" | "hold";
}
const trace = JSON.parse(
  readFileSync(new URL("./fixtures/fluxTurnTrace.json", import.meta.url), "utf8"),
) as { turns: TraceTurn[] };

test("endsSentence erkennt Satzschluss inklusive schließender Zeichen", () => {
  assert.equal(endsSentence("Vielen Dank."), true);
  assert.equal(endsSentence("Wie kann ich das machen?"), true);
  assert.equal(endsSentence("Sofort!"), true);
  assert.equal(endsSentence('Er sagte "danke."'), true);
  assert.equal(endsSentence("Genau, sonst"), false);
  assert.equal(endsSentence("   "), false);
});

// Auslassungspunkte stehen im Deutschen fuer den ABBRUCH — sie duerfen nicht als
// Abschluss zaehlen, sonst wuerde ausgerechnet der unfertige Satz durchgewinkt.
test("endsSentence wertet Auslassungspunkte nicht als Abschluss", () => {
  assert.equal(endsSentence("Ich wollte fragen..."), false);
  assert.equal(endsSentence("Ich wollte fragen…"), false);
});

// ── Die eigentliche Probe: die echte Messung vom 26.08.2026 ─────────────────
test("Gesprächsführung entscheidet die aufgezeichneten Turns wie erwartet", () => {
  const wrong: string[] = [];
  for (const t of trace.turns) {
    const v = decideTurnEnd({ transcript: t.transcript, confidence: t.confidence });
    if (v.action !== t.expected) {
      wrong.push(`Turn ${t.turnIndex} (conf ${t.confidence}): ${v.action} statt ${t.expected}`);
    }
  }
  assert.deepEqual(wrong, [], `Fehlentscheidungen:\n${wrong.join("\n")}`);
  assert.equal(trace.turns.filter((t) => t.expected === "hold").length, 2, "zwei unfertige Turns");
});

// Der Beleg dafuer, dass die Reihenfolge der Regel stimmt: Eine reine
// Konfidenzregel scheitert an Turn 6 — vollstaendige Frage bei conf 0.048.
test("Konfidenz allein würde die aufgezeichneten Turns falsch trennen", () => {
  for (const threshold of [0.3, 0.5, 0.7]) {
    const wrong = trace.turns.filter(
      (t) => (t.confidence < threshold ? "hold" : "answer") !== t.expected,
    );
    assert.ok(
      wrong.length > 0,
      `Schwelle ${threshold} trennt entgegen der Messung sauber — Regel überprüfen`,
    );
  }
  const q = trace.turns.find((t) => t.turnIndex === 6)!;
  assert.ok(q.confidence < 0.1 && q.transcript.trim().endsWith("?"));
  assert.equal(decideTurnEnd({ transcript: q.transcript, confidence: q.confidence }).action, "answer");
});

test("Satzzeichen schlägt Konfidenz, nicht umgekehrt", () => {
  // Vollständiger Satz bei minimaler Konfidenz → antworten.
  assert.equal(decideTurnEnd({ transcript: "Das war alles.", confidence: 0.01 }).action, "answer");
  // Unfertig bei hoher Konfidenz → antworten (der Sprecher hat hörbar geschlossen).
  const v = decideTurnEnd({ transcript: "Genau, sonst", confidence: 0.9 });
  assert.equal(v.action, "answer");
  assert.equal(v.reason, "confident-stop");
});

test("Zurückhalten meldet eine Wartegrenze und geschieht nur einmal", () => {
  const held = decideTurnEnd({ transcript: "Genau, sonst", confidence: 0.159 });
  assert.equal(held.action, "hold");
  assert.equal((held as Extract<TurnVerdict, { action: "hold" }>).maxWaitMs, DEFAULT_HOLD_OFF.maxWaitMs);

  // Zweiter Anlauf desselben Turns: Der Anrufer hat nicht weitergesprochen.
  const again = decideTurnEnd({ transcript: "Genau, sonst", confidence: 0.159, heldBefore: true });
  assert.equal(again.action, "answer");
  assert.equal(again.reason, "already-held");
});

test("leeres Transkript wird nicht zurückgehalten", () => {
  const v = decideTurnEnd({ transcript: "   ", confidence: 0 });
  assert.equal(v.action, "answer");
  assert.equal(v.reason, "nothing-said");
});
