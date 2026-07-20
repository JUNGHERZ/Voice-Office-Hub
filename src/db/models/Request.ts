/**
 * `requests`-Collection: ein Dokument pro eingehendem Anruf (= Request/Interaktion).
 * Enthält Metadaten, eingebettetes JSON-Transkript, Aufnahme-Verweis (GridFS),
 * Tool-Aufrufe, Transfer-Status und optionale Post-Call-Summary.
 */
import { Schema, model, type InferSchemaType } from "mongoose";

/** Ein Transkript-Turn: fortlaufende Zeit in Sekunden + Sprecherseite + Text. */
const TranscriptTurnSchema = new Schema(
  {
    t: { type: Number, required: true }, // Start-Offset in Sekunden ab Gesprächsbeginn
    end: { type: Number }, // optionaler End-Offset
    // agent-Modus: "agent" | "caller"; passthrough: "caller" | "callee"
    speaker: { type: String, required: true },
    text: { type: String, required: true },
  },
  { _id: false },
);

const RecordingSchema = new Schema(
  {
    gridFsId: { type: Schema.Types.ObjectId },
    filename: { type: String },
    format: { type: String, default: "wav" },
    channels: { type: String, enum: ["mixed", "separate"], default: "mixed" },
    durationSec: { type: Number, default: 0 },
  },
  { _id: false },
);

const SummarySchema = new Schema(
  {
    text: { type: String },
    model: { type: String },
    status: { type: String, enum: ["pending", "done", "failed"] },
    createdAt: { type: Date },
  },
  { _id: false },
);

const FunctionCallSchema = new Schema(
  {
    name: { type: String, required: true },
    arguments: { type: Schema.Types.Mixed },
    result: { type: Schema.Types.Mixed },
    status: { type: String, enum: ["ok", "error"] },
    requestedAt: { type: Date },
    completedAt: { type: Date },
  },
  { _id: false },
);

const TransferSchema = new Schema(
  {
    attempted: { type: Boolean, default: false },
    target: { type: String },
    connected: { type: Boolean },
  },
  { _id: false },
);

const RequestSchema = new Schema(
  {
    channelId: { type: String, index: true },
    agentId: { type: Schema.Types.ObjectId, ref: "Agent" },
    mode: { type: String, enum: ["agent", "passthrough"], default: "agent" },
    callerNumber: { type: String, index: true },
    targetNumber: { type: String, index: true },
    forwardedTo: { type: String },
    language: { type: String },
    dgRequestId: { type: String },
    status: {
      type: String,
      enum: ["in_progress", "completed", "failed"],
      default: "in_progress",
    },
    startedAt: { type: Date, default: Date.now, index: true },
    endedAt: { type: Date },
    // Anruflänge in Sekunden (startedAt→endedAt). Immer gesetzt, unabhängig von einer
    // Aufnahme — für Abrechnung/Statistik auch bei Agents ohne Recording (DSGVO).
    durationSec: { type: Number },

    recording: { type: RecordingSchema },
    transcript: { type: [TranscriptTurnSchema], default: [] },
    transcriptionStatus: {
      type: String,
      enum: ["live", "pending", "done", "failed"],
      default: "live",
    },
    summary: { type: SummarySchema },
    functionCalls: { type: [FunctionCallSchema], default: [] },
    transfer: { type: TransferSchema },
  },
  { timestamps: true, collection: "requests" },
);

// Live-Ansicht: laufende Anrufe werden alle paar Sekunden abgefragt. Partial-Index
// hält nur in_progress-Dokumente vor (bleibt winzig, egal wie groß die Historie wird).
RequestSchema.index(
  { status: 1 },
  { partialFilterExpression: { status: "in_progress" } },
);

export type RequestDoc = InferSchemaType<typeof RequestSchema>;
export const RequestModel = model("Request", RequestSchema);
