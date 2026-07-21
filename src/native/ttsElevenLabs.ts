/**
 * ElevenLabs-Streaming-TTS-Client (stream-input-WS) als zweite TTS-Implementierung
 * der NativeSession — gleiche Schnittstelle wie AuraTtsStream (sendText/flush/clear,
 * Events audio/flushed/error/close).
 *
 * Wire-Format (verifiziert 2026-07-21 gegen die ElevenLabs-API-Referenz):
 *   Init:   {"text":" ", "voice_settings"?}   Text: {"text":"… "}   Flush: {"text":" ","flush":true}
 *   Ende:   {"text":""}                        Server: {"audio":"<base64>"} / {"isFinal":true}
 *
 * Audio wird als pcm_8000 (linear16 @ 8 kHz) angefordert — passt 1:1 in den Media-Pfad.
 * Barge-in: ElevenLabs kennt kein serverseitiges Clear → clear() trennt die Verbindung
 * hart (verwirft damit alles Gepufferte); der nächste Satz verbindet lazy neu.
 */
import { EventEmitter } from "node:events";

import WebSocket from "ws";

import { logger } from "../util/logger.js";
import type { TtsStreamEvents } from "./ttsStream.js";

export interface ElevenLabsTtsOptions {
  /** Basis-URL bis /v1 (Default produktiv; Tests zeigen auf den Loopback-Server). */
  baseUrl: string;
  apiKey: string;
  voiceId: string;
  modelId: string;
  /** z. B. "pcm_8000" — muss zur System-Sample-Rate passen. */
  outputFormat: string;
}

export declare interface ElevenLabsTtsStream {
  on<E extends keyof TtsStreamEvents>(event: E, listener: TtsStreamEvents[E]): this;
  emit<E extends keyof TtsStreamEvents>(event: E, ...args: Parameters<TtsStreamEvents[E]>): boolean;
}

export class ElevenLabsTtsStream extends EventEmitter {
  private ws?: WebSocket;
  private connecting?: Promise<void>;
  private closed = false;
  private everOpened = false;
  private pending: string[] = [];
  private readonly log;

  constructor(
    private readonly opts: ElevenLabsTtsOptions,
    callId: string,
  ) {
    super();
    this.log = logger.child({ mod: "native-tts-11labs", callId });
  }

  buildUrl(): string {
    const base = this.opts.baseUrl.replace(/\/$/, "");
    const u = new URL(`${base}/text-to-speech/${encodeURIComponent(this.opts.voiceId)}/stream-input`);
    u.searchParams.set("model_id", this.opts.modelId);
    u.searchParams.set("output_format", this.opts.outputFormat);
    // Standard-Idle-Timeout ist knapp (20 s) — Hörphasen sind länger; Rest fängt der Lazy-Reconnect.
    u.searchParams.set("inactivity_timeout", "180");
    u.searchParams.set("auto_mode", "true");
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
        headers: { "xi-api-key": this.opts.apiKey },
      });
      this.ws = ws;
      this.wire(ws);
      const onOpen = () => {
        cleanup();
        this.connecting = undefined;
        this.everOpened = true;
        ws.send(JSON.stringify({ text: " " })); // Kontext initialisieren (Voice-Defaults)
        for (const text of this.pending.splice(0)) this.sendTextRaw(text);
        resolve();
      };
      const onError = (err: Error) => {
        cleanup();
        this.connecting = undefined;
        reject(new Error(`ElevenLabs-TTS-Verbindung fehlgeschlagen: ${err.message}`));
      };
      const onClose = (code: number) => {
        cleanup();
        this.connecting = undefined;
        reject(new Error(`ElevenLabs-TTS-Verbindung vor open geschlossen (Code ${code})`));
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
    ws.on("message", (data: Buffer) => {
      let msg: { audio?: string; isFinal?: boolean | null; error?: string; message?: string };
      try {
        msg = JSON.parse(data.toString()) as typeof msg;
      } catch {
        return;
      }
      if (typeof msg.audio === "string" && msg.audio.length) {
        this.emit("audio", Buffer.from(msg.audio, "base64"));
      }
      if (msg.isFinal === true) this.emit("flushed", undefined);
      if (msg.error) this.log.warn("ElevenLabs-Meldung", { error: msg.error, message: msg.message });
    });
    ws.on("error", (err) => {
      if (this.everOpened && !this.closed) this.emit("error", String(err));
    });
    ws.on("close", (code) => {
      if (this.ws === ws) this.ws = undefined;
      if (this.everOpened && !this.closed) this.emit("close", code);
    });
  }

  private sendTextRaw(text: string): void {
    if (this.ws?.readyState !== WebSocket.OPEN) return;
    // Trailing Space laut API-Konvention (Wortgrenze zwischen Chunks).
    this.ws.send(JSON.stringify({ text: text.endsWith(" ") ? text : `${text} ` }));
  }

  sendText(text: string): void {
    if (this.closed || !text) return;
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.sendTextRaw(text);
      return;
    }
    this.pending.push(text);
    this.connect().catch((err) => this.emit("error", String(err)));
  }

  flush(): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ text: " ", flush: true }));
    }
  }

  /** Barge-in: kein serverseitiges Clear → Verbindung hart trennen (verwirft alles). */
  clear(): void {
    this.pending = [];
    const ws = this.ws;
    this.ws = undefined;
    if (ws) {
      ws.removeAllListeners("message"); // in-flight-Audio des alten Turns stummschalten
      try {
        ws.terminate();
      } catch {
        /* ignore */
      }
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    try {
      if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify({ text: "" }));
      this.ws?.close();
    } catch {
      /* ignore */
    }
  }
}
