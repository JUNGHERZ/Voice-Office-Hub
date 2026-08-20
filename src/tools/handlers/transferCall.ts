/**
 * Tool `transfer_call` — Weiterleitung mit Auto-Rückkehr (Vorstufe Warm Transfer).
 * Die eigentliche ARI-Mechanik (Dial, Timeout, Rückkehr zur Agent-Bridge) liefert der
 * callHandler via ctx.requestTransfer. Schlägt die Weiterleitung fehl, kehrt der Agent
 * mit erhaltenem Kontext zurück und das Ergebnis meldet connected:false.
 */
import { config } from "../../config.js";
import type { Tool } from "../registry.js";

export const transferCall: Tool = {
  name: "transfer_call",
  // Die Beschreibung sagt bewusst WANN, nicht nur WAS: eine rein beschreibende
  // Fassung ("verbindet den Anrufer…") überlässt dem Modell die Auslösung, und das
  // führt zu Weiterleitungen mitten in einer laufenden Hilfestellung (live beobachtet
  // 2026-08-20: der Agent schlug bei einem Malware-Verdacht einen Spezialisten vor
  // und leitete im selben Zug weiter, ohne die Antwort des Anrufers abzuwarten).
  description:
    "Verbindet den Anrufer mit einem Menschen/einer Durchwahl. " +
    "AUFRUFEN, wenn der Anrufer selbst nach einem Menschen verlangt, verärgert ist, oder " +
    "du bei seinem Anliegen nachweislich nicht weiterhelfen kannst. " +
    "NICHT AUFRUFEN, solange du den Anrufer noch durch Schritte führst oder das Problem " +
    "gerade eingrenzt — ein schwieriger Befund ist für sich noch kein Grund weiterzuleiten. " +
    "Schlägst DU die Weiterleitung vor, ist das ein Vorschlag: sprich ihn aus und warte die " +
    "Antwort des Anrufers ab, bevor du dieses Tool aufrufst. Hat der Anrufer selbst darum " +
    "gebeten, verbinde direkt. " +
    "Gib in 'target' die Ziel-Durchwahl an (nur eine im System bekannte Durchwahl verwenden, " +
    "keine erfundene Nummer). Nimmt niemand an, kehrt das Gespräch automatisch zum " +
    "Assistenten zurück.",
  parameters: {
    type: "object",
    properties: {
      target: {
        type: "string",
        description:
          "Ziel-Durchwahl/Nummer. Nur bekannte Durchwahlen verwenden (siehe Anweisungen im Prompt). " +
          "Wenn leer, wird die konfigurierte Standard-Durchwahl genutzt.",
      },
    },
    required: [],
  },
  async handler(args, ctx) {
    const target = String(args.target ?? "").trim() || config.transfer.passthroughTarget;
    if (!target) return { connected: false, error: "Keine Zielrufnummer konfiguriert." };
    if (!ctx.requestTransfer) return { connected: false, error: "Transfer in diesem Kontext nicht verfügbar." };

    const { connected } = await ctx.requestTransfer(target);
    return connected
      ? { connected: true, target }
      : { connected: false, target, message: "Niemand erreichbar — zurück beim Assistenten." };
  },
};
