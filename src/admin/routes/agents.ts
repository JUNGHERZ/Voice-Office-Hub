/**
 * Management-API: Agents-CRUD über die `agents`-Collection (Mongoose-Modell wiederverwendet).
 * Geschützt per requireAuth (Session-Cookie ODER API-Key).
 */
import { randomBytes } from "node:crypto";

import type { FastifyInstance } from "fastify";

import { Agent } from "../../db/models/Agent.js";
import { requireAuth } from "../auth.js";

/** Widget-Key ist SERVER-verwaltet: Client-Werte werden nie übernommen. */
function newWidgetKey(): string {
  return randomBytes(16).toString("hex");
}

const idParam = {
  type: "object",
  properties: { id: { type: "string", description: "Agent-ObjectId" } },
  required: ["id"],
} as const;

// Agent-Body bewusst offen (das Schema ist reich/verschachtelt; Validierung macht Mongoose).
const agentBody = { type: "object", additionalProperties: true } as const;

export async function agentRoutes(app: FastifyInstance): Promise<void> {
  app.addHook("preHandler", requireAuth);

  // Liste
  app.get("/", { schema: { tags: ["agents"], summary: "Agents auflisten" } }, async () => {
    const agents = await Agent.find().sort({ name: 1 }).lean();
    return { agents };
  });

  // Detail
  app.get("/:id", { schema: { tags: ["agents"], summary: "Agent (Detail)", params: idParam } }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const agent = await Agent.findById(id).lean();
    if (!agent) return reply.code(404).send({ error: "not found" });
    return { agent };
  });

  // Anlegen
  app.post("/", { schema: { tags: ["agents"], summary: "Agent anlegen", body: agentBody } }, async (req, reply) => {
    const body = { ...(req.body as Record<string, unknown>) };
    const widget = body.widget as Record<string, unknown> | undefined;
    if (widget && typeof widget === "object") widget.key = newWidgetKey();
    const agent = await Agent.create(body);
    return reply.code(201).send({ agent: agent.toObject() });
  });

  // Ändern (Teil-Update)
  app.patch(
    "/:id",
    { schema: { tags: ["agents"], summary: "Agent ändern", params: idParam, body: agentBody } },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      const body = { ...(req.body as Record<string, unknown>) };
      const widget = body.widget as Record<string, unknown> | undefined;
      if (widget && typeof widget === "object") {
        // PATCH ersetzt Subdokumente komplett — den bestehenden Key bewahren
        // (bzw. beim ersten Aktivieren erzeugen); Client-Werte zählen nie.
        const current = await Agent.findById(id, { "widget.key": 1 }).lean<{
          widget?: { key?: string };
        }>();
        if (!current) return reply.code(404).send({ error: "not found" });
        widget.key = current.widget?.key || newWidgetKey();
      }
      const agent = await Agent.findByIdAndUpdate(id, body, {
        new: true,
        runValidators: true,
        // Update-Validatoren mit Query-Kontext (Widget-Validator liest targetNumbers aus dem Update).
        context: "query",
      }).lean();
      if (!agent) return reply.code(404).send({ error: "not found" });
      return { agent };
    },
  );

  // Widget-Key rotieren (macht einen geleakten Embed-Key sofort wertlos).
  app.post(
    "/:id/widget/key",
    { schema: { tags: ["agents"], summary: "Widget-Key rotieren", params: idParam } },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      const key = newWidgetKey();
      const agent = await Agent.findByIdAndUpdate(id, { $set: { "widget.key": key } }, { new: true }).lean();
      if (!agent) return reply.code(404).send({ error: "not found" });
      return { key };
    },
  );

  // Löschen
  app.delete("/:id", { schema: { tags: ["agents"], summary: "Agent löschen", params: idParam } }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const deleted = await Agent.findByIdAndDelete(id).lean();
    if (!deleted) return reply.code(404).send({ error: "not found" });
    return { deleted: true };
  });
}
