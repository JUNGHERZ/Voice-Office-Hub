import "./helpers/env.js"; // MUSS erster Import bleiben (ENV-Pinning vor config-Load)

import assert from "node:assert/strict";
import { test } from "node:test";

import { SpeechClock, cutAtWord } from "../src/native/speechClock.js";

const S1 = "Der Kontostand beträgt zwölftausend Euro.";
const S2 = "Soll ich Ihnen die letzten Buchungen vorlesen?";
const S3 = "Oder möchten Sie lieber eine Überweisung veranlassen?";

/** Segmentierter Modus: ein Adaptermeldung je Satz, danach dessen Audio. */
function segmented(parts: Array<[string, number]>): SpeechClock {
  const clock = new SpeechClock();
  for (const [text] of parts) clock.queued(text);
  for (const [text, ms] of parts) {
    clock.segment(text);
    clock.audio(ms);
  }
  return clock;
}

test("cutAtWord gibt nie ein halbes Wort zurück", () => {
  assert.equal(cutAtWord("Der Kontostand beträgt", 8), "Der");
  assert.equal(cutAtWord("Der Kontostand beträgt", 3), "Der", "die 3 IST die Wortgrenze");
  assert.equal(cutAtWord("Der Kontostand beträgt", 2), "", "mitten im ersten Wort → nichts");
  assert.equal(cutAtWord("Unteilbar", 5), "", "ein einziges Wort wird nicht angeschnitten");
  assert.equal(cutAtWord("Der Kontostand", 99), "Der Kontostand");
  assert.equal(cutAtWord("Der Kontostand", 0), "");
});

test("cutAtWord entfernt hängende Satzzeichen vor der Auslassung", () => {
  assert.equal(cutAtWord("Guten Tag, ich bin", 11), "Guten Tag");
});

test("frische Uhr meldet nichts und gilt als vollständig", () => {
  const clock = new SpeechClock();
  assert.deepEqual(clock.spokenAt(0), { text: "", complete: true });
  assert.equal(clock.emittedMs(), 0);
});

test("segmentiert: alles abgespielt ergibt den ganzen Text", () => {
  const clock = segmented([
    [S1, 2500],
    [S2, 2800],
  ]);
  assert.equal(clock.emittedMs(), 5300);
  const slice = clock.spokenAt(5300);
  assert.equal(slice.text, `${S1} ${S2}`);
  assert.equal(slice.complete, true);
});

test("segmentiert: Schnitt mitten im zweiten Satz behält den ersten ganz", () => {
  const clock = segmented([
    [S1, 2500],
    [S2, 2800],
  ]);
  // 2500 ms Satz 1 + 700 ms von Satz 2 → rund ein Viertel des zweiten Satzes.
  const slice = clock.spokenAt(3200);
  assert.equal(slice.complete, false);
  assert.ok(slice.text.startsWith(S1), "Satz 1 muss vollständig drinstehen");
  const rest = slice.text.slice(S1.length).trim();
  assert.ok(rest.length > 0 && rest.length < S2.length, `Bruchstück erwartet, war: "${rest}"`);
  assert.ok(S2.startsWith(rest), "das Bruchstück muss ein Präfix von Satz 2 sein");
});

test("segmentiert: rundet ab — nie mehr behaupten als erklungen ist", () => {
  const clock = segmented([[S1, 4000]]);
  // Exakt bei 50 % der Audiodauer: höchstens die halbe Zeichenzahl darf herauskommen.
  const slice = clock.spokenAt(2000);
  assert.ok(slice.text.length <= Math.ceil(S1.length / 2), `zu viel: "${slice.text}"`);
  assert.ok(S1.startsWith(slice.text));
});

test("segmentiert: noch nicht erklungener Text macht den Turn unvollständig", () => {
  const clock = new SpeechClock();
  clock.queued(S1);
  clock.queued(S2);
  clock.queued(S3); // dritter Satz war eingereiht, sein Audio kam nie
  clock.segment(S1);
  clock.audio(2500);
  clock.segment(S2);
  clock.audio(2800);

  const slice = clock.spokenAt(5300);
  assert.equal(slice.text, `${S1} ${S2}`);
  assert.equal(slice.complete, false, "der dritte Satz fehlt → nicht vollständig");
});

test("flach: schätzt über die Sprechrate und überschätzt nicht bei viel Wartetext", () => {
  // Der gefährliche Fall: drei Sätze eingereiht, aber nur eine Sekunde Audio.
  // Eine anteilige Rechnung (played/total) käme hier auf 100 % und behauptete alles.
  const clock = new SpeechClock();
  clock.queued(S1);
  clock.queued(S2);
  clock.queued(S3);
  clock.audio(1000);

  const slice = clock.spokenAt(1000);
  assert.equal(slice.complete, false);
  assert.ok(slice.text.length <= 20, `höchstens ~14 Zeichen erwartet, war: "${slice.text}"`);
  assert.ok(`${S1} ${S2} ${S3}`.startsWith(slice.text));
});

test("flach: Sprechrate skaliert mit speak.speed", () => {
  const slow = new SpeechClock(1);
  const fast = new SpeechClock(1.5);
  assert.ok(fast.rate() > slow.rate());

  for (const clock of [slow, fast]) {
    clock.queued(`${S1} ${S2} ${S3}`);
    clock.audio(2000);
  }
  assert.ok(fast.spokenAt(2000).text.length > slow.spokenAt(2000).text.length);
});

test("Kalibrierung misst die Rate am ungestörten Turn", () => {
  const clock = new SpeechClock();
  const text = `${S1} ${S2}`;
  const expected = text.length / 4.3;
  clock.queued(text);
  clock.audio(4300);
  clock.calibrate();
  assert.ok(Math.abs(clock.rate() - expected) < 0.01, `Rate war ${clock.rate()}`);

  // Danach schneidet der flache Modus mit der gemessenen Rate.
  clock.reset();
  assert.ok(Math.abs(clock.rate() - expected) < 0.01, "die Rate überlebt den Turn-Wechsel");
  clock.queued(text);
  clock.audio(1000);
  const slice = clock.spokenAt(1000);
  assert.ok(slice.text.length > 0, "eine Sekunde ergibt mehr als nichts");
  assert.ok(slice.text.length <= Math.ceil(expected), `höchstens eine Sekunde Text, war ${slice.text.length}`);
});

test("Kalibrierung ignoriert zu kurze Turns und Ausreisser", () => {
  const short = new SpeechClock();
  short.queued(S1);
  short.audio(400);
  short.calibrate();
  assert.equal(short.rate(), 14, "zu kurz gemessen → Schätzwert bleibt");

  const absurd = new SpeechClock();
  absurd.queued("kurz");
  absurd.audio(9000); // 0,44 Zeichen/s — offensichtlich Unsinn
  absurd.calibrate();
  assert.equal(absurd.rate(), 14, "unplausible Messung wird verworfen");
});

test("spokenAt begrenzt die Position auf das tatsächlich ausgegebene Audio", () => {
  const clock = segmented([[S1, 2500]]);
  assert.equal(clock.spokenAt(99999).text, S1, "mehr als erzeugt gibt es nicht");
  assert.deepEqual(clock.spokenAt(-500), { text: "", complete: false });
});

test("reset räumt Text und Audio, nicht die gelernte Rate", () => {
  const clock = segmented([[S1, 2500]]);
  clock.reset();
  assert.equal(clock.emittedMs(), 0);
  assert.deepEqual(clock.spokenAt(1000), { text: "", complete: true });
});

test("glue: fugenlose Segmente ergeben wieder den Originaltext", () => {
  // ElevenLabs-Fall: Nachrichtengrenzen liegen mitten im Wort.
  const clock = new SpeechClock();
  clock.queued("Der Kontostand betraegt zwoelftausend Euro.");
  clock.segment("Der Kontostand betra", "");
  clock.audio(1000);
  clock.segment("egt zwoelftausend Euro. ", "");
  clock.audio(1200);

  assert.equal(clock.spokenAt(2200).text, "Der Kontostand betraegt zwoelftausend Euro.");
  assert.equal(clock.spokenAt(2200).complete, true);
});

test("glue: feine Segmente schneiden genauer als ein ganzer Satz", () => {
  const clock = new SpeechClock();
  clock.queued("Der Kontostand betraegt zwoelftausend Euro.");
  clock.segment("Der Kontostand betra", "");
  clock.audio(1000);
  clock.segment("egt zwoelftausend Euro. ", "");
  clock.audio(1200);

  // Mitten in der zweiten Nachricht: das erste Stück steht ganz, das zweite anteilig.
  const slice = clock.spokenAt(1600);
  assert.equal(slice.complete, false);
  assert.ok(slice.text.startsWith("Der Kontostand betraegt"), `war: "${slice.text}"`);
  assert.ok(slice.text.length < "Der Kontostand betraegt zwoelftausend Euro.".length);
  assert.ok("Der Kontostand betraegt zwoelftausend Euro.".startsWith(slice.text));
});
