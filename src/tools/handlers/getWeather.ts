/**
 * Tool `get_weather` — Demo eines externen API-Calls (client_side).
 * Hier als Stub mit Pseudodaten; echter API-Aufruf später einsetzbar.
 */
import type { Tool } from "../registry.js";

export const getWeather: Tool = {
  name: "get_weather",
  description: "Liefert das aktuelle Wetter für einen Ort (Demo).",
  parameters: {
    type: "object",
    properties: {
      location: { type: "string", description: "Ort, z.B. 'Berlin'" },
    },
    required: ["location"],
  },
  async handler(args) {
    const location = String(args.location ?? "").trim() || "unbekannt";
    // Platzhalter — hier würde ein echter Wetter-API-Aufruf stehen.
    return { location, temperature_c: 18, condition: "wolkig", note: "Demo-Daten" };
  },
};
