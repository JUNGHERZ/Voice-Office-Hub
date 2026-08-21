/**
 * Audio-Blobs in GridFS — über die native MongoDB-Anbindung der Mongoose-Connection.
 * Aufnahmen werden als WAV gestreamt (Upload nach Hangup, Download für die Admin-UI).
 */
import { createReadStream } from "node:fs";
import { pipeline } from "node:stream/promises";

import { GridFSBucket, type ObjectId } from "mongodb";

import { mongoose } from "./mongo.js";

const BUCKET = "recordings";

function bucket(): GridFSBucket {
  const db = mongoose.connection.db;
  if (!db) throw new Error("MongoDB-Connection nicht bereit (GridFS)");
  return new GridFSBucket(db, { bucketName: BUCKET });
}

/**
 * Lädt eine lokale Datei (z.B. Asterisk-Aufnahme) in GridFS und gibt die ObjectId zurück.
 */
export async function uploadRecording(
  localPath: string,
  filename: string,
  metadata?: Record<string, unknown>,
): Promise<ObjectId> {
  const upload = bucket().openUploadStream(filename, { metadata });
  await pipeline(createReadStream(localPath), upload);
  return upload.id;
}

/** Dateieinträge, die vor `cutoff` hochgeladen wurden (Aufbewahrungsgrenze, 0.10.0). */
export async function findRecordingsOlderThan(cutoff: Date): Promise<Array<{ _id: ObjectId }>> {
  return bucket()
    .find({ uploadDate: { $lt: cutoff } })
    .project({ _id: 1 })
    .toArray() as unknown as Promise<Array<{ _id: ObjectId }>>;
}

/**
 * Löscht eine Aufnahme — Dateieintrag UND Chunks. Genau deshalb übernimmt das ein Job und
 * kein TTL-Index: Ein Mongo-TTL-Index räumt nur die indizierte Collection, die Chunks
 * (also praktisch das gesamte Volumen) blieben unreferenziert liegen.
 */
export async function deleteRecording(id: ObjectId): Promise<void> {
  await bucket().delete(id);
}

/**
 * Liefert einen Lese-Stream für eine in GridFS abgelegte Aufnahme (für die Admin-UI).
 */
export function openRecordingDownload(id: ObjectId): NodeJS.ReadableStream {
  return bucket().openDownloadStream(id);
}
