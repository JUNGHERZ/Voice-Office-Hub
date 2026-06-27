/**
 * Tool-Registry & Dispatch für Function Calling.
 *
 * Jedes Tool bündelt sein JSON-Schema (für die Deepgram-Settings) und seinen Handler
 * (client_side-Ausführung in unserem Server). Der callHandler liefert den ToolContext
 * mit Anruf-Bezug und Hooks (z.B. requestTransfer über ARI).
 */
import type { FunctionDefinition } from "../deepgram/events.js";

export interface ToolContext {
  callId: string;
  callerNumber?: string;
  /** Weiterleitung anstoßen (vom ARI-Layer implementiert). */
  requestTransfer?: (target: string) => Promise<{ connected: boolean }>;
  /** Gespräch beenden/auflegen (vom ARI-Layer implementiert; legt nach Verabschiedung auf). */
  requestHangup?: () => Promise<void>;
}

export type ToolHandler = (args: Record<string, unknown>, ctx: ToolContext) => Promise<unknown>;

export interface Tool {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  /** Optionaler server-side-Endpoint; wenn gesetzt, ruft Deepgram direkt auf. */
  endpoint?: { url: string; method?: string; headers?: Record<string, string> };
  handler: ToolHandler;
}

const registry = new Map<string, Tool>();

export function registerTool(tool: Tool): void {
  registry.set(tool.name, tool);
}

export function getTool(name: string): Tool | undefined {
  return registry.get(name);
}

/** Function-Definitionen für die Settings, gefiltert auf die im Agent aktiven Tools. */
export function buildFunctionDefinitions(enabledNames: string[]): FunctionDefinition[] {
  const defs: FunctionDefinition[] = [];
  for (const name of enabledNames) {
    const tool = registry.get(name);
    if (!tool) continue;
    defs.push({
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
      ...(tool.endpoint ? { endpoint: tool.endpoint } : {}),
    });
  }
  return defs;
}

/** Führt ein client_side-Tool aus und gibt das Ergebnis (für FunctionCallResponse) zurück. */
export async function dispatchTool(
  name: string,
  rawArgs: string,
  ctx: ToolContext,
): Promise<unknown> {
  const tool = registry.get(name);
  if (!tool) return { error: `Unbekanntes Tool: ${name}` };
  let args: Record<string, unknown> = {};
  try {
    args = rawArgs ? (JSON.parse(rawArgs) as Record<string, unknown>) : {};
  } catch {
    return { error: "Ungültige Argumente (kein JSON)" };
  }
  return tool.handler(args, ctx);
}
