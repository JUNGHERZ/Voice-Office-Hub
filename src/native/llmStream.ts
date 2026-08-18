/**
 * Streaming-Chat-Completions-Client (Requesty, OpenAI-kompatibel) für die
 * NativeSession: SSE-Deltas → onTextDelta (Satz-Overlap in die TTS), Tool-Call-
 * Fragmente werden index-basiert akkumuliert (Wire-Format live verifiziert
 * 2026-07-21). Abbruch über AbortSignal (Barge-in) — wirft dann einen
 * AbortError, den der Orchestrator fängt und verwirft.
 */
import { promptCacheMinTokens, supportsPromptCache } from "../llm/models.js";
import type {
  ChatMessage,
  ChatStreamChunk,
  LlmStreamResult,
  LlmStreamUsage,
  LlmToolCall,
  WireChatMessage,
} from "./types.js";
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
  /** Prompt-Caching-Breakpoint setzen (nur Claude-Modelle, siehe withPromptCache). */
  promptCache?: boolean;
  signal: AbortSignal;
}

/**
 * Grobschaetzung Zeichen→Tokens fuer die Cache-Diagnose. 2,75 ist an echtem
 * deutschem Prompt-/Transkripttext gegen die Bedrock-Abrechnung gemessen
 * (2026-08-18); Englisch liegt naeher an 4. Nur fuer das Log — die Entscheidung,
 * ob gecacht wird, haengt nicht daran.
 */
const CHARS_PER_TOKEN_DE = 2.75;

/** Zeichenlaenge einer Message fuer die Praefix-Schaetzung. */
function messageChars(m: ChatMessage): number {
  let n = (m.content ?? "").length;
  for (const c of m.tool_calls ?? []) n += c.function.arguments.length + c.function.name.length;
  return n;
}

/**
 * Setzt den Prompt-Caching-Breakpoint auf die System-Message und liefert die
 * Messages in Wire-Form. Zwei Gruende fuer genau diese Platzierung:
 *
 *  - Anthropic rendert `tools` → `system` → `messages`. Ein Breakpoint auf der
 *    System-Message cacht damit Tools UND System-Prompt in einem Zug.
 *  - Alles danach (die wachsende Historie) bleibt ungecacht — sie aendert sich pro
 *    Turn ohnehin und ist mit ~550 Tokens im Schnitt klein gegen einen grossen
 *    System-Prompt, der pro Anruf rund sieben Mal erneut rausgeht.
 *
 * Ist das Modell kein Claude, bleiben die Messages unveraendert: die Blockform
 * wuerde andere Anbieter im schlechtesten Fall mit einem 400 quittieren.
 */
export function withPromptCache(
  messages: ChatMessage[],
  model: string,
  enabled: boolean,
): WireChatMessage[] {
  if (!enabled || !supportsPromptCache(model)) return messages;
  // Letzte System-Message ist der Breakpoint; leere cacht nichts und bleibt String.
  const idx = messages.reduce((acc, m, i) => (m.role === "system" && m.content ? i : acc), -1);
  if (idx === -1) return messages;
  const sys = messages[idx] as ChatMessage & { content: string };
  return messages.map((m, i) =>
    i === idx
      ? { ...m, content: [{ type: "text", text: sys.content, cache_control: { type: "ephemeral" } }] }
      : m,
  );
}

/**
 * Praefix (Tools + System) in geschaetzten Tokens — fuer die Diagnose, ob der
 * Prompt die Mindestlaenge des Modells ueberhaupt erreicht.
 */
export function estimatePrefixTokens(messages: ChatMessage[], tools?: OpenAiTool[]): number {
  const sys = messages.filter((m) => m.role === "system").reduce((n, m) => n + messageChars(m), 0);
  const t = tools?.length ? JSON.stringify(tools).length : 0;
  return Math.round((sys + t) / CHARS_PER_TOKEN_DE);
}

/** True, wenn gecacht wird, das Praefix aber unter der Mindestlaenge des Modells liegt. */
export function promptCacheBelowMinimum(
  messages: ChatMessage[],
  model: string,
  enabled: boolean,
  tools?: OpenAiTool[],
): boolean {
  if (!enabled || !supportsPromptCache(model)) return false;
  return estimatePrefixTokens(messages, tools) < promptCacheMinTokens(model);
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
      messages: withPromptCache(req.messages, req.model, req.promptCache ?? false),
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
  let usage: LlmStreamUsage | undefined;
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
    // Vor der choices-Pruefung: das Nutzungs-Event traegt zwar choices, aber ein
    // leeres delta — und bei anderen Anbietern gar keine choices.
    if (chunk.usage) {
      const d = chunk.usage.prompt_tokens_details;
      usage = {
        promptTokens: chunk.usage.prompt_tokens ?? 0,
        completionTokens: chunk.usage.completion_tokens ?? 0,
        cachedTokens: d?.cached_tokens ?? 0,
        cacheWriteTokens: d?.caching_tokens ?? 0,
      };
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

  return { content, toolCalls, ...(finishReason ? { finishReason } : {}), ...(usage ? { usage } : {}) };
}
