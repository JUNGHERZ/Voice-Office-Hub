/**
 * Tool `end_call` — der Assistent beendet das Gespräch selbst und legt auf.
 * Das eigentliche Auflegen übernimmt der callHandler via ctx.requestHangup: Er wartet, bis
 * die Abschieds-Äußerung fertig gesprochen ist (AgentAudioDone + Puffer-Drain), und legt erst
 * dann auf, damit die Verabschiedung nicht abgeschnitten wird.
 */
import type { Tool } from "../registry.js";

export const endCall: Tool = {
  name: "end_call",
  description:
    "Beendet das Telefongespräch und legt auf. Verabschiede dich zuerst normal (gesprochen) und " +
    "rufe dann dieses Tool auf. Das Tool selbst sagt nichts und nimmt keine Parameter.",
  parameters: {
    type: "object",
    properties: {},
    required: [],
  },
  async handler(_args, ctx) {
    if (!ctx.requestHangup) return { ended: false, error: "Auflegen in diesem Kontext nicht verfügbar." };
    await ctx.requestHangup();
    return { ended: true };
  },
};
