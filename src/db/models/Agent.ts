/**
 * Agent-Datensatz (Multi-Agent / DDI-Routing). Bündelt das gesamte Verhalten und
 * mappt 1:1 auf die Deepgram-Settings (siehe deepgram/settings.ts).
 *
 * Hinweis (Plan): Das Routing über `agents` ist eine spätere Ausbaustufe; das Schema
 * ist aber bereits jetzt vollständig konzipiert, damit der Default-Agent (aus config)
 * und DB-Agents dieselbe Form haben.
 */
import { Schema, model, type InferSchemaType } from "mongoose";

export type CallMode = "agent" | "passthrough";
export type ThinkSource = "requesty" | "deepgram";

const ListenSchema = new Schema(
  {
    model: { type: String, default: "nova-3" },
    language_hints: { type: [String], default: ["de", "en"] },
    keyterms: { type: [String], default: [] },
    smart_format: { type: Boolean, default: true },
    eot_threshold: { type: Number },
    eot_timeout_ms: { type: Number },
  },
  { _id: false },
);

const ThinkSchema = new Schema(
  {
    source: { type: String, enum: ["requesty", "deepgram"], default: "requesty" },
    model: { type: String },
    temperature: { type: Number, default: 0.5 },
    reasoning_mode: { type: String, enum: ["low", "medium", "high"] },
    context_length: { type: Schema.Types.Mixed }, // number | "max"
  },
  { _id: false },
);

const SpeakSchema = new Schema(
  {
    provider: { type: String, default: "deepgram" },
    model: { type: String, default: "aura-2-thalia-en" },
    voice: { type: String },
    language: { type: String },
    speed: { type: Number },
    volume: { type: Number },
  },
  { _id: false },
);

const SummarySchema = new Schema(
  {
    enabled: { type: Boolean, default: false },
    prompt: { type: String, default: "" },
  },
  { _id: false },
);

const AgentSchema = new Schema(
  {
    name: { type: String, required: true },
    enabled: { type: Boolean, default: true },
    targetNumbers: { type: [String], default: [], index: true },
    mode: { type: String, enum: ["agent", "passthrough"], default: "agent" },
    passthroughTarget: { type: String },

    greeting: { type: String },
    prompt: { type: String },

    listen: { type: ListenSchema, default: () => ({}) },
    think: { type: ThinkSchema, default: () => ({}) },
    speak: { type: SpeakSchema, default: () => ({}) },

    tools: { type: [String], default: [] },
    summary: { type: SummarySchema, default: () => ({}) },
    tags: { type: [String], default: [] },
    mip_opt_out: { type: Boolean, default: false },
  },
  { timestamps: true, collection: "agents" },
);

export type AgentDoc = InferSchemaType<typeof AgentSchema>;
export const Agent = model("Agent", AgentSchema);
