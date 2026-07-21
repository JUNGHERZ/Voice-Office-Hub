/**
 * Flux-Streaming-STT-Client (Deepgram v2-Listen-WS) für die NativeSession.
 * Liefert die Turn-Ereignisse, aus denen der Orchestrator Barge-in und
 * LLM-Starts ableitet. Aufbau spiegelbildlich zu deepgram/agentSession.ts:
 * Konstruktion inert, wire() vor dem open-await, idempotentes start(),
 * No-op nach close().
 */
import { EventEmitter } from "node:events";

import WebSocket from "ws";

import { logger } from "../util/logger.js";
import type { FluxServerMessage, FluxTurnInfo } from "./types.js";

export interface SttStreamOptions {
  url: string;
  apiKey: string;
  model: string;
  sampleRate: number;
  encoding: string;
  languageHints: string[];
  keyterms: string[];
  eotThreshold?: number;
  eotTimeoutMs?: number;
  /** Nur gesetzt, wenn spekulative LLM-Starts gewünscht sind (v1: aus). */
  eagerEotThreshold?: number;
}

export interface SttStreamEvents {
  /** Flux StartOfTurn — Anrufer beginnt zu sprechen (Barge-in-Signal). */
  speechStarted: () => void;
  /** Flux EndOfTurn — finales Transkript des Turns. */
  turnEnded: (transcript: string) => void;
  eagerTurnEnded: (transcript: string) => void;
  turnResumed: () => void;
  error: (description: string) => void;
  close: (code: number) => void;
}

export declare interface FluxSttStream {
  on<E extends keyof SttStreamEvents>(event: E, listener: SttStreamEvents[E]): this;
  emit<E extends keyof SttStreamEvents>(event: E, ...args: Parameters<SttStreamEvents[E]>): boolean;
}

export class FluxSttStream extends EventEmitter {
  private ws?: WebSocket;
  private closed = false;
  /** Erst nach erfolgreichem open emittet wire() error/close — Verbindungsfehler
   *  davor laufen ausschließlich über das start()-Reject (kein Doppel-Kanal). */
  private opened = false;
  private readonly log;

  constructor(
    private readonly opts: SttStreamOptions,
    callId: string,
  ) {
    super();
    this.log = logger.child({ mod: "native-stt", callId });
  }

  buildUrl(): string {
    const u = new URL(this.opts.url);
    u.searchParams.set("model", this.opts.model);
    u.searchParams.set("encoding", this.opts.encoding);
    u.searchParams.set("sample_rate", String(this.opts.sampleRate));
    // language_hint nur beim multilingualen Modell (wiederholter Parameter).
    if (this.opts.model.includes("multi")) {
      for (const hint of this.opts.languageHints) u.searchParams.append("language_hint", hint);
    }
    for (const k of this.opts.keyterms) u.searchParams.append("keyterm", k);
    if (this.opts.eotThreshold !== undefined) u.searchParams.set("eot_threshold", String(this.opts.eotThreshold));
    if (this.opts.eotTimeoutMs !== undefined) u.searchParams.set("eot_timeout_ms", String(this.opts.eotTimeoutMs));
    if (this.opts.eagerEotThreshold !== undefined)
      u.searchParams.set("eager_eot_threshold", String(this.opts.eagerEotThreshold));
    return u.toString();
  }

  async start(): Promise<void> {
    if (this.ws || this.closed) return;
    const ws = new WebSocket(this.buildUrl(), {
      headers: { Authorization: `Token ${this.opts.apiKey}` },
    });
    ws.binaryType = "nodebuffer";
    this.ws = ws;
    this.wire(ws);

    await new Promise<void>((resolve, reject) => {
      const onOpen = () => {
        cleanup();
        this.opened = true;
        resolve();
      };
      const onError = (err: Error) => {
        cleanup();
        reject(new Error(`Flux-STT-Verbindung fehlgeschlagen: ${err.message}`));
      };
      const onClose = (code: number) => {
        cleanup();
        reject(new Error(`Flux-STT-Verbindung vor open geschlossen (Code ${code})`));
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
  }

  private wire(ws: WebSocket): void {
    ws.on("message", (data: Buffer, isBinary: boolean) => {
      if (isBinary) return; // Flux sendet nur JSON-Steuerung
      let msg: FluxServerMessage;
      try {
        msg = JSON.parse(data.toString()) as FluxServerMessage;
      } catch {
        return;
      }
      if (msg.type === "Connected") {
        this.log.debug("Flux verbunden");
        return;
      }
      if (msg.type !== "TurnInfo") return;
      const info = msg as FluxTurnInfo;
      switch (info.event) {
        case "StartOfTurn":
          this.emit("speechStarted");
          break;
        case "EndOfTurn":
          this.emit("turnEnded", info.transcript ?? "");
          break;
        case "EagerEndOfTurn":
          this.emit("eagerTurnEnded", info.transcript ?? "");
          break;
        case "TurnResumed":
          this.emit("turnResumed");
          break;
        default:
          break; // Update u. a. — für uns ohne Belang
      }
    });
    ws.on("error", (err) => {
      if (this.opened && !this.closed) this.emit("error", String(err));
    });
    ws.on("close", (code) => {
      if (this.opened && !this.closed) this.emit("close", code);
    });
  }

  sendAudio(chunk: Buffer): void {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(chunk);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    try {
      if (this.ws?.readyState === WebSocket.OPEN) {
        this.ws.send(JSON.stringify({ type: "CloseStream" }));
      }
      this.ws?.close();
    } catch {
      /* ignore */
    }
  }
}
