/**
 * `agentTranslations`-Collection: vorübersetzte Ansagen eines Agenten, ein Dokument je Zielsprache.
 *
 * BEWUSST NICHT im Agent-Dokument: `PATCH /api/agents/:id` ersetzt Subdokumente vollständig
 * (deshalb muss dort schon der Widget-Key serverseitig bewahrt werden). Übersetzungen wären
 * derselben Falle ausgesetzt — und sie wachsen mit jeder Sprache, während das Agent-Dokument
 * schlank bleiben soll.
 *
 * Jeder Eintrag trägt den Hash seines QUELLTEXTES. Passt der nicht mehr zum aktuellen Original,
 * gilt die Übersetzung als veraltet und wird nicht ausgespielt — ohne dass irgendein Änderungspfad
 * daran denken müsste, etwas zu löschen. Details in llm/translationStore.ts.
 */
import { Schema, model, type InferSchemaType } from "mongoose";

const EntrySchema = new Schema(
  {
    /**
     * Katalog-Key (`greeting`, `filler.0`, `idle.1`, `tool.<name>` …).
     *
     * BEWUSST ein Array-Feld statt einer Map: Mongoose-Maps verbieten Punkte in Keys (Punkte
     * sind in MongoDB Pfad-Separatoren) — genau die haben unsere Pool-Keys aber. Eine Map
     * bricht deshalb beim ersten `filler.0`, und zwar erst im Update-Cast zur Laufzeit, nicht
     * schon beim Anlegen des Dokuments. Als Array existiert die Einschränkung nicht.
     */
    key: { type: String, required: true },
    /** Übersetzter Satz in der Zielsprache. */
    text: { type: String, required: true },
    /** Hash des Quelltextes zum Zeitpunkt der Übersetzung (sha256, 16 Hex-Zeichen). */
    srcHash: { type: String, required: true },
  },
  { _id: false },
);

const AgentTranslationSchema = new Schema(
  {
    agentId: { type: Schema.Types.ObjectId, ref: "Agent", required: true },
    /** Zielsprache als Kleinbuchstaben-Code ("en", "fr", …). */
    lang: { type: String, required: true },
    /** Übersetzte Ansagen. Keys entsprechen `buildLocalizationCatalog` (greeting, filler.0, …). */
    entries: { type: [EntrySchema], default: [] },
    /** Womit übersetzt wurde — für die Nachvollziehbarkeit im Admin. */
    model: { type: String },
  },
  { timestamps: true, collection: "agentTranslations" },
);

// Ein Dokument je Agent und Sprache; zugleich der Lookup-Index für den Anrufaufbau.
AgentTranslationSchema.index({ agentId: 1, lang: 1 }, { unique: true });

export type AgentTranslationDoc = InferSchemaType<typeof AgentTranslationSchema>;
export const AgentTranslation = model("AgentTranslation", AgentTranslationSchema);
