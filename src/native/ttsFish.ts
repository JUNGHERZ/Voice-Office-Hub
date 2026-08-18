/**
 * Fish-Audio-S2-Client (Live-TTS-WebSocket) als vierte Streaming-Variante.
 *
 * Wire-Format (Doku-Stand 2026-08-18, NICHT live gegengeprüft — kein Schlüssel
 * vorhanden). Anders als alle übrigen Anbieter serialisiert Fish mit MessagePack,
 * nicht mit JSON:
 *   wss://api.fish.audio/v1/tts/live   Authorization: Bearer <key>, model: s2.1-pro
 *   →  {event:"start", request:{text:"", reference_id, format:"pcm", sample_rate, …}}
 *      {event:"text", text:"…"} · {event:"flush"} · {event:"stop"}
 *   ←  {event:"audio", audio:<binär>} · {event:"finish", reason:"stop"|"error"}
 *
 * Vorbild ist ttsElevenLabs.ts, nicht ttsStream.ts: Fish kennt kein
 * serverseitiges Clear, deshalb trennt clear() die Verbindung hart und der
 * nächste Satz verbindet lazy neu — samt erneutem start-Event.
 *
 * ABRECHNUNG in UTF-8-BYTES, nicht in Zeichen: deutsche Umlaute und ß kosten
 * doppelt. Wer hier Zeichen zählte, unterschätzte die Kosten systematisch.
 *
 * UNGEPRÜFT: ob `sample_rate: 8000` bei `format: "pcm"` akzeptiert wird. Die
 * Doku nennt 44100 als Default und listet keine erlaubten Werte. Wird der Wert
 * ignoriert, käme Audio in falscher Rate an — hörbar als zu schnelle oder zu
 * langsame Sprache. Deshalb ist der Provider per FISH_AUDIO_ENABLED
 * standardmäßig AUS.
 */
import { EventEmitter } from "node:events";

import { decode, encode } from "@msgpack/msgpack";
import WebSocket from "ws";

import { logger } from "../util/logger.js";
import type { TtsStreamEvents, TtsUsage } from "./types.js";

export type FishLatencyMode = "normal" | "balanced" | "low";

export interface FishTtsOptions {
  url: string;
  apiKey: string;
  /** s2.1-pro (Default) | s2-pro | s1 — geht als Header mit. */
  model: string;
  /** Stimm-Modell-ID von fish.audio. */
  referenceId: string;
  sampleRate: number;
  /** "low" ist für Telefonie richtig; Qualitätsgewinn der übrigen zahlt sich hier nicht aus. */
  latency: FishLatencyMode;
  temperature?: number;
  topP?: number;
  speed?: number;
  volume?: number;
}

interface FishServerEvent {
  event?: string;
  audio?: Uint8Array;
  reason?: string;
  message?: string;
}

export declare interface FishTtsStream {
  on<E extends keyof TtsStreamEvents>(event: E, listener: TtsStreamEvents[E]): this;
  emit<E extends keyof TtsStreamEvents>(event: E, ...args: Parameters<TtsStreamEvents[E]>): boolean;
}

export class FishTtsStream extends EventEmitter {
  private ws?: WebSocket;
  private connecting?: Promise<void>;
  private closed = false;
  private everOpened = false;
  private pending: string[] = [];
  /** Abrechnungsbasis: gesendete UTF-8-Bytes. */
  private bytesSent = 0;
  private charactersSent = 0;
  private readonly log;

  constructor(
    private readonly opts: FishTtsOptions,
    callId: string,
  ) {
    super();
    this.log = logger.child({ mod: "native-tts-fish", callId });
  }

  /** start-Event: alles Konfigurierbare steckt hier, danach fließt nur noch Text. */
  buildStartEvent(): Record<string, unknown> {
    const prosody: Record<string, number> = {};
    if (this.opts.speed !== undefined) prosody.speed = this.opts.speed;
    if (this.opts.volume !== undefined) prosody.volume = this.opts.volume;
    return {
      event: "start",
      request: {
        text: "",
        reference_id: this.opts.referenceId,
        format: "pcm",
        sample_rate: this.opts.sampleRate,
        latency: this.opts.latency,
        ...(this.opts.temperature !== undefined ? { temperature: this.opts.temperature } : {}),
        ...(this.opts.topP !== undefined ? { top_p: this.opts.topP } : {}),
        ...(Object.keys(prosody).length ? { prosody } : {}),
      },
    };
  }

  async start(): Promise<void> {
    if (this.closed) return;
    await this.connect();
  }

  private connect(): Promise<void> {
    if (this.ws?.readyState === WebSocket.OPEN) return Promise.resolve();
    this.connecting ??= new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(this.opts.url, {
        headers: {
          Authorization: `Bearer ${this.opts.apiKey}`,
          model: this.opts.model,
        },
      });
      ws.binaryType = "nodebuffer";
      this.ws = ws;
      this.wire(ws);
      const onOpen = () => {
        cleanup();
        this.connecting = undefined;
        this.everOpened = true;
        // Nach jedem (Re-)Connect muss das start-Event erneut raus — sonst hätte
        // der Server weder Stimme noch Format.
        this.rawSend(this.buildStartEvent());
        for (const text of this.pending.splice(0)) this.sendTextRaw(text);
        resolve();
      };
      const onError = (err: Error) => {
        cleanup();
        this.connecting = undefined;
        reject(new Error(`Fish-TTS-Verbindung fehlgeschlagen: ${err.message}`));
      };
      const onClose = (code: number) => {
        cleanup();
        this.connecting = undefined;
        reject(new Error(`Fish-TTS-Verbindung vor open geschlossen (Code ${code})`));
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
      let msg: FishServerEvent;
      try {
        msg = decode(data) as FishServerEvent;
      } catch {
        return; // kein MessagePack — ignorieren statt den Anruf zu reißen
      }
      if (msg.event === "audio" && msg.audio?.length) {
        this.emit("audio", Buffer.from(msg.audio));
        return;
      }
      if (msg.event === "finish") {
        if (msg.reason === "error") {
          this.log.warn("Fish-Fehler", { reason: msg.reason, message: msg.message });
          if (this.everOpened && !this.closed) this.emit("error", msg.message ?? "Fish-Fehler");
          return;
        }
        this.emit("flushed", undefined);
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
    this.ws.send(encode(payload));
  }

  private sendTextRaw(text: string): void {
    if (this.ws?.readyState !== WebSocket.OPEN) return;
    this.bytesSent += Buffer.byteLength(text, "utf8");
    this.charactersSent += text.length;
    this.rawSend({ event: "text", text });
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
    this.rawSend({ event: "flush" });
  }

  /**
   * Fish rechnet in UTF-8-Bytes ab. `characters` trägt deshalb die BYTES —
   * das Feld ist die Abrechnungsbasis, und eine zeichengenaue Zahl wäre für die
   * Kostenrechnung schlicht falsch (Umlaute zählen doppelt).
   */
  usage(): TtsUsage {
    return { provider: "fish_audio", model: this.opts.model, characters: this.bytesSent };
  }

  /** Barge-in: kein serverseitiges Clear → Verbindung hart trennen (wie ElevenLabs). */
  clear(_unplayedMs?: number): void {
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
      this.rawSend({ event: "stop" });
      this.ws?.close();
    } catch {
      /* ignore */
    }
  }
}
