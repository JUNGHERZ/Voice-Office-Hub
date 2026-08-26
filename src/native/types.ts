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

// ── Flux TTS (Streaming-TTS, v2-Speak) ───────────────────────────────────────

/**
 * Server → Client Steuernachrichten von /v2/speak; Audio kommt als Binärframes.
 * Tolerant getippt — unbekannte Typen werden ignoriert.
 */
export interface FluxTtsServerMessage {
  type:
    | "Connected"
    | "SpeechStarted"
    | "SpeechInterrupted"
    | "SpeechMetadata"
    | "SessionMetadata"
    | "Flushed"
    | "ConfigureSuccess"
    | "ConfigureFailure"
    | "Warning"
    | "Error"
    | string;
  speech_id?: string;
  /** SpeechInterrupted: was der Anrufer tatsächlich gehört hat. */
  text_spoken?: string;
  text_remaining?: string;
  audio_played_ms?: number;
  /** SpeechMetadata: Abrechnungsbasis laut Server. */
  billable_character_count?: number;
  code?: string;
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

/**
 * Content-Block der Anthropic-Blockform. Nur der Request kennt ihn: die
 * ConversationHistory hält weiterhin ausschliesslich Strings (ihr Zeichenbudget
 * rechnet auf `content.length`), der Cache-Breakpoint entsteht erst an der
 * Requestgrenze in llmStream.ts.
 */
export interface ChatContentBlock {
  type: "text";
  text: string;
  /** Prompt-Caching-Breakpoint (nur Claude-Modelle, siehe llm/models.ts). */
  cache_control?: { type: "ephemeral" };
}

/** ChatMessage, wie sie tatsaechlich auf die Leitung geht. */
export type WireChatMessage = Omit<ChatMessage, "content"> & {
  content: string | ChatContentBlock[] | null;
};

/**
 * Token-Verbrauch einer Completion. `cachedTokens` sind Cache-TREFFER (zu ~10 %
 * des Inputpreises), `cacheWriteTokens` das erstmalige Anlegen (~125 %) — beide
 * zaehlen bereits in promptTokens mit und duerfen nicht addiert werden.
 */
export interface LlmStreamUsage {
  promptTokens: number;
  completionTokens: number;
  cachedTokens: number;
  cacheWriteTokens: number;
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
  /** Requesty sendet die Nutzung im letzten Event mit — ohne stream_options (verifiziert 2026-08-18). */
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    prompt_tokens_details?: { cached_tokens?: number; caching_tokens?: number };
  };
}

export interface LlmStreamResult {
  content: string;
  toolCalls: LlmToolCall[];
  finishReason?: string;
  /** Fehlt, wenn der Anbieter keine Nutzung im Stream mitsendet. */
  usage?: LlmStreamUsage;
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

/**
 * Ereignisse aller TTS-Clients. Liegt hier und nicht in ttsStream.ts, weil
 * `interrupted` von Aura gar nicht kommt — die Event-Map gehört zur Naht, nicht
 * zu einer Implementierung. ttsStream.ts re-exportiert sie, damit bestehende
 * Importe unverändert bleiben.
 */
export interface TtsStreamEvents {
  audio: (chunk: Buffer) => void;
  /** Server hat den Flush verarbeitet — das Turn-Audio ist vollständig übergeben. */
  flushed: (sequenceId: number | undefined) => void;
  /**
   * Ab jetzt gehört das ausgegebene Audio zu diesem Text (0.12.0). Nur Anbieter,
   * die ihre Ausgabe stückweise zuordnen KÖNNEN, melden das — bei der
   * HTTP-Basisklasse ist ein Auftrag exakt ein Satz. Ohne dieses Signal schätzt
   * die Sprechuhr über die Sprechrate (Aura: Binärstrom ohne Satzgrenzen).
   */
  segment: (text: string) => void;
  /**
   * Barge-in vom Anbieter bestätigt, inklusive dem, was der Anrufer WIRKLICH
   * gehört hat. Nur Anbieter mit serverseitigem Truncate liefern das
   * (Flux TTS via SpeechInterrupted); Aura und ElevenLabs kennen es nicht.
   */
  interrupted: (ev: { spokenText: string; audioPlayedMs: number }) => void;
  error: (description: string) => void;
  close: (code: number) => void;
}

export interface TtsStreamLike {
  /**
   * true = der Anbieter meldet nach einem Barge-in SELBST, was gesprochen wurde
   * (Flux TTS via SpeechInterrupted). Die Session lässt ihre Sprechuhr dann in
   * Ruhe — sonst stünde der gekürzte Turn zweimal in der Historie.
   */
  readonly reportsSpokenText?: boolean;
  start(): Promise<void>;
  sendText(text: string): void;
  flush(): void;
  /**
   * Barge-in.
   * @param unplayedMs Noch nicht abgespieltes Agent-Audio in der Media-Queue
   *   (MediaSession.pendingMs()). Anbieter mit serverseitigem Truncate rechnen
   *   daraus die echte Abspielposition; alle anderen ignorieren den Wert.
   *   Optionaler Parameter, damit bestehende Clients zuweisbar bleiben.
   */
  clear(unplayedMs?: number): void;
  close(): void;
  usage?(): TtsUsage;
  on(event: string, listener: (...args: never[]) => void): unknown;
}
