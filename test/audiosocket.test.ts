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
