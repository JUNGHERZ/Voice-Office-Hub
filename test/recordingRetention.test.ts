import "./helpers/env.js"; // MUSS erster Import bleiben (ENV-Pinning vor config-Load)

import assert from "node:assert/strict";
import { test } from "node:test";

import { sweepRecordings } from "../src/db/recordingRetention.js";

const DAY = 24 * 60 * 60 * 1000;
const NOW = new Date("2026-08-22T12:00:00.000Z");

function fakes(files: Array<{ id: string; ageDays: number }>) {
  const deleted: string[] = [];
  const cleared: Date[] = [];
  return {
    deleted,
    cleared,
    deps: {
      listExpired: async (cutoff: Date) =>
        files
          .filter((f) => NOW.getTime() - f.ageDays * DAY < cutoff.getTime())
          .map((f) => ({ _id: f.id as never })),
      deleteFile: async (id: unknown) => {
        deleted.push(String(id));
      },
      clearReferences: async (cutoff: Date) => {
        cleared.push(cutoff);
        return 1;
      },
    },
  };
}

// Ohne Frist wird nicht einmal gelesen — das ist das heutige Verhalten und der Default.
test("Ohne RECORDING_TTL_DAYS passiert nichts", async () => {
  const f = fakes([{ id: "alt", ageDays: 99 }]);
  let listed = 0;
  const res = await sweepRecordings({
    ttlDays: 0,
    now: NOW,
    deps: { ...f.deps, listExpired: async (c) => { listed++; return f.deps.listExpired(c); } },
  });
  assert.deepEqual(res, { deleted: 0, cleared: 0, failed: 0 });
  assert.equal(listed, 0, "kein Zugriff auf GridFS");
});

test("Abgelaufene Aufnahmen werden gelöscht, junge bleiben", async () => {
  const f = fakes([
    { id: "alt-1", ageDays: 5 },
    { id: "alt-2", ageDays: 10 },
    { id: "jung", ageDays: 1 },
  ]);
  const res = await sweepRecordings({ ttlDays: 3, now: NOW, deps: f.deps });

  assert.deepEqual(f.deleted.sort(), ["alt-1", "alt-2"]);
  assert.equal(res.deleted, 2);
  assert.equal(res.cleared, 1, "die Referenzen am Gespräch werden geleert");
  // Der Schnitt liegt genau `ttlDays` zurück — daran hängt die Abholfrist.
  assert.equal(f.cleared[0]?.getTime(), NOW.getTime() - 3 * DAY);
});

// Eine einzelne kaputte Datei darf den Lauf nicht beenden: Der nächste Durchgang findet
// sie wieder, die übrigen sind dann schon weg.
test("Fehler bei einer Datei stoppt den Lauf nicht", async () => {
  const f = fakes([
    { id: "kaputt", ageDays: 9 },
    { id: "gut", ageDays: 9 },
  ]);
  const res = await sweepRecordings({
    ttlDays: 3,
    now: NOW,
    deps: {
      ...f.deps,
      deleteFile: async (id: unknown) => {
        if (String(id) === "kaputt") throw new Error("GridFS weg");
        f.deleted.push(String(id));
      },
    },
  });
  assert.deepEqual(f.deleted, ["gut"]);
  assert.equal(res.deleted, 1);
  assert.equal(res.failed, 1);
});
