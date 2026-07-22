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
import type { TtsUsage } from "./types.js";

/**
 * Credit-Bewertung pro Zeichen: Flash- und Turbo-Modelle rechnet ElevenLabs mit
 * 0,5 Credits/Zeichen ab, alle übrigen (z. B. Multilingual v2) mit 1,0.
 */
export function elevenCreditMultiplier(modelId: string): number {
  return /flash|turbo/i.test(modelId) ? 0.5 : 1;
}

export interface ElevenLabsTtsOptions {
  /** Basis-URL bis /v1 (Default produktiv; Tests zeigen auf den Loopback-Server). */
  baseUrl: string;
  apiKey: string;
  voiceId: string;
  modelId: string;
  /** z. B. "pcm_8000" — muss zur System-Sample-Rate passen. */
  outputFormat: string;
  /** Optionaler Feinschliff; unset = Voice-Defaults aus dem ElevenLabs-Dashboard. */
  voiceSettings?: {
    stability?: number;
    similarityBoost?: number;
    /** ElevenLabs erlaubt 0.7–1.2; Werte außerhalb werden geklemmt (warn-Log). */
    speed?: number;
  };
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
  /** Tatsächlich gesendete Zeichen aller text-Felder (= Abrechnungsbasis von ElevenLabs). */
  private charactersSent = 0;
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
        // Kontext initialisieren; voice_settings nur mitsenden, wenn konfiguriert
        // (sonst gelten die Voice-Defaults). Wird bei jedem Lazy-Reconnect erneut
        // gesendet — die Einstellungen überleben damit auch Barge-in-Disconnects.
        const vs = this.wireVoiceSettings();
        ws.send(JSON.stringify({ text: " ", ...(vs ? { voice_settings: vs } : {}) }));
        this.charactersSent += 1; // Init-Space wird berechnet
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

  /** voice_settings ins Wire-Format mappen; speed auf den erlaubten Bereich klemmen. */
  private wireVoiceSettings(): Record<string, number> | undefined {
    const vs = this.opts.voiceSettings;
    if (!vs) return undefined;
    const out: Record<string, number> = {};
    if (vs.stability !== undefined) out.stability = vs.stability;
    if (vs.similarityBoost !== undefined) out.similarity_boost = vs.similarityBoost;
    if (vs.speed !== undefined) {
      const clamped = Math.min(1.2, Math.max(0.7, vs.speed));
      if (clamped !== vs.speed) {
        this.log.warn("speak.speed außerhalb 0.7–1.2 — geklemmt", { speed: vs.speed, clamped });
      }
      out.speed = clamped;
    }
    return Object.keys(out).length ? out : undefined;
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
    const wire = text.endsWith(" ") ? text : `${text} `;
    this.charactersSent += wire.length;
    this.ws.send(JSON.stringify({ text: wire }));
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
      this.charactersSent += 1;
    }
  }

  /** Gesendeter Verbrauch inkl. Credit-Umrechnung (Flash/Turbo: 0,5 Credits/Zeichen). */
  usage(): TtsUsage {
    return {
      provider: "eleven_labs",
      model: this.opts.modelId,
      characters: this.charactersSent,
      credits: this.charactersSent * elevenCreditMultiplier(this.opts.modelId),
    };
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
