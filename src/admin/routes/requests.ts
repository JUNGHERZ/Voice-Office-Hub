/**
 * Management-API: Requests (Anrufe) lesen + Aufnahme-Download (GridFS).
 * Read-only. Geschützt per requireAuth (Session-Cookie ODER API-Key).
 */
import type { FastifyInstance } from "fastify";
import type { Types } from "mongoose";

import { openRecordingDownload } from "../../db/gridfs.js";
import { RequestModel } from "../../db/models/Request.js";
import { requireAuth } from "../auth.js";

const idParam = {
  type: "object",
  properties: { id: { type: "string", description: "Request-ObjectId" } },
  required: ["id"],
} as const;

const listQuery = {
  type: "object",
  properties: {
    limit: { type: "integer", minimum: 1, maximum: 200, default: 50 },
    skip: { type: "integer", minimum: 0, default: 0 },
    mode: { type: "string", enum: ["agent", "passthrough"] },
    status: { type: "string", enum: ["in_progress", "completed", "failed"] },
  },
} as const;

export async function requestRoutes(app: FastifyInstance): Promise<void> {
  app.addHook("preHandler", requireAuth);

  // Liste (paginiert, kompakte Projektion — ohne volles Transkript)
  app.get("/", { schema: { tags: ["requests"], summary: "Anrufe auflisten", querystring: listQuery } }, async (req) => {
    const q = req.query as { limit?: string; skip?: string; mode?: string; status?: string };
    const limit = Math.min(Number(q.limit) || 50, 200);
    const skip = Math.max(Number(q.skip) || 0, 0);
    const filter: Record<string, unknown> = {};
    if (q.mode) filter.mode = q.mode;
    if (q.status) filter.status = q.status;

    const [items, total] = await Promise.all([
      RequestModel.find(filter)
        .select(
          "mode callerNumber targetNumber status startedAt endedAt durationSec transcriptionStatus recording.gridFsId recording.durationSec summary.status agentId",
        )
        // Agenten-Name für die Listen-Beschriftung ("Web → 123 (Weiterleitungs Fred)").
        .populate("agentId", "name")
        .sort({ startedAt: -1 })
        .skip(skip)
        .limit(limit)
        .lean(),
      RequestModel.countDocuments(filter),
    ]);
    return { items, total, limit, skip };
  });

  // Detail (vollständig)
  app.get("/:id", { schema: { tags: ["requests"], summary: "Anruf (Detail)", params: idParam } }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const request = await RequestModel.findById(id).populate("agentId", "name").lean();
    if (!request) return reply.code(404).send({ error: "not found" });
    return { request };
  });

  // Aufnahme als WAV streamen
  app.get(
    "/:id/recording",
    { schema: { tags: ["requests"], summary: "Aufnahme (WAV) streamen", params: idParam, produces: ["audio/wav"] } },
    async (req, reply) => {
    const { id } = req.params as { id: string };
    const doc = await RequestModel.findById(id, { recording: 1 }).lean();
    const gridFsId = doc?.recording?.gridFsId;
    if (!gridFsId) return reply.code(404).send({ error: "no recording" });
    reply.header("Content-Type", "audio/wav");
    reply.header("Content-Disposition", `inline; filename="${id}.wav"`);
    return reply.send(openRecordingDownload(gridFsId as unknown as Types.ObjectId));
  });
}
