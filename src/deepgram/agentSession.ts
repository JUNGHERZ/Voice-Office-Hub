/**
 * Wrapper um eine Deepgram-Voice-Agent-WebSocket-Session (eine pro Anruf).
 * Verantwortlich für: Verbindungsaufbau, Settings senden, Event-Loop, KeepAlive.
 *
 * Audio-Bridging: Anrufer-Audio rein via `sendAudio()`, TTS-Audio raus via "audio"-Event.
 */
import { EventEmitter } from "node:events";

import WebSocket from "ws";

import { config } from "../config.js";
import { logger } from "../util/logger.js";
import type {
  ConversationTextEvent,
  FunctionCallRequestEvent,
  SettingsMessage,
} from "./events.js";

const KEEPALIVE_INTERVAL_MS = 8_000;

export interface AgentSessionEvents {
  open: () => void;
  welcome: (requestId: string) => void;
  settingsApplied: () => void;
  audio: (chunk: Buffer) => void;
  conversationText: (ev: ConversationTextEvent) => void;
  functionCallRequest: (ev: FunctionCallRequestEvent) => void;
  userStartedSpeaking: () => void;
  agentStartedSpeaking: (latency: { total?: number; tts?: number; ttt?: number }) => void;
  agentAudioDone: () => void;
  error: (description: string) => void;
  close: (code: number) => void;
}

export declare interface AgentSession {
  on<E extends keyof AgentSessionEvents>(event: E, listener: AgentSessionEvents[E]): this;
  emit<E extends keyof AgentSessionEvents>(event: E, ...args: Parameters<AgentSessionEvents[E]>): boolean;
}

export class AgentSession extends EventEmitter {
  private ws: WebSocket;
  private keepAlive?: NodeJS.Timeout;
  private readonly log;

  constructor(private readonly settings: SettingsMessage, callId: string) {
    super();
    this.log = logger.child({ mod: "dg", callId });
    this.ws = new WebSocket(config.deepgram.agentUrl, {
      headers: { Authorization: `Token ${config.deepgram.apiKey}` },
    });
    this.ws.binaryType = "nodebuffer";
    this.wire();
  }

  private wire(): void {
    this.ws.on("open", () => {
      this.log.info("Deepgram-WS offen → Settings senden");
      this.ws.send(JSON.stringify(this.settings));
      this.keepAlive = setInterval(() => this.sendKeepAlive(), KEEPALIVE_INTERVAL_MS);
      this.emit("open");
    });

    this.ws.on("message", (data: WebSocket.RawData, isBinary: boolean) => {
      if (isBinary) {
        this.emit("audio", data as Buffer);
        return;
      }
      this.handleControl(data.toString());
    });

    this.ws.on("error", (err) => {
      this.log.error("Deepgram-WS-Fehler", { err: String(err) });
      this.emit("error", String(err));
    });

    this.ws.on("close", (code) => {
      if (this.keepAlive) clearInterval(this.keepAlive);
      this.log.info("Deepgram-WS geschlossen", { code });
      this.emit("close", code);
    });
  }

  private handleControl(raw: string): void {
    let msg: { type?: string; [k: string]: unknown };
    try {
      msg = JSON.parse(raw);
    } catch {
      this.log.warn("Nicht-JSON-Control-Nachricht", { raw });
      return;
    }
    switch (msg.type) {
      case "Welcome":
        this.emit("welcome", String(msg.request_id ?? ""));
        break;
      case "SettingsApplied":
        this.emit("settingsApplied");
        break;
      case "ConversationText":
        this.emit("conversationText", msg as unknown as ConversationTextEvent);
        break;
      case "FunctionCallRequest":
        this.emit("functionCallRequest", msg as unknown as FunctionCallRequestEvent);
        break;
      case "UserStartedSpeaking":
        this.emit("userStartedSpeaking");
        break;
      case "AgentStartedSpeaking":
        this.emit("agentStartedSpeaking", {
          total: msg.total_latency as number | undefined,
          tts: msg.tts_latency as number | undefined,
          ttt: msg.ttt_latency as number | undefined,
        });
        break;
      case "AgentAudioDone":
        this.emit("agentAudioDone");
        break;
      case "Error":
        this.emit("error", String(msg.description ?? "unbekannter Fehler"));
        break;
      default:
        this.log.debug("Unbehandeltes Event", { type: msg.type });
    }
  }

  /** Anrufer-Audio (raw PCM) an Deepgram weiterreichen. */
  sendAudio(chunk: Buffer): void {
    if (this.ws.readyState === WebSocket.OPEN) this.ws.send(chunk);
  }

  /** Antwort auf einen client_side FunctionCallRequest. */
  sendFunctionResponse(id: string, name: string, content: unknown): void {
    this.send({ type: "FunctionCallResponse", id, name, content: JSON.stringify(content) });
  }

  /** Agent eine vorgegebene Nachricht sprechen lassen (z.B. Transfer-Fehlschlag). */
  injectMessage(message: string, behavior: "default" | "interrupt" = "default"): void {
    this.send({ type: "InjectAgentMessage", message, behavior });
  }

  private sendKeepAlive(): void {
    this.send({ type: "KeepAlive" });
  }

  private send(obj: unknown): void {
    if (this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(obj));
  }

  close(): void {
    if (this.keepAlive) clearInterval(this.keepAlive);
    if (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING) {
      this.ws.close();
    }
  }
}
