/**
 * Admin-Server (Fastify): JSON-Management-API + Auslieferung des statischen Frontends
 * (Hybrids + GlassKit, kein Build). Eigener Prozess, entkoppelt von der Telefonie;
 * teilt mit dem Kern nur die MongoDB/Mongoose-Modelle.
 */
import path from "node:path";

import cookie from "@fastify/cookie";
import httpProxy from "@fastify/http-proxy";
import fastifyStatic from "@fastify/static";
import swagger from "@fastify/swagger";
import swaggerUi from "@fastify/swagger-ui";
import Fastify, { type FastifyInstance } from "fastify";

import { config } from "../config.js";
import { appVersion } from "../util/banner.js";
import { logger } from "../util/logger.js";
import { clearSession, passwordValid, requireAuth, setSession } from "./auth.js";
import { agentRoutes } from "./routes/agents.js";
import { ambienceRoutes } from "./routes/ambience.js";
import { requestRoutes } from "./routes/requests.js";
import { toolRoutes } from "./routes/tools.js";
import { widgetRoutes } from "./routes/widget.js";

const log = logger.child({ mod: "admin" });
const ROOT = process.cwd(); // im Container /app, in Dev das Repo-Root

export async function buildAdminServer(): Promise<FastifyInstance> {
  // trustProxy: hinter Traefik (Prod) stimmen sonst req.protocol (wss-URL-Ableitung)
  // und req.ip (Rate-Limits der Widget-Endpoints) nicht; lokal ohne Proxy ein No-op.
  const app = Fastify({ logger: false, bodyLimit: 2 * 1024 * 1024, trustProxy: true });

  await app.register(cookie, { secret: config.admin.sessionSecret });

  // OpenAPI: muss VOR den Routen registriert werden (sammelt deren Schemas).
  await app.register(swagger, {
    openapi: {
      info: { title: "Voice-Office-Hub — Management API", version: appVersion() },
      components: {
        securitySchemes: {
          apiKey: { type: "apiKey", in: "header", name: "x-api-key" },
          session: { type: "apiKey", in: "cookie", name: "vh_session" },
        },
      },
      tags: [
        { name: "auth", description: "Login / Session" },
        { name: "agents", description: "Agent-Verwaltung (CRUD)" },
        { name: "requests", description: "Anrufe / Requests (read-only) + Aufnahme" },
        { name: "tools", description: "Verfügbare eingebaute Tools (read-only)" },
        { name: "ambience", description: "Hintergrundatmosphäre — Presets (read-only)" },
        { name: "widget", description: "Web-Widget (öffentlich: key-/token-gebunden)" },
      ],
    },
  });

  // Statisches Frontend
  await app.register(fastifyStatic, { root: path.join(ROOT, "webui"), prefix: "/" });
  // Vendored Assets (kein Bundler, kein CDN-Zwang — Appliance-tauglich)
  const vendor = (sub: string, prefix: string) =>
    app.register(fastifyStatic, { root: path.join(ROOT, "node_modules", sub), prefix, decorateReply: false });
  await vendor("@jungherz-de/glasskit", "/vendor/glasskit/");
  await vendor("@jungherz-de/glasskit-elements/dist", "/vendor/glasskit-elements/");
  await vendor("hybrids/src", "/vendor/hybrids/");
  // sip.js ist natives Browser-ESM (lib/-Baum mit .js-Imports) → buildless einbindbar.
  await vendor("sip.js/lib", "/vendor/sipjs/");

  // Mongoose-Validierungsfehler → 400 (statt 500)
  app.setErrorHandler((err: Error, _req, reply) => {
    const name = (err as { name?: string }).name;
    if (name === "ValidationError" || name === "CastError") {
      return reply.code(400).send({ error: name, message: err.message });
    }
    log.error("Admin-Fehler", { err: String(err) });
    return reply.code(500).send({ error: "internal" });
  });

  // Auth-Endpunkte
  const loginSchema = {
    tags: ["auth"],
    summary: "Login (Passwort → Session-Cookie)",
    body: { type: "object", properties: { password: { type: "string" } }, required: ["password"] },
  };
  app.post("/api/login", { schema: loginSchema }, async (req, reply) => {
    const { password } = (req.body ?? {}) as { password?: string };
    if (!passwordValid(password)) return reply.code(401).send({ error: "invalid" });
    setSession(reply);
    return { ok: true };
  });
  app.post("/api/logout", { schema: { tags: ["auth"], summary: "Logout (Session beenden)" } }, async (_req, reply) => {
    clearSession(reply);
    return { ok: true };
  });
  app.get("/api/me", { schema: { tags: ["auth"], summary: "Session prüfen" }, preHandler: requireAuth }, async () => ({ ok: true }));

  // Ressourcen
  await app.register(agentRoutes, { prefix: "/api/agents" });
  await app.register(requestRoutes, { prefix: "/api/requests" });
  await app.register(toolRoutes, { prefix: "/api/tools" });
  await app.register(ambienceRoutes, { prefix: "/api/ambience" });
  // Widget-Routen sind öffentlich (key-/token-gebunden) und definieren ihre Pfade selbst.
  await app.register(widgetRoutes);

  // SIP-over-WebSocket-Durchleitung fürs Web-Widget: /ws → Asterisk-HTTP-Server (loopback).
  // Dadurch reicht EIN öffentlicher Port (8080) für UI, API und SIP-WS — jeder simple
  // TLS-Proxy davor (Traefik/EasyPanel, OrbStack-Domain) funktioniert ohne Pfad-Sonderroute,
  // und Asterisks HTTP-Server (trägt auch ARI) bleibt auf 127.0.0.1 gehärtet.
  if (config.widget.enabled) {
    await app.register(httpProxy, {
      upstream: config.ari.url, // z. B. http://127.0.0.1:8088 — derselbe Server trägt /ws
      prefix: "/ws",
      rewritePrefix: "/ws",
      websocket: true,
    });
  }

  // OpenAPI-Spec (JSON) + interaktive Doku (wie FastAPI /docs)
  await app.register(swaggerUi, { routePrefix: "/docs" });
  app.get("/openapi.json", async () => app.swagger());

  return app;
}
