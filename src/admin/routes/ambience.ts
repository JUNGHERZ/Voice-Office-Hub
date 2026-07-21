/**
 * Management-API: verfügbare Ambience-Presets (read-only) — Datenquelle für das
 * Preset-Select im Agent-Formular.
 */
import type { FastifyInstance } from "fastify";

import { listAmbiencePresets } from "../../audio/ambiencePresets.js";
import { requireAuth } from "../auth.js";

export async function ambienceRoutes(app: FastifyInstance): Promise<void> {
  app.addHook("preHandler", requireAuth);

  app.get(
    "/",
    {
      schema: {
        tags: ["ambience"],
        summary: "Ambience-Presets auflisten",
        response: {
          200: {
            type: "object",
            properties: {
              presets: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    id: { type: "string" },
                    label: { type: "string" },
                  },
                },
              },
            },
          },
        },
      },
    },
    async () => ({ presets: listAmbiencePresets() }),
  );
}
