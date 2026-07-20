/**
 * Per-Call-Toolset: vereinigt die eingebauten Tools (Registry, per agent.tools aktiviert)
 * mit den am Agent hinterlegten HTTP-Tools (agent.customTools). Der callHandler baut pro
 * Anruf EIN Toolset, reicht dessen definitions an den Voice-Provider und dispatcht darüber.
 *
 * Grundsätze:
 *   - Alle Tools laufen client_side: die Engine ruft Endpoints selbst auf; URLs/Header
 *     (inkl. `${ENV:}`-Secrets) verlassen den Server nie Richtung Voice-Provider.
 *   - dispatch() wirft nie — jeder Fehler wird zu {ok:false, result:{error}} und damit zu
 *     einer sprechbaren Antwort; ein kaputter Endpoint darf den Anruf nicht aufhängen.
 *   - close() räumt Call-gebundene Ressourcen auf (heute leer; MCP-Verbindungen folgen).
 */
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";

import type { ResolvedAgent, ResolvedCustomTool, ResolvedMcpServer } from "../types.js";
import { fetchWithTimeout, substituteEnvPlaceholders } from "../util/http.js";
import { logger } from "../util/logger.js";
import type { FunctionDefinition } from "../voice/types.js";
import { callMcpTool, connectMcp, listMcpTools } from "./mcp.js";
import { getTool, type ToolContext } from "./registry.js";

const log = logger.child({ mod: "toolset" });

/** Ergebnisse/Fehlertexte kappen, damit kein Endpoint das LLM-Kontextfenster flutet. */
const MAX_RESULT_CHARS = 4096;

export interface DispatchOutcome {
  ok: boolean;
  result: unknown;
}

export interface CallToolset {
  definitions: FunctionDefinition[];
  dispatch(name: string, rawArgs: string, ctx: ToolContext): Promise<DispatchOutcome>;
  close(): Promise<void>;
}

/** Baut das Toolset für einen Anruf (async: ab MCP kommen hier externe Tool-Listen dazu). */
export async function buildCallToolset(agent: ResolvedAgent): Promise<CallToolset> {
  const definitions: FunctionDefinition[] = [];
  const dispatchers = new Map<string, (rawArgs: string, ctx: ToolContext) => Promise<unknown>>();

  for (const name of agent.tools) {
    const tool = getTool(name);
    if (!tool) {
      log.warn("Unbekanntes eingebautes Tool am Agent — übersprungen", { agent: agent.name, name });
      continue;
    }
    definitions.push({ name: tool.name, description: tool.description, parameters: tool.parameters });
    dispatchers.set(tool.name, (rawArgs, ctx) => tool.handler(parseArgs(rawArgs), ctx));
  }

  for (const tool of agent.customTools) {
    if (!tool.enabled) continue;
    // Schema-Validierung verhindert Built-in-Kollisionen bereits beim Speichern; hier nur Netz.
    if (dispatchers.has(tool.name)) {
      log.warn("Custom-Tool kollidiert mit aktivem Tool — übersprungen", { agent: agent.name, name: tool.name });
      continue;
    }
    definitions.push({ name: tool.name, description: tool.description, parameters: tool.parameters });
    dispatchers.set(tool.name, (rawArgs, ctx) => executeHttpTool(tool, parseArgs(rawArgs), ctx));
  }

  // MCP-Server des Agenten: Tool-Listen (gecacht) einsammeln, Tools präfixiert anbieten.
  // Verbindungen entstehen lazy beim ersten Dispatch und leben bis toolset.close().
  const mcpConnections = new Map<string, Promise<Client>>();
  for (const server of agent.mcpServers) {
    if (!server.enabled) continue;
    let tools;
    try {
      tools = await listMcpTools(server);
    } catch (err) {
      // Server nicht erreichbar → ohne dessen Tools starten; der Greeting-Pfad blockiert nie.
      log.warn("MCP-Server nicht erreichbar — übersprungen", { server: server.name, err: String(err) });
      continue;
    }
    for (const t of tools) {
      if (server.toolFilter.length && !server.toolFilter.includes(t.name)) continue;
      const prefixed = `${server.name}_${t.name}`;
      if (dispatchers.has(prefixed)) {
        log.warn("MCP-Tool kollidiert mit aktivem Tool — übersprungen", { name: prefixed });
        continue;
      }
      definitions.push({ name: prefixed, description: t.description, parameters: t.parameters });
      dispatchers.set(prefixed, (rawArgs) =>
        dispatchMcpTool(server, t.name, parseArgs(rawArgs), mcpConnections),
      );
    }
  }

  return {
    definitions,
    async dispatch(name, rawArgs, ctx) {
      const run = dispatchers.get(name);
      if (!run) return { ok: false, result: { error: `Unbekanntes Tool: ${name}` } };
      try {
        return { ok: true, result: capResult(await run(rawArgs, ctx)) };
      } catch (err) {
        log.warn("Tool-Dispatch fehlgeschlagen", { name, err: String(err) });
        return { ok: false, result: { error: `Tool "${name}" fehlgeschlagen: ${trimError(err)}` } };
      }
    },
    async close() {
      // Call-gebundene MCP-Verbindungen schließen (lazy aufgebaute, siehe dispatchMcpTool).
      await Promise.all(
        [...mcpConnections.values()].map(async (pending) => {
          try {
            const client = await pending;
            await client.close();
          } catch {
            /* ignore — Verbindung kam nie zustande */
          }
        }),
      );
    },
  };
}

/**
 * MCP-Dispatch mit lazy Verbindungsaufbau: erste Nutzung eines Servers verbindet,
 * weitere Aufrufe teilen die Verbindung (Promise im Map). Ein fehlgeschlagener
 * Aufbau wird entfernt, damit der nächste Aufruf neu verbinden kann.
 */
async function dispatchMcpTool(
  server: ResolvedMcpServer,
  toolName: string,
  args: Record<string, unknown>,
  connections: Map<string, Promise<Client>>,
): Promise<unknown> {
  let pending = connections.get(server.name);
  if (!pending) {
    pending = connectMcp(server);
    connections.set(server.name, pending);
  }
  let client: Client;
  try {
    client = await pending;
  } catch (err) {
    connections.delete(server.name);
    throw err;
  }
  return callMcpTool(client, server, toolName, args);
}

/**
 * HTTP-Ausführung eines Custom-Tools.
 *   POST: JSON-Envelope {arguments, call:{callId, callerNumber?, agentId?, targetNumber?}}.
 *   GET:  Argumente flach als Query-Parameter + call_id/caller_number.
 * Antwort: JSON → Objekt als Tool-Result; sonst Text (gekappt) unter {result}.
 */
async function executeHttpTool(
  tool: ResolvedCustomTool,
  args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<unknown> {
  const url = new URL(substituteEnvPlaceholders(tool.endpoint.url));
  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(tool.endpoint.headers)) headers[k] = substituteEnvPlaceholders(v);

  let res: Response;
  if (tool.endpoint.method === "GET") {
    for (const [k, v] of Object.entries(args)) url.searchParams.set(k, stringifyParam(v));
    url.searchParams.set("call_id", ctx.callId);
    if (ctx.callerNumber) url.searchParams.set("caller_number", ctx.callerNumber);
    res = await fetchWithTimeout(url.toString(), {
      method: "GET",
      headers,
      timeoutMs: tool.endpoint.timeoutMs,
    });
  } else {
    const call = {
      callId: ctx.callId,
      ...(ctx.callerNumber ? { callerNumber: ctx.callerNumber } : {}),
      ...(ctx.agentId ? { agentId: ctx.agentId } : {}),
      ...(ctx.targetNumber ? { targetNumber: ctx.targetNumber } : {}),
    };
    res = await fetchWithTimeout(url.toString(), {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify({ arguments: args, call }),
      timeoutMs: tool.endpoint.timeoutMs,
    });
  }

  const text = await res.text();
  if (!res.ok) throw new Error(`Endpoint antwortete ${res.status}: ${text.slice(0, 300)}`);
  try {
    return JSON.parse(text);
  } catch {
    return { result: text.slice(0, MAX_RESULT_CHARS) };
  }
}

function parseArgs(rawArgs: string): Record<string, unknown> {
  if (!rawArgs) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawArgs);
  } catch {
    throw new Error("Ungültige Argumente (kein JSON)");
  }
  return typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : {};
}

function stringifyParam(value: unknown): string {
  return typeof value === "string" ? value : JSON.stringify(value);
}

function capResult(result: unknown): unknown {
  if (typeof result === "string") return result.slice(0, MAX_RESULT_CHARS);
  try {
    const json = JSON.stringify(result);
    if (json && json.length > MAX_RESULT_CHARS)
      return { truncated: true, result: json.slice(0, MAX_RESULT_CHARS) };
  } catch {
    /* zirkulär o. Ä. — unverändert durchreichen */
  }
  return result;
}

function trimError(err: unknown): string {
  return (err instanceof Error ? err.message : String(err)).slice(0, 300);
}
