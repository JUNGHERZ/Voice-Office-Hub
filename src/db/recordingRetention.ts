/**
 * Aufbewahrungsgrenze für Aufnahmen (0.10.0).
 *
 * Wer Aufnahmen in eine eigene Ablage zieht und dort nach wenigen Tagen löscht, hat sie
 * ohne Gegenstück zweimal — und die Kopie in der Appliance unbefristet. `RECORDING_TTL_DAYS`
 * schließt die Lücke.
 *
 * **Kein TTL-Index.** Ein Mongo-TTL-Index löscht ausschließlich Dokumente der indizierten
 * Collection; auf `recordings.files` angewandt bliebe für jede Aufnahme der Eintrag in
 * `recordings.chunks` liegen — also praktisch das gesamte Datenvolumen, dauerhaft und ohne
 * Referenz. `bucket().delete()` räumt beides.
 *
 * Der Schnitt läuft über das Upload-Datum der Datei und nicht über einen Join mit den
 * Gesprächen. Das räumt zugleich Waisen ab (Absturz zwischen Upload und `setRecording`) und
 * kann nichts Junges treffen: Eine Aufnahme entsteht erst am Ende ihres Gesprächs.
 *
 * Das `requests`-Dokument bleibt vollständig — nur der `recording`-Block verschwindet, womit
 * `GET /api/requests/:id/recording` ohne weiteres Zutun 404 liefert.
 */
import type { ObjectId } from "mongodb";

import { config } from "../config.js";
import { deleteRecording, findRecordingsOlderThan } from "./gridfs.js";
import { RequestModel } from "./models/Request.js";
import { logger } from "../util/logger.js";

const log = logger.child({ mod: "retention" });

/** Naht für Tests — in Produktion GridFS und die `requests`-Collection. */
export interface RetentionDeps {
  listExpired: (cutoff: Date) => Promise<Array<{ _id: ObjectId }>>;
  deleteFile: (id: ObjectId) => Promise<void>;
  clearReferences: (cutoff: Date) => Promise<number>;
}

const defaultDeps: RetentionDeps = {
  listExpired: findRecordingsOlderThan,
  deleteFile: deleteRecording,
  clearReferences: async (cutoff) => {
    const res = await RequestModel.updateMany(
      { startedAt: { $lt: cutoff }, "recording.gridFsId": { $exists: true } },
      { $unset: { recording: "" } },
    );
    return res.modifiedCount ?? 0;
  },
};

export interface SweepResult {
  deleted: number;
  cleared: number;
  failed: number;
}

/**
 * Einmal aufräumen. Ohne gesetzte Frist ein No-op — es wird dann nicht einmal gelesen.
 * Fehler einzelner Dateien beenden den Lauf nicht: Der nächste Durchgang findet sie wieder.
 */
export async function sweepRecordings(opts: {
  ttlDays?: number;
  now?: Date;
  deps?: Partial<RetentionDeps>;
} = {}): Promise<SweepResult> {
  const ttlDays = opts.ttlDays ?? config.recordingTtlDays;
  const result: SweepResult = { deleted: 0, cleared: 0, failed: 0 };
  if (!ttlDays || ttlDays <= 0) return result;

  const deps = { ...defaultDeps, ...opts.deps };
  const cutoff = new Date((opts.now ?? new Date()).getTime() - ttlDays * 24 * 60 * 60 * 1000);

  const expired = await deps.listExpired(cutoff);
  for (const file of expired) {
    try {
      await deps.deleteFile(file._id);
      result.deleted += 1;
    } catch (err) {
      result.failed += 1;
      log.warn("Aufnahme konnte nicht gelöscht werden", { id: String(file._id), err: String(err) });
    }
  }
  result.cleared = await deps.clearReferences(cutoff);

  if (result.deleted || result.cleared || result.failed) {
    log.info("Aufnahmen verfallen", { ...result, ttlDays });
  }
  return result;
}

/** Stündlicher Lauf plus ein Durchgang beim Start. Ohne Frist wird kein Timer gestellt. */
export function startRecordingRetention(): void {
  if (!config.recordingTtlDays || config.recordingTtlDays <= 0) return;
  log.info("Aufbewahrungsgrenze für Aufnahmen aktiv", { ttlDays: config.recordingTtlDays });
  void sweepRecordings().catch((err) => log.warn("Aufräumlauf fehlgeschlagen", { err: String(err) }));
  const timer = setInterval(
    () => void sweepRecordings().catch((err) => log.warn("Aufräumlauf fehlgeschlagen", { err: String(err) })),
    60 * 60 * 1000,
  );
  timer.unref?.();
}
