/**
 * Typen für die Deepgram-Voice-Agent-WebSocket-Nachrichten (Client → Server & Server → Client).
 * Quelle: https://developers.deepgram.com/reference/voice-agent/voice-agent
 * Es sind die für unseren Loop relevanten Felder modelliert (nicht zwingend erschöpfend).
 */

// ── Client → Server ──────────────────────────────────────────────────────────

export interface SettingsMessage {
  type: "Settings";
  audio: {
    input: { encoding: string; sample_rate: number };
    output: { encoding: string; sample_rate: number; container?: string };
  };
  agent: {
    listen: { provider: Record<string, unknown> };
    think: {
      provider: Record<string, unknown>;
      endpoint?: { url: string; headers?: Record<string, string> };
      prompt?: string;
      functions?: FunctionDefinition[];
      context_length?: number | "max";
    };
    speak: { provider: Record<string, unknown> };
    greeting?: string;
  };
  tags?: string[];
  mip_opt_out?: boolean;
  flags?: { history?: boolean };
}

export interface FunctionDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  endpoint?: { url: string; method?: string; headers?: Record<string, string> };
}

export interface FunctionCallResponseMessage {
  type: "FunctionCallResponse";
  id: string;
  name: string;
  content: string;
}

export interface InjectAgentMessage {
  type: "InjectAgentMessage";
  message: string;
  behavior?: "default" | "interrupt";
}

export interface KeepAliveMessage {
  type: "KeepAlive";
}

export type ClientMessage =
  | SettingsMessage
  | FunctionCallResponseMessage
  | InjectAgentMessage
  | KeepAliveMessage;

// ── Server → Client ──────────────────────────────────────────────────────────

export interface WelcomeEvent {
  type: "Welcome";
  request_id: string;
}

export interface ConversationTextEvent {
  type: "ConversationText";
  role: "user" | "assistant";
  content: string;
}

export interface FunctionCallRequestEvent {
  type: "FunctionCallRequest";
  functions: Array<{
    id: string;
    name: string;
    arguments: string;
    client_side: boolean;
  }>;
}

export interface AgentStartedSpeakingEvent {
  type: "AgentStartedSpeaking";
  total_latency?: number;
  tts_latency?: number;
  ttt_latency?: number;
}

export interface SimpleEvent {
  type:
    | "SettingsApplied"
    | "UserStartedSpeaking"
    | "AgentThinking"
    | "AgentAudioDone";
  [key: string]: unknown;
}

export interface ErrorEvent {
  type: "Error";
  description?: string;
  code?: string;
  [key: string]: unknown;
}

export type ServerEvent =
  | WelcomeEvent
  | ConversationTextEvent
  | FunctionCallRequestEvent
  | AgentStartedSpeakingEvent
  | SimpleEvent
  | ErrorEvent;
