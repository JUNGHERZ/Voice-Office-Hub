/**
 * Flux-TTS-Client (Deepgram Speak-WS v2) für die NativeSession.
 *
 * ACHTUNG, Namensgleichheit: Deepgram nennt sowohl das v2-LISTEN-Modell als auch
 * die v2-SPEAK-API "Flux". `FluxSttStream` (sttStream.ts) und `FluxTtsStream`
 * hier haben nichts miteinander zu tun außer dem Anbieter.
 *
 * Wire-Format (Doku-Stand 2026-08-18, nicht live gegengeprüft):
 *   wss://api.deepgram.com/v2/speak?model=flux-haley-en&encoding=…&sample_rate=…
 *   →  {"type":"Speak","text":"…"} · {"type":"Flush"} · {"type":"Close"}
 *      {"type":"Configure","speed":1.05}
 *      {"type":"Interrupt","playback_offset":{"type":"time_ms","value":2340}}
 *   ←  {"type":"Connected"} · {"type":"SpeechStarted","speech_id":"…"}
 *      Binärframes (PCM) · {"type":"Flushed","speech_id":"…"}
 *      {"type":"SpeechInterrupted","audio_played_ms":…,"text_spoken":"…","text_remaining":"…"}
 *      {"type":"SpeechMetadata","billable_character_count":…} · Warning · Error
 *
 * Unterschiede zu Aura, die den Aufbau prägen:
 *  - Audio fließt erst nach `Flush`. Ein `Speak` allein erzeugt nur `SpeechStarted`
 *    und wartet (live gemessen 2026-08-18) — anders als bei Aura, das sofort
 *    losspricht. Der Satz-Chunker ruft ohnehin flush() je Turn.
 *  - `Flushed` ist NICHT das Turn-Ende, sondern die Empfangsbestätigung des
 *    Flush; das Audio beginnt danach. Das Ende meldet `SpeechMetadata`. Genau
 *    darauf liegt deshalb das `flushed`-Event dieses Clients.
 *  - Es gibt KEIN `Clear`. Barge-in läuft über `Interrupt`, bestätigt wird mit
 *    `SpeechInterrupted` — das zugleich meldet, was der Anrufer wirklich gehört
 *    hat. Genau dafür reicht der Orchestrator `unplayedMs` durch.
 *  - Inaktivitäts-Timeout 60 s (Aura hält länger). Hörphasen sind regelmäßig
 *    länger, deshalb ein WS-Ping alle 25 s; der Lazy-Reconnect bleibt das Netz
 *    darunter.
 *  - `speed` wird nicht per URL, sondern per `Configure` gesetzt — und nach
 *    JEDEM (Re-)Connect erneut, sonst gilt sie nach einem Idle-Drop nicht mehr.
 */
import { EventEmitter } from "node:events";

import WebSocket from "ws";

import { logger } from "../util/logger.js";
import type { FluxTtsServerMessage, TtsStreamEvents, TtsUsage } from "./types.js";

/** Flux akzeptiert 0,85–1,15 in 0,05-Schritten; alles andere lehnt der Server ab. */
export function clampFluxSpeed(speed: number): number {
  const stepped = Math.round(speed / 0.05) * 0.05;
  return Math.min(1.15, Math.max(0.85, Number(stepped.toFixed(2))));
}

/** Hörphasen überdauern den 60-s-Timeout nur mit Ping. */
const PING_INTERVAL_MS = 25_000;
/**
 * Notbremse für die Barge-in-Quarantäne: Bleibt `SpeechInterrupted` aus, gäbe
 * die Unterdrückung sonst nie wieder frei — der Anruf wäre dauerhaft stumm.
 * Eine Warnzeile ist allemal besser als ein toter Kanal.
 */
const INTERRUPT_WATCHDOG_MS = 1_500;

export interface FluxTtsOptions {
  url: string;
  apiKey: string;
  /** Modellname = Stimme, z. B. "flux-haley-en". */
  model: string;
  encoding: string;
  sampleRate: number;
  /** Optional; wird per Configure gesetzt und auf das Raster geklemmt. */
  speed?: number;
}

export declare interface FluxTtsStream {
  on<E extends keyof TtsStreamEvents>(event: E, listener: TtsStreamEvents[E]): this;
  emit<E extends keyof TtsStreamEvents>(event: E, ...args: Parameters<TtsStreamEvents[E]>): boolean;
}

export class FluxTtsStream extends EventEmitter {
  private ws?: WebSocket;
  private connecting?: Promise<void>;
  private closed = false;
  private everOpened = false;
  /** Flux truncatet serverseitig und meldet den gesprochenen Text selbst. */
  readonly reportsSpokenText = true;
  /** Interrupt gesendet, SpeechInterrupted noch nicht da → Binärframes unterdrücken. */
  private interrupting = false;
  private interruptTimer?: NodeJS.Timeout;
  private pingTimer?: NodeJS.Timeout;
  private pending: string[] = [];
  private charactersSent = 0;
  /** Vom Server gemeldete Abrechnungszeichen — genauer als die lokale Zählung. */
  private billableCharacters = 0;
  /**
   * Läuft gerade eine Äußerung? Ohne diesen Guard schickten wir bei JEDEM
   * speechStarted ein Interrupt — auch wenn der Agent schwieg. Der Server
   * antwortete dann nicht, und die Quarantäne bliebe für immer stehen.
   */
  private speaking = false;
  /** Ausgegebene Audio-Bytes der laufenden Äußerung (Basis für playback_offset). */
  private emittedBytes = 0;
  private readonly log;

  constructor(
    private readonly opts: FluxTtsOptions,
    callId: string,
  ) {
    super();
    this.log = logger.child({ mod: "native-tts-flux", callId });
  }

  buildUrl(): string {
    const u = new URL(this.opts.url);
    u.searchParams.set("model", this.opts.model);
    u.searchParams.set("encoding", this.opts.encoding);
    u.searchParams.set("sample_rate", String(this.opts.sampleRate));
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
        // Nach jedem (Re-)Connect: Sprechtempo neu setzen und den Ping anwerfen.
        this.sendConfigure();
        this.armPing(ws);
        for (const text of this.pending.splice(0)) this.rawSend({ type: "Speak", text });
        resolve();
      };
      const onError = (err: Error) => {
        cleanup();
        this.connecting = undefined;
        reject(new Error(`Flux-TTS-Verbindung fehlgeschlagen: ${err.message}`));
      };
      const onClose = (code: number) => {
        cleanup();
        this.connecting = undefined;
        reject(new Error(`Flux-TTS-Verbindung vor open geschlossen (Code ${code})`));
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

  private armPing(ws: WebSocket): void {
    clearInterval(this.pingTimer);
    const t = setInterval(() => {
      if (ws.readyState === WebSocket.OPEN) ws.ping();
    }, PING_INTERVAL_MS);
    t.unref?.(); // ein vergessener Ping darf die Event-Loop nie aufhalten
    this.pingTimer = t;
  }

  private sendConfigure(): void {
    if (this.opts.speed === undefined) return;
    const speed = clampFluxSpeed(this.opts.speed);
    if (speed !== this.opts.speed) {
      this.log.warn("speak.speed auf das Flux-Raster geklemmt", { speed: this.opts.speed, clamped: speed });
    }
    this.rawSend({ type: "Configure", speed });
  }

  private releaseInterrupt(): void {
    this.interrupting = false;
    clearTimeout(this.interruptTimer);
    this.interruptTimer = undefined;
  }

  private wire(ws: WebSocket): void {
    ws.on("message", (data: Buffer, isBinary: boolean) => {
      if (isBinary) {
        if (this.interrupting) return; // Quarantäne nach Barge-in
        this.emittedBytes += data.length;
        this.emit("audio", data);
        return;
      }
      let msg: FluxTtsServerMessage;
      try {
        msg = JSON.parse(data.toString()) as FluxTtsServerMessage;
      } catch {
        return;
      }
      switch (msg.type) {
        case "SpeechStarted":
          // Neue Äußerung: was vorher quarantäniert war, ist damit erledigt.
          this.releaseInterrupt();
          this.speaking = true;
          this.emittedBytes = 0;
          break;
        case "SpeechInterrupted":
          this.releaseInterrupt();
          this.speaking = false;
          this.emit("interrupted", {
            spokenText: msg.text_spoken ?? "",
            audioPlayedMs: msg.audio_played_ms ?? 0,
          });
          break;
        case "Flushed":
          // NICHT das Turn-Ende. Live gemessen 2026-08-18: `Flushed` bestätigt nur,
          // dass die Flush-Anforderung angekommen ist — das Audio beginnt DANACH.
          // Wer hier `flushed` emittierte, meldete das Turn-Ende, bevor der erste
          // Ton gespielt wurde.
          break;
        case "SpeechMetadata":
          // DAS ist das Turn-Ende: laut Doku "after we've sent all of the turn's
          // audio", und live genau so beobachtet (nach dem letzten Binärframe).
          if (typeof msg.billable_character_count === "number") {
            this.billableCharacters += msg.billable_character_count;
          }
          this.speaking = false;
          this.emit("flushed", undefined);
          break;
        case "ConfigureFailure":
          this.log.warn("Flux-Configure abgelehnt", { code: msg.code, description: msg.description });
          break;
        case "Warning":
          this.log.warn("Flux-Warnung", { code: msg.code, description: msg.description });
          break;
        case "Error":
          // Anders als Aura kennt Flux einen eigenen Fehlertyp; er wird immer
          // von einem Verbindungsabbau gefolgt.
          if (this.everOpened && !this.closed) this.emit("error", msg.description ?? "Flux-Fehler");
          break;
        default:
          break; // Connected, SessionMetadata, ConfigureSuccess …
      }
    });
    ws.on("error", (err) => {
      if (this.everOpened && !this.closed) this.emit("error", String(err));
    });
    ws.on("close", (code) => {
      if (this.ws === ws) this.ws = undefined;
      clearInterval(this.pingTimer);
      this.speaking = false;
      this.releaseInterrupt();
      if (this.everOpened && !this.closed) this.emit("close", code);
    });
  }

  private rawSend(payload: Record<string, unknown>): void {
    if (this.ws?.readyState !== WebSocket.OPEN) return;
    if (payload.type === "Speak" && typeof payload.text === "string") {
      this.charactersSent += payload.text.length;
      this.speaking = true;
    }
    this.ws.send(JSON.stringify(payload));
  }

  /** Server-Zählung bevorzugen; die lokale ist nur der Rückfall. */
  usage(): TtsUsage {
    return {
      provider: "deepgram_flux",
      model: this.opts.model,
      characters: this.billableCharacters || this.charactersSent,
    };
  }

  sendText(text: string): void {
    if (this.closed || !text) return;
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.rawSend({ type: "Speak", text });
      return;
    }
    this.pending.push(text);
    this.connect().catch((err) => this.emit("error", String(err)));
  }

  flush(): void {
    this.rawSend({ type: "Flush" });
  }

  /**
   * Barge-in. `playback_offset` ist die tatsächlich GEHÖRTE Zeit, nicht die
   * gesendete: Zwischen beiden liegt der Playout-Puffer der Medienstrecke, bei
   * langen Sätzen mehrere Sekunden. Ohne die Korrektur meldete der Server ein zu
   * langes `text_spoken` zurück — und die Historie behauptete Sätze, die der
   * Anrufer nie gehört hat. Das wäre schlechter als gar keine Kürzung.
   */
  clear(unplayedMs = 0): void {
    this.pending = [];
    if (!this.speaking || this.ws?.readyState !== WebSocket.OPEN) return;
    const emittedMs = (this.emittedBytes / 2 / this.opts.sampleRate) * 1000;
    const playedMs = Math.max(0, Math.round(emittedMs - unplayedMs));
    this.interrupting = true;
    const t = setTimeout(() => {
      this.log.warn("SpeechInterrupted blieb aus — Quarantäne wird freigegeben");
      this.releaseInterrupt();
    }, INTERRUPT_WATCHDOG_MS);
    t.unref?.();
    this.interruptTimer = t;
    this.rawSend({ type: "Interrupt", playback_offset: { type: "time_ms", value: playedMs } });
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    clearInterval(this.pingTimer);
    this.releaseInterrupt();
    try {
      this.rawSend({ type: "Close" });
      this.ws?.close();
    } catch {
      /* ignore */
    }
  }
}
