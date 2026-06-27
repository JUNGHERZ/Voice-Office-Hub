/**
 * Registriert alle verfügbaren Tools. Beim Import einmalig ausführen (im Bootstrap).
 * Welche Tools pro Anruf aktiv sind, bestimmt der Agent (`agent.tools`).
 */
import { registerTool } from "./registry.js";
import { getWeather } from "./handlers/getWeather.js";
import { transferCall } from "./handlers/transferCall.js";
import { endCall } from "./handlers/endCall.js";

export function registerAllTools(): void {
  registerTool(transferCall);
  registerTool(endCall);
  registerTool(getWeather);
}

export * from "./registry.js";
