/**
 * Aura-Streaming-TTS-Client (Deepgram Speak-WS) für die NativeSession.
 * Liefert rohes PCM (linear16, config-Sample-Rate) als `audio`-Events.
 *
 * Barge-in-Quarantäne Schicht 1: Nach `clear()` werden Binärframes unterdrückt,
 * bis der Server `Cleared` bestätigt (live verifiziert 2026-07-21: der Server
 * verwirft danach tatsächlich alles Gepufferte). Schicht 2 (Generationszähler)
 * liegt im Orchestrator.
 *
 * Idle-Robustheit: Die Speak-WS kann in langen Hörphasen serverseitig schließen —
 * sendText() verbindet dann lazy neu und puffert Texte bis zum open.
 */
import { EventEmitter } from "node:events";

import WebSocket from "ws";

import { logger } from "../util/logger.js";
import type { AuraServerMessage, TtsUsage } from "./types.js";

export interface TtsStreamOptions {
  url: string;
  apiKey: string;
  model: string;
  encoding: string;
  sampleRate: number;
}

export interface TtsStreamEvents {
  audio: (chunk: Buffer) => void;
  /** Server hat den Flush verarbeitet — das Turn-Audio ist vollständig übergeben. */
  flushed: (sequenceId: number | undefined) => void;
  error: (description: string) => void;
  close: (code: number) => void;
}

export declare interface AuraTtsStream {
  on<E extends keyof TtsStreamEvents>(event: E, listener: TtsStreamEvents[E]): this;
  emit<E extends keyof TtsStreamEvents>(event: E, ...args: Parameters<TtsStreamEvents[E]>): boolean;
}

export class AuraTtsStream extends EventEmitter {
  private ws?: WebSocket;
  private connecting?: Promise<void>;
  private closed = false;
  /** Erst nach dem ersten erfolgreichen open emittet wire() error/close —
   *  Verbindungsfehler davor laufen über das connect()-Reject. */
  private everOpened = false;
  /** Clear gesendet, Cleared noch nicht da → Binärframes unterdrücken. */
  private clearing = false;
  /** Texte, die während eines (Re-)Connects ankamen. */
  private pending: string[] = [];
  /** Tatsächlich gesendete Zeichen (= Abrechnungsbasis; gedroppte pending-Texte zählen nicht). */
  private charactersSent = 0;
  private readonly log;

  constructor(
    private readonly opts: TtsStreamOptions,
    callId: string,
  ) {
    super();
    this.log = logger.child({ mod: "native-tts", callId });
  }

  buildUrl(): string {
    const u = new URL(this.opts.url);
    u.searchParams.set("model", this.opts.model);
    u.searchParams.set("encoding", this.opts.encoding);
    u.searchParams.set("sample_rate", String(this.opts.sampleRate));
    u.searchParams.set("container", "none");
    return u.toString();
  }

  async start(): Promise<void> {
    if (this.closed) return;
    await this.connect();
  }

  private connect(): Promise<void> {
    if (this.ws?.readyState === WebSocket.OPEN) return Promise.resolve();
    this.connecting ??= new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(this.buildUrl(), {
        headers: { Authorization: `Token ${this.opts.apiKey}` },
      });
      ws.binaryType = "nodebuffer";
      this.ws = ws;
      this.wire(ws);
      const onOpen = () => {
        cleanup();
        this.connecting = undefined;
        this.everOpened = true;
        // Während des Connects aufgelaufene Sätze nachschieben (Reihenfolge bleibt).
        for (const text of this.pending.splice(0)) this.rawSend({ type: "Speak", text });
        resolve();
      };
      const onError = (err: Error) => {
        cleanup();
        this.connecting = undefined;
        reject(new Error(`Aura-TTS-Verbindung fehlgeschlagen: ${err.message}`));
      };
      const onClose = (code: number) => {
        cleanup();
        this.connecting = undefined;
        reject(new Error(`Aura-TTS-Verbindung vor open geschlossen (Code ${code})`));
      };
      const cleanup = () => {
        ws.off("open", onOpen);
        ws.off("error", onError);
        ws.off("close", onClose);
      };
      ws.on("open", onOpen);
      ws.on("error", onError);
      ws.on("close", onClose);
    });
    return this.connecting;
  }

  private wire(ws: WebSocket): void {
    ws.on("message", (data: Buffer, isBinary: boolean) => {
      if (isBinary) {
        if (!this.clearing) this.emit("audio", data);
        return;
      }
      let msg: AuraServerMessage;
      try {
        msg = JSON.parse(data.toString()) as AuraServerMessage;
      } catch {
        return;
      }
      switch (msg.type) {
        case "Cleared":
          this.clearing = false;
          break;
        case "Flushed":
          this.emit("flushed", msg.sequence_id);
          break;
        case "Warning":
          this.log.warn("Aura-Warnung", { description: msg.description });
          break;
        default:
          break; // Metadata u. a.
      }
    });
    ws.on("error", (err) => {
      if (this.everOpened && !this.closed) this.emit("error", String(err));
    });
    ws.on("close", (code) => {
      if (this.ws === ws) this.ws = undefined;
      if (this.everOpened && !this.closed) this.emit("close", code);
    });
  }

  private rawSend(payload: Record<string, unknown>): void {
    if (this.ws?.readyState !== WebSocket.OPEN) return;
    if (payload.type === "Speak" && typeof payload.text === "string") {
      this.charactersSent += payload.text.length;
    }
    this.ws.send(JSON.stringify(payload));
  }

  /** Gesendeter Verbrauch (Deepgram rechnet Aura pro Zeichen ab). */
  usage(): TtsUsage {
    return { provider: "deepgram", model: this.opts.model, characters: this.charactersSent };
  }

  sendText(text: string): void {
    if (this.closed || !text) return;
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.rawSend({ type: "Speak", text });
      return;
    }
    // Idle-Drop o. Ä.: Text puffern und lazy neu verbinden.
    this.pending.push(text);
    this.connect().catch((err) => this.emit("error", String(err)));
  }

  flush(): void {
    this.rawSend({ type: "Flush" });
  }

  /** Barge-in: serverseitig verwerfen + eingehende Frames bis `Cleared` unterdrücken. */
  clear(): void {
    this.pending = [];
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.clearing = true;
      this.rawSend({ type: "Clear" });
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    try {
      this.rawSend({ type: "Close" });
      this.ws?.close();
    } catch {
      /* ignore */
    }
  }
}
