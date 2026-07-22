/**
 * Interne Wire- und Naht-Typen der NativeSession (STT→LLM→TTS-Kaskade).
 * Wire-Formate wurden am 2026-07-21 gegen die realen APIs verifiziert
 * (Flux v2-Listen, Aura-Speak-WS, Requesty-SSE) — tolerant geparst.
 */

// ── Flux (Streaming-STT, v2) ──────────────────────────────────────────────────

/** Server → Client: {"type":"TurnInfo","event":"…","transcript":"…",…} */
export interface FluxTurnInfo {
  type: "TurnInfo";
  event: "StartOfTurn" | "Update" | "EagerEndOfTurn" | "TurnResumed" | "EndOfTurn" | string;
  transcript?: string;
  turn_index?: number;
  end_of_turn_confidence?: number;
}

export interface FluxConnected {
  type: "Connected";
  request_id?: string;
}

export type FluxServerMessage = FluxTurnInfo | FluxConnected | { type: string };

// ── Aura (Streaming-TTS) ─────────────────────────────────────────────────────

/** Server → Client Steuernachrichten; Audio kommt als Binärframes. */
export interface AuraServerMessage {
  type: "Metadata" | "Flushed" | "Cleared" | "Warning" | string;
  request_id?: string;
  sequence_id?: number;
  description?: string;
}

// ── OpenAI-kompatibles Chat-Streaming (Requesty) ─────────────────────────────

export interface LlmToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  /** Nur bei role=assistant mit Tool-Aufrufen. */
  tool_calls?: LlmToolCall[];
  /** Nur bei role=tool: Korrelation zum Aufruf. */
  tool_call_id?: string;
}

/** Ein SSE-Chunk (`data: {…}`) des Chat-Completions-Streams. */
export interface ChatStreamChunk {
  choices?: Array<{
    delta?: {
      content?: string | null;
      tool_calls?: Array<{
        index: number;
        id?: string;
        type?: string;
        function?: { name?: string; arguments?: string };
      }>;
    };
    finish_reason?: string | null;
  }>;
}

export interface LlmStreamResult {
  content: string;
  toolCalls: LlmToolCall[];
  finishReason?: string;
}

// ── Naht für den Orchestrator (Tests injizieren Fakes) ───────────────────────

export interface SttStreamLike {
  start(): Promise<void>;
  sendAudio(chunk: Buffer): void;
  close(): void;
  on(event: string, listener: (...args: never[]) => void): unknown;
}

/**
 * Tatsächlich an den TTS-Anbieter GESENDETER Verbrauch (= Abrechnungsbasis;
 * gepufferte, per clear() verworfene Texte zählen nicht). credits nur bei
 * Anbietern mit Credit-Modell (ElevenLabs: Flash/Turbo = 0,5 Credits/Zeichen).
 */
export interface TtsUsage {
  provider: string;
  model: string;
  characters: number;
  credits?: number;
}

export interface TtsStreamLike {
  start(): Promise<void>;
  sendText(text: string): void;
  flush(): void;
  clear(): void;
  close(): void;
  usage?(): TtsUsage;
  on(event: string, listener: (...args: never[]) => void): unknown;
}
