/**
 * `callerProfiles`-Collection: was über eine anrufende Nummer über Anrufe hinweg bekannt ist.
 * In 0.7.0 ausschließlich die Gesprächssprache — sie ist der einzige Fakt, den man einem
 * Anrufer gefahrlos ungefragt anmerken darf (eine Begrüßung in der falschen Sprache ist ein
 * Schönheitsfehler, ein "Guten Tag Herr Müller" gegenüber der falschen Person eine Datenpanne).
 *
 * Datenschutz:
 *  - `callerKey` ist ein HMAC der normalisierten Nummer, kein Klartext. Der Lookup funktioniert
 *    unverändert, die Collection ist bei einem Leak wertlos.
 *  - TTL-Index auf `updatedAt`: Profile verfallen von selbst und regenerieren sich im Betrieb.
 *  - Opt-in pro Agent (`agent.callerMemory.language`), Default aus.
 */
import { Schema, model, type InferSchemaType } from "mongoose";

import { config } from "../../config.js";

const FactsSchema = new Schema(
  {
    /** Zuletzt bestätigte Gesprächssprache (Kleinbuchstaben-Code). */
    language: { type: String },
  },
  { _id: false },
);

const CallerProfileSchema = new Schema(
  {
    agentId: { type: Schema.Types.ObjectId, ref: "Agent", required: true },
    /** HMAC-SHA256 der normalisierten Rufnummer — nie die Nummer selbst. */
    callerKey: { type: String, required: true },
    facts: { type: FactsSchema, default: () => ({}) },
    /** Woher der Sprachwert stammt. Nur "llm" darf eine Begrüßung steuern. */
    source: { type: String, enum: ["llm", "scorer"], default: "llm" },
    /** Wie oft der Wert seither bestätigt wurde (Bestätigung zählt weniger als Widerspruch). */
    confirmations: { type: Number, default: 1 },
  },
  { timestamps: true, collection: "callerProfiles" },
);

CallerProfileSchema.index({ agentId: 1, callerKey: 1 }, { unique: true });
// Verfallsdatum: nach der konfigurierten Frist ohne Kontakt verschwindet das Profil von selbst.
CallerProfileSchema.index(
  { updatedAt: 1 },
  { expireAfterSeconds: config.callerProfile.ttlDays * 24 * 60 * 60 },
);

export type CallerProfileDoc = InferSchemaType<typeof CallerProfileSchema>;
export const CallerProfile = model("CallerProfile", CallerProfileSchema);
