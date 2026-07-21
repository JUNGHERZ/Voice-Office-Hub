/**
 * Streaming-Chat-Completions-Client (Requesty, OpenAI-kompatibel) für die
 * NativeSession: SSE-Deltas → onTextDelta (Satz-Overlap in die TTS), Tool-Call-
 * Fragmente werden index-basiert akkumuliert (Wire-Format live verifiziert
 * 2026-07-21). Abbruch über AbortSignal (Barge-in) — wirft dann einen
 * AbortError, den der Orchestrator fängt und verwirft.
 */
import type { ChatMessage, ChatStreamChunk, LlmStreamResult, LlmToolCall } from "./types.js";
import type { FunctionDefinition } from "../voice/types.js";

export interface OpenAiTool {
  type: "function";
  function: { name: string; description: string; parameters: Record<string, unknown> };
}

/** Toolset-Definitionen → OpenAI-tools-Format (endpoint-Feld bleibt engine-intern). */
export function toOpenAiTools(functions: FunctionDefinition[]): OpenAiTool[] {
  return functions.map((f) => ({
    type: "function",
    function: { name: f.name, description: f.description, parameters: f.parameters },
  }));
}

export interface ChatStreamRequest {
  baseUrl: string;
  apiKey: string;
  model: string;
  messages: ChatMessage[];
  tools?: OpenAiTool[];
  temperature?: number;
  signal: AbortSignal;
}

/**
 * Zerlegt einen SSE-Text-Stream in `data:`-Payloads. Pur und einzeln testbar;
 * liefert eine push()-Funktion für Netzwerk-Chunks und ruft onData pro Event.
 */
export function createSseParser(onData: (payload: string) => void): (chunk: string) => void {
  let buf = "";
  return (chunk: string) => {
    buf += chunk;
    let idx: number;
    // Events enden mit Leerzeile; wir verarbeiten zeilenweise (Chat-Completions
    // senden pro Event genau eine data:-Zeile).
    while ((idx = buf.indexOf("\n")) !== -1) {
      const line = buf.slice(0, idx).replace(/\r$/, "");
      buf = buf.slice(idx + 1);
      if (line.startsWith("data:")) onData(line.slice(5).trim());
    }
  };
}

/**
 * Streamt eine Chat-Completion. Text-Deltas gehen sofort an onTextDelta;
 * das Ergebnis enthält den Gesamttext + fertig akkumulierte Tool-Calls.
 */
export async function streamChatCompletion(
  req: ChatStreamRequest,
  onTextDelta: (text: string) => void,
): Promise<LlmStreamResult> {
  const res = await fetch(`${req.baseUrl.replace(/\/$/, "")}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${req.apiKey}`,
    },
    body: JSON.stringify({
      model: req.model,
      stream: true,
      messages: req.messages,
      ...(req.tools?.length ? { tools: req.tools } : {}),
      ...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
    }),
    signal: req.signal,
  });

  if (!res.ok || !res.body) {
    const body = await res.text().catch(() => "");
    throw new Error(`LLM-Stream fehlgeschlagen (HTTP ${res.status}): ${body.slice(0, 300)}`);
  }

  let content = "";
  let finishReason: string | undefined;
  // Tool-Call-Fragmente: erster Chunk pro index trägt id/name, Folge-Chunks arguments-Stücke.
  const partial = new Map<number, { id: string; name: string; args: string }>();
  let done = false;

  const parse = createSseParser((payload) => {
    if (payload === "[DONE]") {
      done = true;
      return;
    }
    let chunk: ChatStreamChunk;
    try {
      chunk = JSON.parse(payload) as ChatStreamChunk;
    } catch {
      return; // defekte Zeile überspringen (nächstes Event repariert nichts rückwirkend)
    }
    const choice = chunk.choices?.[0];
    if (!choice) return;
    if (choice.finish_reason) finishReason = choice.finish_reason;
    const delta = choice.delta;
    if (!delta) return;
    if (typeof delta.content === "string" && delta.content.length) {
      content += delta.content;
      onTextDelta(delta.content);
    }
    for (const tc of delta.tool_calls ?? []) {
      const entry = partial.get(tc.index) ?? { id: "", name: "", args: "" };
      if (tc.id) entry.id = tc.id;
      if (tc.function?.name) entry.name = tc.function.name;
      if (tc.function?.arguments) entry.args += tc.function.arguments;
      partial.set(tc.index, entry);
    }
  });

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  try {
    while (!done) {
      const { value, done: streamEnd } = await reader.read();
      if (streamEnd) break;
      parse(decoder.decode(value, { stream: true }));
    }
  } catch (err) {
    // undici meldet einen Abbruch mitten im Stream als "TypeError: terminated" —
    // für den Orchestrator (Barge-in unterscheidet Abbruch von echtem Fehler)
    // auf einen sauberen AbortError normalisieren.
    if (req.signal.aborted) throw new DOMException("LLM-Stream abgebrochen", "AbortError");
    throw err;
  }

  const toolCalls: LlmToolCall[] = [...partial.entries()]
    .sort(([a], [b]) => a - b)
    .map(([, t]) => ({ id: t.id, type: "function", function: { name: t.name, arguments: t.args } }));

  return { content, toolCalls, ...(finishReason ? { finishReason } : {}) };
}
