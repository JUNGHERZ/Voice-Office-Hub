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

/** Beim Finalisieren geschriebene Per-Call-Metriken (Latenz/Interaktion, siehe callHandler). */
const MetricsSchema = new Schema(
  {
    // Answer → erstes TTS-Audio des Agenten (i. d. R. die Begrüßung), in Millisekunden.
    // Ab 0.10.0 wirklich ab dem Answer gemessen: Die Erzeugung der Begrüßung liegt davor
    // (Rufton) und soll diesen Wert nicht aufblähen.
    timeToFirstAudioMs: { type: Number },
    // Turn-Latenzen (0.8.0): Median über alle Agenten-Turns des Anrufs, in Millisekunden.
    // Der Provider-Vergleich (ElevenLabs ↔ Voxtral ↔ Aura) soll aus Produktionsdaten
    // fallen, nicht aus Herstellerangaben — bis 0.7.x landeten diese Werte nur im Log.
    turnLatencyMs: { type: Number },
    // Anteil davon bis zum ersten LLM-Token (time-to-think) bzw. ab erstem Satz (TTS).
    turnThinkMs: { type: Number },
    turnTtsMs: { type: Number },
    turns: { type: Number },
    bargeIns: { type: Number, default: 0 },
    toolCalls: { type: Number, default: 0 },
    toolErrors: { type: Number, default: 0 },
    voiceProvider: { type: String },
    sttModel: { type: String },
    // TTS-Verbrauch (nur native, zeichengenau wie an den Anbieter gesendet).
    ttsProvider: { type: String },
    ttsModel: { type: String },
    ttsCharacters: { type: Number },
    ttsCredits: { type: Number },
    // LLM-/STT-Mengen (0.10.0) — Grundlage der Einkaufsrechnung auf dem native-Pfad.
    // Beim gebündelten Voice-Agent bleiben sie leer: dort denkt der Anbieter selbst.
    llmModel: { type: String },
    llmPromptTokens: { type: Number },
    llmCachedPromptTokens: { type: Number },
    llmCompletionTokens: { type: Number },
    llmRequests: { type: Number },
    sttSeconds: { type: Number },
    // Stille-Reengagement (0.6.27): Nachfass-Ansagen und ob der Anruf daran endete.
    idlePrompts: { type: Number },
    idleHangup: { type: Boolean },
    // Begrüßung in der Anrufersprache (0.7.0): womit begrüßt wurde, woher die Sprache kam
    // und ob der Anrufer sie bestätigt hat. Ohne diese drei ist nicht beurteilbar, ob der
    // Prior trägt — genau die Frage, die den ganzen Mechanismus rechtfertigen muss.
    greetingLanguage: { type: String },
    priorSource: { type: String },
    priorConfirmed: { type: Boolean },
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
    // Web-Widget: pro Anruf generiertes Zufalls-Token — Schlüssel für das öffentliche,
    // token-gebundene Live-Transkript (GET /api/widget/call/:token). Sparse: Telefonie hat keins.
    widgetToken: { type: String, index: { sparse: true } },
    // Konfigurations-Overlay pro Anruf (0.9.0): opake Kennung des externen Dienstes, die
    // dieser beim Auflösen mitgegeben hat — geht unverändert in alle Ereignisse zurück.
    // Sparse: ohne konfigurierten Hook trägt kein Dokument das Feld.
    agentRef: { type: String, index: { sparse: true } },
    // Kennung des anlegenden Systems, zum Zeitpunkt des Anrufs vom Agenten übernommen
    // (0.10.0). Denormalisiert: Ein Ereignis soll zeigen, was DAMALS galt, und der
    // Ereignis-Dekorator soll dafür keinen Agenten nachlesen müssen.
    externalRef: { type: String, index: { sparse: true } },
    // "ok" = Overlay wurde angewendet, "unavailable" = der Hook war nicht erreichbar und
    // der gespeicherte Agent galt (Fail-open). Fehlt, wenn kein Hook konfiguriert ist.
    resolverStatus: { type: String, enum: ["ok", "unavailable"] },
    // Der TATSÄCHLICH gesprochene Eröffnungssatz (0.10.0). Bewusst am Gespräch und nicht
    // nur am Agenten: Beide werden zu verschiedenen Zeitpunkten gelesen, und ein seither
    // geändertes `greeting` würde sonst rückwirkend eine Antwort belegen, die nie fiel.
    greetingText: { type: String },
    // Warum das Gespräch endete (0.10.0) — bewusst OHNE enum: ein künftig ergänzter Grund
    // darf weder ein Bestandsdokument noch einen älteren Empfänger in einen Fehler laufen
    // lassen. Bekannte Werte: caller | agent | transfer | idle | announce | maxDuration |
    // abandoned | failed.
    endedReason: { type: String },
    forwardedTo: { type: String },
    language: { type: String },
    dgRequestId: { type: String },
    // `abandoned`: Der Anrufer hat aufgelegt, bevor das Gespräch zustande kam (0.10.1) —
    // kein Fehler und kein geführtes Gespräch. Siehe CallEndStatus in repository.ts.
    status: {
      type: String,
      enum: ["in_progress", "completed", "failed", "abandoned"],
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
    metrics: { type: MetricsSchema },
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
