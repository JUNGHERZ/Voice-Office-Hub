/**
 * Deepgram-Adapter der provider-neutralen `VoiceAgentSession` (eine pro Anruf).
 * Verantwortlich für: Verbindungsaufbau (in `start()`), Settings senden, Event-Loop,
 * KeepAlive, Mapping der Deepgram-Wire-Events auf die neutralen Session-Events.
 *
 * Audio-Bridging: Anrufer-Audio rein via `sendAudio()`, TTS-Audio raus via "audio"-Event.
 */
import { EventEmitter } from "node:events";

import WebSocket from "ws";

import { config } from "../config.js";
import { logger } from "../util/logger.js";
import type {
  VoiceAgentSession,
  VoiceAgentSessionEvents,
  VoiceConversationText,
} from "../voice/types.js";
import type {
  ConversationTextEvent,
  FunctionCallRequestEvent,
  SettingsMessage,
} from "./events.js";

const KEEPALIVE_INTERVAL_MS = 8_000;

export declare interface AgentSession {
  on<E extends keyof VoiceAgentSessionEvents>(event: E, listener: VoiceAgentSessionEvents[E]): this;
  emit<E extends keyof VoiceAgentSessionEvents>(event: E, ...args: Parameters<VoiceAgentSessionEvents[E]>): boolean;
}

export class AgentSession extends EventEmitter implements VoiceAgentSession {
  private ws?: WebSocket;
  private keepAlive?: NodeJS.Timeout;
  private closed = false;
  private readonly log;

  constructor(private readonly settings: SettingsMessage, callId: string) {
    super();
    this.log = logger.child({ mod: "dg", callId });
  }

  /**
   * Verbindet zur Deepgram Voice Agent API. Resolved nach dem WS-`open` (die Settings
   * sind dann bereits gesendet); rejected, wenn die Verbindung vorher scheitert.
   * Idempotent; nach `close()` ist ein erneuter Start bewusst ein No-op.
   */
  async start(): Promise<void> {
    if (this.ws || this.closed) return;
    const ws = new WebSocket(config.deepgram.agentUrl, {
      headers: { Authorization: `Token ${config.deepgram.apiKey}` },
    });
    ws.binaryType = "nodebuffer";
    this.ws = ws;
    this.wire(ws);

    await new Promise<void>((resolve, reject) => {
      const onOpen = () => { unhook(); resolve(); };
      const onError = (err: Error) => { unhook(); reject(err); };
      const onClose = (code: number) => { unhook(); reject(new Error(`WS vor open geschlossen (code ${code})`)); };
      const unhook = () => {
        ws.off("open", onOpen);
        ws.off("error", onError);
        ws.off("close", onClose);
      };
      // wire() ist bereits registriert → Settings gehen im open-Handler raus, bevor resolved wird.
      ws.on("open", onOpen);
      ws.on("error", onError);
      ws.on("close", onClose);
    });
  }

  private wire(ws: WebSocket): void {
    ws.on("open", () => {
      this.log.info("Deepgram-WS offen → Settings senden");
      ws.send(JSON.stringify(this.settings));
      this.keepAlive = setInterval(() => this.sendKeepAlive(), KEEPALIVE_INTERVAL_MS);
      this.emit("open");
    });

    ws.on("message", (data: WebSocket.RawData, isBinary: boolean) => {
      if (isBinary) {
        this.emit("audio", data as Buffer);
        return;
      }
      this.handleControl(data.toString());
    });

    ws.on("error", (err) => {
      this.log.error("Deepgram-WS-Fehler", { err: String(err) });
      this.emit("error", String(err));
    });

    ws.on("close", (code) => {
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
      case "ConversationText": {
        const ev = msg as unknown as ConversationTextEvent;
        const neutral: VoiceConversationText = { role: ev.role, content: ev.content };
        this.emit("conversationText", neutral);
        break;
      }
      case "FunctionCallRequest": {
        const ev = msg as unknown as FunctionCallRequestEvent;
        this.emit("functionCallRequest", {
          functions: (ev.functions ?? []).map((f) => ({
            id: f.id,
            name: f.name,
            argumentsJson: f.arguments,
            clientSide: f.client_side,
          })),
        });
        break;
      }
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
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(chunk);
  }

  /** Antwort auf einen client_side FunctionCallRequest. */
  sendFunctionResponse(id: string, name: string, result: unknown): void {
    this.send({ type: "FunctionCallResponse", id, name, content: JSON.stringify(result) });
  }

  /** Agent eine vorgegebene Nachricht sprechen lassen (z.B. Transfer-Fehlschlag). */
  injectMessage(message: string, behavior: "default" | "interrupt" = "default"): void {
    this.send({ type: "InjectAgentMessage", message, behavior });
  }

  private sendKeepAlive(): void {
    this.send({ type: "KeepAlive" });
  }

  private send(obj: unknown): void {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(obj));
  }

  close(): void {
    this.closed = true;
    if (this.keepAlive) clearInterval(this.keepAlive);
    if (!this.ws) return;
    if (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING) {
      this.ws.close();
    }
  }
}
