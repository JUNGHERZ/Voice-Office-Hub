/**
 * Management-API: verfügbare eingebaute Tools (read-only) — Datenquelle für die
 * Tool-Auswahl im Agent-Formular. Eigene HTTP-Tools stehen direkt am Agent
 * (`customTools`, siehe docs/tools.md) und brauchen keine eigene Ressource.
 */
import type { FastifyInstance } from "fastify";

import { listTools, registerAllTools } from "../../tools/index.js";
import { requireAuth } from "../auth.js";

export async function toolRoutes(app: FastifyInstance): Promise<void> {
  app.addHook("preHandler", requireAuth);

  // Registry im Admin-Prozess befüllen (idempotent; tools/ hat keine ARI-Abhängigkeiten).
  registerAllTools();

  app.get(
    "/",
    { schema: { tags: ["tools"], summary: "Eingebaute Tools auflisten" } },
    async () => ({
      builtin: listTools().map((t) => ({ name: t.name, description: t.description })),
    }),
  );
}
