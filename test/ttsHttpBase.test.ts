import "./helpers/env.js"; // MUSS erster Import bleiben (ENV-Pinning vor config-Load)

import assert from "node:assert/strict";
import { test } from "node:test";

import { HttpTtsStream, type HttpTtsBaseOptions } from "../src/native/ttsHttp.js";
import type { TtsUsage } from "../src/native/types.js";
import { logger } from "../src/util/logger.js";
import { waitFor } from "./helpers/fakes.js";

/** Steuerung eines laufenden synthesize()-Aufrufs aus dem Test heraus. */
interface Gate {
  emit(byte: number, count?: number): void;
  finish(): void;
  fail(message: string): void;
  aborted(): boolean;
}

/**
 * Skriptbare Unterklasse: synthesize() macht kein I/O, sondern meldet sich beim
 * Test an und wartet, bis der Test Audio schickt bzw. abschließt. Damit lässt sich
 * die Reihenfolge-, Flush- und Barge-in-Semantik ohne Netzwerk prüfen.
 */
class ScriptedTts extends HttpTtsStream {
  readonly started: string[] = [];
  private readonly gates = new Map<string, Gate>();

  constructor(opts: Partial<HttpTtsBaseOptions> = {}) {
    super(
      { sourceRate: 8000, targetRate: 8000, concurrency: 1, ...opts },
      logger.child({ mod: "test-http-tts" }),
    );
  }

  protected async synthesize(
    text: string,
    signal: AbortSignal,
    onPcm: (pcm: Buffer) => void,
  ): Promise<void> {
    this.started.push(text);
    await new Promise<void>((resolve, reject) => {
      this.gates.set(text, {
        emit: (byte, count = 2) => onPcm(Buffer.alloc(count, byte)),
        finish: () => resolve(),
        fail: (message) => reject(new Error(message)),
        aborted: () => signal.aborted,
      });
      signal.addEventListener("abort", () => resolve(), { once: true });
    });
  }

  usage(): TtsUsage {
    return { provider: "scripted", model: "scripted", characters: this.charactersSent };
  }

  /** Wartet, bis synthesize() für diesen Text läuft, und gibt die Steuerung zurück. */
  async gate(text: string): Promise<Gate> {
    await waitFor(() => this.gates.has(text));
    return this.gates.get(text) as Gate;
  }
}

function collect(tts: ScriptedTts) {
  const audio: Buffer[] = [];
  const flushed: number[] = [];
  const errors: string[] = [];
  tts.on("audio", (b) => audio.push(b));
  tts.on("flushed", () => flushed.push(audio.length));
  tts.on("error", (e) => errors.push(e));
  return { audio, flushed, errors };
}

// 1 ─ Reihenfolge: drei Sätze, seriell abgearbeitet, Audio in Auftragsreihenfolge.
test("HttpTtsStream: Audio kommt in Auftragsreihenfolge", async () => {
  const tts = new ScriptedTts();
  const seen = collect(tts);

  tts.sendText("A");
  tts.sendText("B");
  tts.sendText("C");

  const a = await tts.gate("A");
  a.emit(0x11);
  a.finish();
  const b = await tts.gate("B");
  b.emit(0x22);
  b.finish();
  const c = await tts.gate("C");
  c.emit(0x33);
  c.finish();

  await waitFor(() => seen.audio.length === 3);
  assert.deepEqual(
    seen.audio.map((x) => x[0]),
    [0x11, 0x22, 0x33],
  );
  tts.close();
});

// 2 ─ Nebenläufigkeit 2: B darf vor A fertig werden, die AUSGABE bleibt trotzdem A→B.
test("HttpTtsStream: Prefetch verschränkt das Audio nicht", async () => {
  const tts = new ScriptedTts({ concurrency: 2 });
  const seen = collect(tts);

  tts.sendText("A");
  tts.sendText("B");

  const a = await tts.gate("A");
  const b = await tts.gate("B"); // läuft parallel — genau das ist der Prefetch
  assert.deepEqual(tts.started, ["A", "B"]);

  // B ist zuerst fertig; solange A läuft, darf nichts von B nach draußen.
  b.emit(0x22);
  b.finish();
  await waitFor(() => tts.started.length === 2);
  assert.equal(seen.audio.length, 0, "B darf vor A kein Audio ausgeben");

  a.emit(0x11);
  a.finish();
  await waitFor(() => seen.audio.length === 2);
  assert.deepEqual(
    seen.audio.map((x) => x[0]),
    [0x11, 0x22],
  );
  tts.close();
});

// 3 ─ flushed kommt strikt NACH dem letzten audio-Event des Turns.
test("HttpTtsStream: flushed erst nach dem letzten Audio", async () => {
  const tts = new ScriptedTts();
  const seen = collect(tts);

  tts.sendText("A");
  tts.flush();
  const a = await tts.gate("A");
  a.emit(0x11);
  assert.equal(seen.flushed.length, 0, "flushed darf nicht kommen, solange A läuft");

  a.finish();
  await waitFor(() => seen.flushed.length === 1);
  // Der beim flushed gemerkte Audio-Zählerstand beweist die Reihenfolge.
  assert.deepEqual(seen.flushed, [1]);
  tts.close();
});

// 4 ─ flush() ohne offene Aufträge bestätigt sofort (wie der Aura-Server auch).
test("HttpTtsStream: flush() bei leerer Queue bestätigt sofort", async () => {
  const tts = new ScriptedTts();
  const seen = collect(tts);
  tts.flush();
  await waitFor(() => seen.flushed.length === 1);
  tts.close();
});

// 5 ─ Barge-in: laufender Auftrag wird abgebrochen, wartende verworfen, und
//     ein Chunk, der noch im Reader lag, darf nicht mehr durchkommen.
test("HttpTtsStream: clear() bricht ab und stellt Nachzügler stumm", async () => {
  const tts = new ScriptedTts();
  const seen = collect(tts);

  tts.sendText("A");
  tts.sendText("B"); // wartet noch
  const a = await tts.gate("A");
  a.emit(0x11);
  await waitFor(() => seen.audio.length === 1);

  tts.clear();
  assert.equal(a.aborted(), true, "der laufende Request muss abgebrochen werden");

  // Nachzügler aus dem bereits laufenden Reader — muss verworfen werden.
  a.emit(0x99);
  a.finish();
  await waitFor(() => tts.started.length === 1);
  assert.equal(seen.audio.length, 1, "nach clear() darf kein Audio mehr kommen");
  assert.deepEqual(tts.started, ["A"], "B darf nach clear() nicht mehr starten");
  assert.equal(seen.errors.length, 0, "ein Abbruch ist kein Fehler");
  tts.close();
});

// 6 ─ Nach clear() ist der Strom sofort wieder benutzbar (nächster Turn).
test("HttpTtsStream: nach clear() funktioniert der nächste Turn", async () => {
  const tts = new ScriptedTts();
  const seen = collect(tts);

  tts.sendText("A");
  const a = await tts.gate("A");
  tts.clear();
  a.finish();

  tts.sendText("C");
  const c = await tts.gate("C");
  c.emit(0x33);
  c.finish();

  await waitFor(() => seen.audio.length === 1);
  assert.equal(seen.audio[0]?.[0], 0x33);
  tts.close();
});

// 7 ─ Abrechnung: nur abgesendete Aufträge zählen, per Barge-in verworfene nicht.
test("HttpTtsStream: usage() zählt verworfene Aufträge nicht", async () => {
  const tts = new ScriptedTts();

  tts.sendText("Hallo"); // 5 Zeichen, startet sofort
  tts.sendText("ungesendet"); // wartet — wird nie abgesendet
  const a = await tts.gate("Hallo");
  tts.clear();
  a.finish();

  await waitFor(() => tts.started.length === 1);
  assert.equal(tts.usage().characters, 5);
  tts.close();
});

// 8 ─ Ein echter Fehler (kein Abbruch) meldet sich und blockiert die Queue nicht.
test("HttpTtsStream: Fehler eines Auftrags hält die Queue nicht auf", async () => {
  const tts = new ScriptedTts();
  const seen = collect(tts);

  tts.sendText("A");
  tts.sendText("B");
  const a = await tts.gate("A");
  a.fail("HTTP 401");

  const b = await tts.gate("B");
  b.emit(0x22);
  b.finish();

  await waitFor(() => seen.audio.length === 1);
  assert.equal(seen.audio[0]?.[0], 0x22, "B muss trotz Fehler in A laufen");
  assert.equal(seen.errors.length, 1);
  assert.match(seen.errors[0] ?? "", /401/);
  tts.close();
});

// 9 ─ close() beendet alles und schweigt danach.
test("HttpTtsStream: close() bricht ab und ignoriert weitere Texte", async () => {
  const tts = new ScriptedTts();
  const seen = collect(tts);

  tts.sendText("A");
  const a = await tts.gate("A");
  tts.close();
  assert.equal(a.aborted(), true);

  tts.sendText("B");
  tts.flush();
  await waitFor(() => true);
  assert.deepEqual(tts.started, ["A"]);
  assert.equal(seen.audio.length, 0);
  assert.equal(seen.flushed.length, 0);
});

// 10 ─ Resampling läuft in Ausgabereihenfolge: 24→8 kHz drittelt die Länge.
test("HttpTtsStream: resampelt auf die System-Rate", async () => {
  const tts = new ScriptedTts({ sourceRate: 24000, targetRate: 8000 });
  const seen = collect(tts);

  tts.sendText("A");
  const a = await tts.gate("A");
  a.emit(0x00, 2400); // 1200 Samples @ 24 kHz
  a.finish();

  await waitFor(() => seen.audio.length > 0);
  const outSamples = seen.audio.reduce((n, b) => n + b.length / 2, 0);
  assert.ok(Math.abs(outSamples - 400) <= 2, `erwartet ~400 Samples, waren ${outSamples}`);
  tts.close();
});
