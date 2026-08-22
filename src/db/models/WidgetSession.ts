/**
 * `widgetSessions`-Collection: eine ausgestellte, noch nicht eingelöste Widget-Sitzung (0.11.0).
 *
 * Warum überhaupt eine Collection und kein Speicher im Prozess: Ausgestellt wird im
 * Admin-Prozess (`dist/admin/index.js`), eingelöst im Engine-Prozess (`dist/index.js`) —
 * beide teilen sich nur die Datenbank.
 *
 * Warum es sie gibt: Das SIP-Passwort des Widgets ist ein Deployment-Secret. Ohne diesen
 * Nachweis wäre `POST /api/widget/session` einmalig nötig und danach nie wieder — Origin-
 * Prüfung, Rate-Limits und der Deckel für gleichzeitige Anrufe liefen ins Leere, und mit
 * denselben Zugangsdaten wäre jede dreistellige Durchwahl im `[webrtc-inbound]`-Kontext
 * wählbar, also auch der Agent eines anderen Mandanten (dessen Gespräch dann bezahlt wird).
 *
 * Der Eintrag lebt nur zwischen Ausstellung und INVITE. Das Live-Transkript hängt NICHT an
 * ihm, sondern an `requests.widgetToken` — es funktioniert deshalb weiter, wenn diese Sitzung
 * längst verbraucht und abgeräumt ist.
 */
import { Schema, model, type InferSchemaType } from "mongoose";

const WidgetSessionSchema = new Schema(
  {
    /** Der Wert, den der Client als SIP-Header `X-Widget-Token` in das INVITE setzt. */
    token: { type: String, required: true, unique: true },
    /** Für diesen Agenten wurde ausgestellt — nur seine Durchwahl darf gewählt werden. */
    agentId: { type: Schema.Types.ObjectId, ref: "Agent", required: true },
    /** Die Durchwahl des Agenten zum Zeitpunkt der Ausstellung (für die Log-Spur). */
    exten: { type: String },
    /** Wann das INVITE kam. Gesetzt = verbraucht; ein zweites INVITE wird abgewiesen. */
    consumedAt: { type: Date },
    expiresAt: { type: Date, required: true },
  },
  { timestamps: true, collection: "widgetSessions" },
);

// Räumt verbrauchte wie ungenutzte Sitzungen ab. Der TTL-Monitor läuft nur minütlich, die
// Gültigkeit wird deshalb zusätzlich im Code geprüft — ein noch vorhandenes Dokument heißt
// nicht, dass die Sitzung noch gilt.
WidgetSessionSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export type WidgetSessionDoc = InferSchemaType<typeof WidgetSessionSchema>;
export const WidgetSession = model("WidgetSession", WidgetSessionSchema);
