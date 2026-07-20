/**
 * MCP-Anbindung (Model Context Protocol) als Tool-Quelle pro Agent, Transport
 * Streamable HTTP. Zwei Zugriffsmuster:
 *
 *   - listMcpTools(): Tool-Liste eines Servers mit prozessweitem Cache (TTL ~5 min),
 *     damit der Call-Aufbau (Greeting-Pfad!) nicht pro Anruf auf tools/list wartet.
 *   - connectMcp(): frische Client-Verbindung — das Toolset verbindet lazy beim ersten
 *     Dispatch und hält die Verbindung für die Call-Dauer (close() im Teardown).
 *
 * Auth v1: statische Header (mit `${ENV:NAME}`-Platzhaltern), kein OAuth.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

import type { ResolvedMcpServer } from "../types.js";
import { appVersion } from "../util/banner.js";
import { substituteEnvPlaceholders } from "../util/http.js";
import { logger } from "../util/logger.js";

const log = logger.child({ mod: "mcp" });

export interface McpToolInfo {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

const listCache = new Map<string, { at: number; tools: McpToolInfo[] }>();
const LIST_CACHE_TTL_MS = 5 * 60_000;

/** Nur für Tests: Tool-Listen-Cache leeren. */
export function resetMcpToolCache(): void {
  listCache.clear();
}

function resolvedHeaders(server: ResolvedMcpServer): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(server.headers)) headers[k] = substituteEnvPlaceholders(v);
  return headers;
}

/** Baut eine verbundene MCP-Client-Session zum Server auf (Timeout = server.timeoutMs). */
export async function connectMcp(server: ResolvedMcpServer): Promise<Client> {
  const client = new Client({ name: "voice-office-hub", version: appVersion() });
  const transport = new StreamableHTTPClientTransport(
    new URL(substituteEnvPlaceholders(server.url)),
    { requestInit: { headers: resolvedHeaders(server) } },
  );
  await client.connect(transport, { timeout: server.timeoutMs });
  return client;
}

/**
 * Tool-Liste eines MCP-Servers (gecacht pro URL). Wirft bei unerreichbarem Server —
 * der Aufrufer (Toolset) überspringt den Server dann mit Warn-Log.
 */
export async function listMcpTools(server: ResolvedMcpServer): Promise<McpToolInfo[]> {
  const hit = listCache.get(server.url);
  if (hit && Date.now() - hit.at < LIST_CACHE_TTL_MS) return hit.tools;

  const client = await connectMcp(server);
  try {
    const res = await client.listTools(undefined, { timeout: server.timeoutMs });
    const tools: McpToolInfo[] = (res.tools ?? []).map((t) => ({
      name: t.name,
      description: t.description ?? "",
      parameters: (t.inputSchema as Record<string, unknown>) ?? { type: "object", properties: {} },
    }));
    listCache.set(server.url, { at: Date.now(), tools });
    return tools;
  } finally {
    await client.close().catch(() => undefined);
  }
}

/** Text-Teile einer MCP-Antwort konkatenisieren (andere Content-Typen werden ignoriert). */
export function mcpContentText(content: unknown): string {
  if (!Array.isArray(content)) return "";
  return content
    .filter((c): c is { type: string; text: string } => !!c && (c as { type?: string }).type === "text")
    .map((c) => c.text)
    .join("\n");
}

/** Ruft ein Tool über eine bestehende Client-Verbindung auf und normalisiert das Ergebnis. */
export async function callMcpTool(
  client: Client,
  server: ResolvedMcpServer,
  toolName: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  const res = await client.callTool({ name: toolName, arguments: args }, undefined, {
    timeout: server.timeoutMs,
  });
  const text = mcpContentText(res.content);
  if (res.isError) {
    log.warn("MCP-Tool meldet Fehler", { server: server.name, tool: toolName });
    throw new Error(text || "MCP-Tool meldet einen Fehler");
  }
  if (res.structuredContent !== undefined) return res.structuredContent;
  return { result: text };
}
