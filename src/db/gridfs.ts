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

/**
 * Liefert einen Lese-Stream für eine in GridFS abgelegte Aufnahme (für die Admin-UI).
 */
export function openRecordingDownload(id: ObjectId): NodeJS.ReadableStream {
  return bucket().openDownloadStream(id);
}
