/**
 * Registry der EINGEBAUTEN Tools (transfer_call, end_call, …). Jedes Tool bündelt sein
 * JSON-Schema und seinen Handler. Welche Tools ein Anruf tatsächlich bekommt und wie
 * dispatcht wird, entscheidet das per-Call-Toolset (tools/toolset.ts) — dort werden
 * Registry-Tools mit den am Agent hinterlegten HTTP-Tools zusammengeführt.
 */

/** Transportneutraler Anruf-Kontext für Tool-Handler (keine ARI-Objekte). */
export interface ToolContext {
  /** Anruf-ID = Mongo-requestId (bewusst NIE die ARI-channelId — gilt auch für künftige Ingress-Wege). */
  callId: string;
  callerNumber?: string;
  /** DB-Id des bedienenden Agenten (fehlt beim Default-Agenten). */
  agentId?: string;
  /** Angerufene DDI. */
  targetNumber?: string;
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
  handler: ToolHandler;
}

const registry = new Map<string, Tool>();

export function registerTool(tool: Tool): void {
  registry.set(tool.name, tool);
}

export function getTool(name: string): Tool | undefined {
  return registry.get(name);
}

/** Alle registrierten eingebauten Tools (für die Admin-API/Tool-Auswahl im UI). */
export function listTools(): Tool[] {
  return [...registry.values()];
}
