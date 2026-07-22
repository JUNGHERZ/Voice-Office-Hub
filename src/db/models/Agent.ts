/**
 * Agent-Datensatz (Multi-Agent / DDI-Routing). Bündelt das gesamte Verhalten und
 * mappt 1:1 auf die Deepgram-Settings (siehe deepgram/settings.ts).
 *
 * Hinweis (Plan): Das Routing über `agents` ist eine spätere Ausbaustufe; das Schema
 * ist aber bereits jetzt vollständig konzipiert, damit der Default-Agent (aus config)
 * und DB-Agents dieselbe Form haben.
 */
import { Schema, model, type InferSchemaType } from "mongoose";

import { AMBIENCE_PRESET_IDS } from "../../audio/ambiencePresets.js";
import { BUILTIN_TOOL_NAMES } from "../../tools/names.js";
import { IMPLEMENTED_VOICE_PROVIDERS } from "../../voice/types.js";

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
    // "eleven_labs" nutzt die Dritt-TTS-Durchreiche der Voice-Agent-API; der API-Key
    // kommt aus dem Server-Env (ELEVENLABS_API_KEY), die Voice-ID steht in `voice`.
    provider: { type: String, enum: ["deepgram", "eleven_labs"], default: "deepgram" },
    model: { type: String, default: "aura-2-thalia-en" },
    voice: { type: String },
    language: { type: String },
    speed: { type: Number },
    volume: { type: Number },
    // ElevenLabs-Feinschliff (voice_settings der nativen Kaskade; im Deepgram-Modus
    // gelten stattdessen die Voice-Defaults aus dem ElevenLabs-Dashboard).
    stability: { type: Number, min: [0, "speak.stability: 0–1"], max: [1, "speak.stability: 0–1"] },
    similarityBoost: {
      type: Number,
      min: [0, "speak.similarityBoost: 0–1"],
      max: [1, "speak.similarityBoost: 0–1"],
    },
  },
  { _id: false },
);

const CustomToolEndpointSchema = new Schema(
  {
    url: {
      type: String,
      required: true,
      validate: {
        validator: (v: string) => /^https?:\/\//i.test(v),
        message: "endpoint.url muss mit http:// oder https:// beginnen",
      },
    },
    method: { type: String, enum: ["GET", "POST"], default: "POST" },
    // Header-Werte dürfen `${ENV:NAME}`-Platzhalter enthalten (Auflösung zur Laufzeit,
    // Secrets bleiben außerhalb der DB — siehe util/http.ts).
    headers: { type: Map, of: String, default: () => ({}) },
    timeoutMs: { type: Number, default: 8000, min: 500, max: 30000 },
  },
  { _id: false },
);

const CustomToolSchema = new Schema(
  {
    name: {
      type: String,
      required: true,
      match: [/^[a-z][a-z0-9_]{0,63}$/, "Tool-Name: kleinbuchstaben_mit_unterstrichen, max. 64 Zeichen"],
      validate: {
        validator: (v: string) => !(BUILTIN_TOOL_NAMES as readonly string[]).includes(v),
        message: "Tool-Name kollidiert mit einem eingebauten Tool",
      },
    },
    description: { type: String, required: true },
    // JSON-Schema der Argumente (wird 1:1 als function.parameters an den Voice-Provider gereicht).
    parameters: { type: Schema.Types.Mixed, default: () => ({ type: "object", properties: {} }) },
    endpoint: { type: CustomToolEndpointSchema, required: true },
    enabled: { type: Boolean, default: true },
  },
  { _id: false },
);

const McpServerSchema = new Schema(
  {
    // Präfix der Tool-Namen (`<name>_<tool>`) — gleiche Zeichenklasse wie Tool-Namen.
    name: {
      type: String,
      required: true,
      match: [/^[a-z][a-z0-9_]{0,31}$/, "MCP-Server-Name: kleinbuchstaben_mit_unterstrichen, max. 32 Zeichen"],
    },
    url: {
      type: String,
      required: true,
      validate: {
        validator: (v: string) => /^https?:\/\//i.test(v),
        message: "url muss mit http:// oder https:// beginnen",
      },
    },
    // Statische Auth-Header; Werte dürfen `${ENV:NAME}`-Platzhalter enthalten.
    headers: { type: Map, of: String, default: () => ({}) },
    enabled: { type: Boolean, default: true },
    // Leer = alle Tools; sonst Whitelist der (unpräfixierten) Tool-Namen.
    toolFilter: { type: [String], default: [] },
    timeoutMs: { type: Number, default: 8000, min: 500, max: 30000 },
  },
  { _id: false },
);

const SummarySchema = new Schema(
  {
    enabled: { type: Boolean, default: false },
    prompt: { type: String, default: "" },
    // Optionales eigenes Summary-Modell (Requesty), unabhängig vom Konversations-Modell.
    model: { type: String },
  },
  { _id: false },
);

/** Hintergrundatmosphäre im Anruf (leise Dauerschleife unter/zwischen der Agent-Sprache). */
const AmbienceSchema = new Schema(
  {
    enabled: { type: Boolean, default: false },
    preset: { type: String, enum: AMBIENCE_PRESET_IDS, default: "office" },
    // Linearer Pegel 0..1 (0.25 = dezent hörbar).
    volume: { type: Number, default: 0.25, min: 0, max: 1 },
  },
  { _id: false },
);

/**
 * Web-Widget (einbettbares Browser-Softphone, 0.6.9). `key` wird server-seitig
 * generiert (agents-Route) und nie vom Client übernommen; `exten` ist die 3-stellige
 * Pseudo-Durchwahl, die der Browser wählt — sie muss zusätzlich in `targetNumbers`
 * stehen, damit das normale DDI-Routing greift. `allowedOrigins` steuert per
 * CSP frame-ancestors, welche Websites das Widget einbetten dürfen.
 */
const WidgetSchema = new Schema(
  {
    enabled: { type: Boolean, default: false },
    key: { type: String },
    exten: {
      type: String,
      match: [/^\d{3}$/, "widget.exten: dreistellige Durchwahl (z. B. 120)"],
    },
    allowedOrigins: {
      type: [String],
      default: [],
      validate: {
        validator: (origins: string[]) =>
          origins.every((o) => /^https?:\/\/[^/\s]+$/i.test(o)),
        message: "widget.allowedOrigins: Origins ohne Pfad, z. B. https://kunde.de",
      },
    },
    // Live-Transkript im Widget anzeigen (öffentlicher, token-gebundener Endpoint).
    showTranscript: { type: Boolean, default: true },
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

    // Welche Voice-Plattform den Anruf bedient (Auswahl in voice/factory.ts). Enum enthält
    // bewusst nur implementierte Provider — Nichtlauffähiges wird schon beim Speichern abgewiesen.
    voiceProvider: { type: String, enum: [...IMPLEMENTED_VOICE_PROVIDERS], default: "deepgram" },

    // Bei externem Transfer/Outbound über den Trunk die ORIGINAL-Anrufernummer als Absender
    // präsentieren (transparente Weiterleitung). Wirkt nur, wenn der Trunk CLIP no screening
    // erlaubt (ENV TRUNK_CLIP_NO_SCREENING). Aus = eigene Agent-Nummer (targetNumber).
    useTransferCallerId: { type: Boolean, default: false },

    // STT-Sprache → agent.listen.provider.language ("multi", "de", "en" …). Fällt im Resolver
    // auf den Config-Default zurück, wenn leer.
    language: { type: String },
    greeting: { type: String },
    prompt: { type: String },

    listen: { type: ListenSchema, default: () => ({}) },
    think: { type: ThinkSchema, default: () => ({}) },
    speak: { type: SpeakSchema, default: () => ({}) },

    tools: { type: [String], default: [] },
    // Am Agent hinterlegte HTTP-Tools (Engine dispatcht selbst; siehe tools/toolset.ts).
    customTools: {
      type: [CustomToolSchema],
      default: [],
      validate: {
        validator: (tools: Array<{ name?: string }>) =>
          new Set(tools.map((t) => t.name)).size === tools.length,
        message: "customTools: Tool-Namen müssen eindeutig sein",
      },
    },
    // MCP-Server als externe Tool-Quellen (Tools erscheinen präfixiert als <server>_<tool>).
    mcpServers: {
      type: [McpServerSchema],
      default: [],
      validate: {
        validator: (servers: Array<{ name?: string }>) =>
          new Set(servers.map((s) => s.name)).size === servers.length,
        message: "mcpServers: Namen müssen eindeutig sein",
      },
    },
    summary: { type: SummarySchema, default: () => ({}) },
    ambience: { type: AmbienceSchema, default: () => ({}) },
    widget: { type: WidgetSchema, default: () => ({}) },
    tags: { type: [String], default: [] },
    mip_opt_out: { type: Boolean, default: false },
  },
  { timestamps: true, collection: "agents" },
);

// Widget nur aktivierbar, wenn die Pseudo-Durchwahl gesetzt ist UND als DDI geroutet wird.
// Läuft in ZWEI Kontexten: als Dokument-Validator (create/save → `this` = Dokument) und als
// Update-Validator (findByIdAndUpdate + runValidators + context:"query" → `this` = Query;
// targetNumbers dann aus dem Update lesen — die UI PATCHt immer den vollen Body).
AgentSchema.path("widget").validate(function (this: unknown, w: {
  enabled?: boolean;
  exten?: string;
}) {
  if (!w?.enabled) return true;
  if (!w.exten) return false;
  const ctx = this as {
    targetNumbers?: string[];
    getUpdate?: () => Record<string, unknown> | null;
  };
  let numbers = ctx?.targetNumbers;
  if (!numbers && typeof ctx?.getUpdate === "function") {
    const update = ctx.getUpdate() ?? {};
    const set = (update as { $set?: Record<string, unknown> }).$set ?? {};
    numbers = ((update as Record<string, unknown>).targetNumbers ?? set.targetNumbers) as
      | string[]
      | undefined;
  }
  // Partielles API-Update ohne targetNumbers: nicht blockieren (exten-Pflicht ist geprüft;
  // Routing-Konsistenz stellt der Voll-PATCH der UI bzw. das nächste Speichern sicher).
  if (!Array.isArray(numbers)) return true;
  return numbers.includes(w.exten);
}, "Widget: exten muss gesetzt sein und in targetNumbers stehen");

export type AgentDoc = InferSchemaType<typeof AgentSchema>;
export const Agent = model("Agent", AgentSchema);
