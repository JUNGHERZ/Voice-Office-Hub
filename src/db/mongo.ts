/**
 * Mongoose-Connection + Index-Sync. Eine einzige Connection für den ganzen Prozess.
 */
import mongoose from "mongoose";

import { config } from "../config.js";
import { logger } from "../util/logger.js";

const log = logger.child({ mod: "db" });

export async function connectMongo(): Promise<typeof mongoose> {
  mongoose.set("strictQuery", true);

  mongoose.connection.on("connected", () => log.info("MongoDB verbunden"));
  mongoose.connection.on("error", (err) => log.error("MongoDB-Fehler", { err: String(err) }));
  mongoose.connection.on("disconnected", () => log.warn("MongoDB getrennt"));

  await mongoose.connect(config.mongo.uri, {
    serverSelectionTimeoutMS: 10_000,
  });

  // Indizes aus den Schemas anlegen (idempotent).
  await mongoose.syncIndexes().catch((err) => log.warn("syncIndexes fehlgeschlagen", { err: String(err) }));

  return mongoose;
}

export async function disconnectMongo(): Promise<void> {
  await mongoose.disconnect();
}

export { mongoose };
