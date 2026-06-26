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
  description:
    "Leitet den Anruf an eine Telefonnummer (Mensch) weiter. Nimmt niemand an, kehrt das " +
    "Gespräch automatisch zum Assistenten zurück.",
  parameters: {
    type: "object",
    properties: {
      target: {
        type: "string",
        description:
          "Zielrufnummer im E.164-Format. Wenn leer, wird die konfigurierte Standardnummer genutzt.",
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
