/**
 * Management-API: Agents-CRUD über die `agents`-Collection (Mongoose-Modell wiederverwendet).
 * Geschützt per requireAuth (Session-Cookie ODER API-Key).
 */
import type { FastifyInstance } from "fastify";

import { Agent } from "../../db/models/Agent.js";
import { requireAuth } from "../auth.js";

export async function agentRoutes(app: FastifyInstance): Promise<void> {
  app.addHook("preHandler", requireAuth);

  // Liste
  app.get("/", async () => {
    const agents = await Agent.find().sort({ name: 1 }).lean();
    return { agents };
  });

  // Detail
  app.get("/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const agent = await Agent.findById(id).lean();
    if (!agent) return reply.code(404).send({ error: "not found" });
    return { agent };
  });

  // Anlegen
  app.post("/", async (req, reply) => {
    const agent = await Agent.create(req.body as Record<string, unknown>);
    return reply.code(201).send({ agent: agent.toObject() });
  });

  // Ändern (Teil-Update)
  app.patch("/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const agent = await Agent.findByIdAndUpdate(id, req.body as Record<string, unknown>, {
      new: true,
      runValidators: true,
    }).lean();
    if (!agent) return reply.code(404).send({ error: "not found" });
    return { agent };
  });

  // Löschen
  app.delete("/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const deleted = await Agent.findByIdAndDelete(id).lean();
    if (!deleted) return reply.code(404).send({ error: "not found" });
    return { deleted: true };
  });
}
