import assert from "node:assert/strict";
import net from "node:net";
import { randomUUID } from "node:crypto";
import { test } from "node:test";

import {
  parseFrames,
  buildAudioFrame,
  KIND_UUID,
  KIND_AUDIO,
  AudioSocketServer,
} from "../src/ari/audiosocketServer.js";
import { AmbienceMixer } from "../src/audio/ambience.js";

function frame(kind: number, payload: Buffer): Buffer {
  const h = Buffer.alloc(3);
  h.writeUInt8(kind, 0);
  h.writeUInt16BE(payload.length, 1);
  return Buffer.concat([h, payload]);
}

test("parseFrames: einzelne vollständige Nachricht", () => {
  const buf = frame(KIND_AUDIO, Buffer.from([1, 2, 3, 4]));
  const { frames, rest } = parseFrames(buf);
  assert.equal(frames.length, 1);
  assert.equal(frames[0]!.kind, KIND_AUDIO);
  assert.deepEqual([...frames[0]!.payload], [1, 2, 3, 4]);
  assert.equal(rest.length, 0);
});

test("parseFrames: mehrere Nachrichten in einem Puffer", () => {
  const buf = Buffer.concat([
    frame(KIND_UUID, Buffer.alloc(16, 7)),
    frame(KIND_AUDIO, Buffer.from([9, 9])),
  ]);
  const { frames, rest } = parseFrames(buf);
  assert.equal(frames.length, 2);
  assert.equal(frames[0]!.kind, KIND_UUID);
  assert.equal(frames[1]!.kind, KIND_AUDIO);
  assert.equal(rest.length, 0);
});

test("parseFrames: unvollständige Nachricht bleibt als rest", () => {
  const full = frame(KIND_AUDIO, Buffer.from([1, 2, 3, 4]));
  const partial = full.subarray(0, 5); // Header + 2 von 4 Payload-Bytes
  const { frames, rest } = parseFrames(partial);
  assert.equal(frames.length, 0);
  assert.equal(rest.length, 5);
});

test("parseFrames: Header noch unvollständig", () => {
  const { frames, rest } = parseFrames(Buffer.from([0x10, 0x00]));
  assert.equal(frames.length, 0);
  assert.equal(rest.length, 2);
});

test("buildAudioFrame: roundtrip mit parseFrames", () => {
  const payload = Buffer.from([10, 20, 30, 40, 50]);
  const { frames } = parseFrames(buildAudioFrame(payload));
  assert.equal(frames[0]!.kind, KIND_AUDIO);
  assert.deepEqual([...frames[0]!.payload], [...payload]);
});

test("AudioSocketServer: Loopback-Echo über TCP (ohne Asterisk)", async () => {
  const server = new AudioSocketServer();
  // Ephemerer Port; Host kommt aus der Config (127.0.0.1).
  const port = 18099;
  await server.start(port);

  const uuid = randomUUID();
  const session = server.register(uuid, "test-call");
  session.enableRawEcho();

  const audioPayload = Buffer.from([0x11, 0x22, 0x33, 0x44, 0x55, 0x66]);

  const echoed = await new Promise<Buffer>((resolve, reject) => {
    const client = net.connect(port, "127.0.0.1", () => {
      // UUID-Frame (16 rohe Bytes) + Audio-Frame senden.
      const raw = Buffer.from(uuid.replace(/-/g, ""), "hex");
      client.write(frame(KIND_UUID, raw));
      client.write(frame(KIND_AUDIO, audioPayload));
    });
    let acc = Buffer.alloc(0);
    client.on("data", (d) => {
      acc = Buffer.concat([acc, d]);
      const { frames } = parseFrames(acc);
      const audio = frames.find((f) => f.kind === KIND_AUDIO);
      if (audio) {
        client.end();
        resolve(Buffer.from(audio.payload));
      }
    });
    client.on("error", reject);
    setTimeout(() => reject(new Error("Timeout: kein Echo erhalten")), 2000);
  });

  assert.deepEqual([...echoed], [...audioPayload]);
  session.close();
  await server.stop();
});

// ── Ambience im Playout-Takt ──────────────────────────────────────────────────

/** Int16-Loop mit konstantem Sample-Wert (macht Misch-Ergebnisse exakt prüfbar). */
function constLoop(value: number, samples = 1600): Buffer {
  const buf = Buffer.alloc(samples * 2);
  for (let i = 0; i < samples; i++) buf.writeInt16LE(value, i * 2);
  return buf;
}

/** Verbindet sich als Asterisk-Ersatz, sendet die UUID und sammelt Audio-Frames. */
async function connectCollector(port: number, uuid: string): Promise<{ frames: Buffer[]; close: () => void }> {
  const frames: Buffer[] = [];
  const client: net.Socket = await new Promise((resolve, reject) => {
    const c = net.connect(port, "127.0.0.1", () => {
      c.write(frame(KIND_UUID, Buffer.from(uuid.replace(/-/g, ""), "hex")));
      resolve(c);
    });
    c.on("error", reject);
  });
  let acc = Buffer.alloc(0);
  client.on("data", (d) => {
    acc = Buffer.concat([acc, d]);
    const { frames: parsed, rest } = parseFrames(acc);
    acc = rest;
    for (const f of parsed) if (f.kind === KIND_AUDIO) frames.push(Buffer.from(f.payload));
  });
  return { frames, close: () => client.destroy() };
}

async function until(cond: () => boolean, timeoutMs = 3000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error("until: Timeout");
    await new Promise<void>((r) => setTimeout(r, 20));
  }
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

test("Ambience: kontinuierliche Frames ohne TTS, pendingMs bleibt 0", async () => {
  const server = new AudioSocketServer();
  const port = 18101;
  await server.start(port);
  const uuid = randomUUID();
  const session = server.register(uuid, "amb-1", new AmbienceMixer(constLoop(1000), 1));
  const collector = await connectCollector(port, uuid);

  await until(() => collector.frames.length >= 10);
  assert.ok(collector.frames.every((f) => f.length === 320), "volle 20-ms-Frames");
  assert.equal(collector.frames[0]!.readInt16LE(0), 1000, "reine Ambience statt Stille");
  assert.equal(session.pendingMs(), 0, "Ambience zählt nie als TTS-Backlog");

  collector.close();
  session.close();
  await server.stop();
});

test("Ambience: TTS wird gemischt, flush() stoppt die Ambience nicht", async () => {
  const server = new AudioSocketServer();
  const port = 18102;
  await server.start(port);
  const uuid = randomUUID();
  const session = server.register(uuid, "amb-2", new AmbienceMixer(constLoop(1000), 1));
  const collector = await connectCollector(port, uuid);

  await until(() => collector.frames.length >= 3);
  // TTS mit Wechselanteil (±500 alternierend): reine Konstantwerte wären DC und würden
  // vom DC-Blocker (0.6.23) korrekt entfernt. Gemessen in der Frame-Mitte, weil
  // Burst-Grenzen seit 0.6.22 ein-/ausgeblendet werden.
  const tts = Buffer.alloc(320);
  for (let i = 0; i < 160; i++) tts.writeInt16LE(i % 2 ? -500 : 500, i * 2);
  session.sendAudio(tts);
  // Gemischtes Frame = TTS (±500) + Ambience (1000) → Mitte weicht deutlich von 1000 ab.
  await until(() => collector.frames.some((f) => Math.abs(f.readInt16LE(160) - 1000) > 400));

  const before = collector.frames.length;
  session.flush(); // Barge-in: TTS weg, Takt läuft weiter
  await until(() => collector.frames.length > before + 3);
  assert.equal(session.pendingMs(), 0);
  assert.equal(collector.frames[collector.frames.length - 1]!.readInt16LE(0), 1000, "nach flush wieder reine Ambience");

  collector.close();
  session.close();
  await server.stop();
});

test("Ambience: Pause → Stille-Frames laufen weiter; Resume liefert wieder Atmosphäre", async () => {
  const server = new AudioSocketServer();
  const port = 18103;
  await server.start(port);
  const uuid = randomUUID();
  const session = server.register(uuid, "amb-3", new AmbienceMixer(constLoop(1000), 1));
  const collector = await connectCollector(port, uuid);

  await until(() => collector.frames.length >= 3);
  session.setAmbiencePaused(true);
  // Dauertakt (0.6.21): kein Underrun-Stopp mehr — statt gar nichts fließt hauchleises
  // Komfortrauschen (ein abreißender Strom erzeugte auf Endgeräten ein hörbares Klicken).
  await until(() => collector.frames.some((f) => Math.abs(f.readInt16LE(0)) <= 12 && f.readInt16LE(0) !== 1000));
  const atPause = collector.frames.length;
  await until(() => collector.frames.length > atPause + 5);
  assert.ok(
    Math.abs(collector.frames[collector.frames.length - 1]!.readInt16LE(0)) <= 12,
    "während der Pause fließt leises Komfortrauschen",
  );

  session.setAmbiencePaused(false);
  await until(() =>
    collector.frames.length > 0 && collector.frames[collector.frames.length - 1]!.readInt16LE(0) === 1000,
  );

  collector.close();
  session.close();
  await server.stop();
});

test("Playout ohne Ambience: Takt läuft nach dem Äußerungsende weiter (Klick-Fix 0.6.21)", async () => {
  const server = new AudioSocketServer();
  const port = 18104;
  await server.start(port);
  const uuid = randomUUID();
  const session = server.register(uuid, "click-1"); // KEINE Ambience
  const collector = await connectCollector(port, uuid);

  // Schon vor jedem TTS fließt Komfortrauschen (Takt startet mit attach()).
  await until(() => collector.frames.length >= 3);

  // TTS mit Wechselanteil (±700 alternierend, überlebt den DC-Blocker); Frame-Mitte
  // prüfen, weil Burst-Grenzen seit 0.6.22 ein-/ausgeblendet werden.
  const tts = Buffer.alloc(320);
  for (let i = 0; i < 160; i++) tts.writeInt16LE(i % 2 ? -700 : 700, i * 2);
  session.sendAudio(tts);
  await until(() => collector.frames.some((f) => Math.abs(f.readInt16LE(160)) > 600));

  // Onset-Rampe: das erste (und hier einzige) Burst-Frame startet bei ~0 statt hart auf ±700,
  // und läuft am Ende wieder auf 0 aus (Aura-DC-Sprung → Klick-Fix).
  const burst = collector.frames.find((f) => Math.abs(f.readInt16LE(160)) > 600)!;
  assert.ok(Math.abs(burst.readInt16LE(0)) < 100, "Burst-Anfang eingeblendet");
  assert.equal(burst.readInt16LE(318), 0, "Burst-Ende exakt auf 0 ausgeblendet");

  // Früher stoppte der Takt ~1 s (50 Frames) nach dem letzten TTS-Frame → Klick beim
  // Endgerät. Jetzt: deutlich über die alte Grenze hinaus warten — der Strom reißt nie ab.
  const afterTts = collector.frames.length;
  await sleep(1400);
  assert.ok(
    collector.frames.length > afterTts + 55,
    `Takt läuft über die alte Underrun-Grenze hinaus (${collector.frames.length - afterTts} Frames seit TTS-Ende)`,
  );
  const idle = collector.frames[collector.frames.length - 1]!;
  const idleSamples = [0, 80, 159].map((i) => idle.readInt16LE(i * 2));
  assert.ok(idleSamples.every((v) => Math.abs(v) <= 12), "im Leerlauf fließt leises Komfortrauschen");
  assert.ok(idleSamples.some((v) => v !== 0), "Rauschen ist nicht digital tot");
  assert.equal(session.pendingMs(), 0, "Rauschen zählt nicht als TTS-Backlog");

  collector.close();
  session.close();
  await server.stop();
});

test("DC-Blocker: Gleichspannungs-Sockel wird entfernt (Klick-Fix 0.6.23)", async () => {
  const server = new AudioSocketServer();
  const port = 18105;
  await server.start(port);
  const uuid = randomUUID();
  const session = server.register(uuid, "dc-1"); // ohne Ambience
  const collector = await connectCollector(port, uuid);
  await until(() => collector.frames.length >= 2);

  // 3 Frames reine Gleichspannung (konstant 700) — wie der Aura-DC-Sockel.
  const dc = Buffer.alloc(960);
  for (let i = 0; i < 480; i++) dc.writeInt16LE(700, i * 2);
  session.sendAudio(dc);
  await until(() => collector.frames.some((f) => Math.abs(f.readInt16LE(160)) > 300));

  // Der Einschalt-Transient darf durch (erste ms), aber die Gleichspannung selbst
  // klingt ab — kein Frame trägt den vollen 700er-Sockel in der Mitte.
  await until(() => {
    const mids = collector.frames.map((f) => Math.abs(f.readInt16LE(160)));
    return mids.some((v) => v > 300) && mids.some((v) => v > 12 && v < 120);
  });
  const mids = collector.frames.map((f) => Math.abs(f.readInt16LE(160)));
  assert.ok(!mids.some((v) => v > 640), `DC-Sockel wird abgebaut (max Mitte=${Math.max(...mids)})`);

  collector.close();
  session.close();
  await server.stop();
});
