/**
 * AudioSocket-Transport (TCP) als Alternative zu RTP/externalMedia.
 *
 * AudioSocket ist ein simples, deterministisches Protokoll: Asterisk verbindet sich als
 * TCP-Client zu uns; jede Nachricht ist [1 Byte Typ][2 Byte Länge BE][payload]. Audio ist
 * signed linear 16-bit, mono (Format/Rate = das in externalMedia angeforderte `slin`/`slin16`).
 * Kein Payload-Type/SSRC/Timestamp → Echo = Audio-Payload unverändert zurückschreiben.
 *
 * Gleiches Interface wie MediaBridge (start/on('audio')/sendAudio/flush/close/enableRawEcho),
 * damit der callHandler transportunabhängig bleibt.
 */
import { EventEmitter } from "node:events";
import net from "node:net";

import { config } from "../config.js";
import { logger } from "../util/logger.js";

const KIND_TERMINATE = 0x00;
const KIND_UUID = 0x01;
const KIND_AUDIO = 0x10;
const KIND_ERROR = 0xff;

const FRAME_MS = 20;
const FRAME_BYTES = (config.audio.sampleRate * 2 * FRAME_MS) / 1000;

export interface MediaBridgeEvents {
  audio: (pcm: Buffer) => void;
}

export declare interface AudioSocketBridge {
  on<E extends keyof MediaBridgeEvents>(event: E, listener: MediaBridgeEvents[E]): this;
  emit<E extends keyof MediaBridgeEvents>(event: E, ...args: Parameters<MediaBridgeEvents[E]>): boolean;
}

export class AudioSocketBridge extends EventEmitter {
  private server: net.Server;
  private conn?: net.Socket;
  private buf: Buffer = Buffer.alloc(0);
  private sendBuffer: Buffer = Buffer.alloc(0);
  private rawEcho = false;
  private readonly log;

  constructor(private readonly port: number, callId: string) {
    super();
    this.log = logger.child({ mod: "audiosocket", callId });
    this.server = net.createServer((socket) => this.onConnection(socket));
    this.server.on("error", (err) => this.log.error("TCP-Server-Fehler", { err: String(err) }));
  }

  async start(): Promise<void> {
    await new Promise<void>((resolve) => {
      this.server.listen(this.port, config.audio.externalMediaHost, () => {
        this.log.info("AudioSocket-Server lauscht", { port: this.port });
        resolve();
      });
    });
  }

  enableRawEcho(): void {
    this.rawEcho = true;
  }

  private onConnection(socket: net.Socket): void {
    this.log.info("AudioSocket-Verbindung von Asterisk");
    this.conn = socket;
    socket.on("data", (chunk) => this.onData(chunk));
    socket.on("error", (err) => this.log.warn("Socket-Fehler", { err: String(err) }));
    socket.on("close", () => this.log.info("AudioSocket-Verbindung geschlossen"));
  }

  private onData(chunk: Buffer): void {
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
    // Vollständige Nachrichten aus dem Stream herauslösen.
    while (this.buf.length >= 3) {
      const kind = this.buf.readUInt8(0);
      const len = this.buf.readUInt16BE(1);
      if (this.buf.length < 3 + len) break; // Nachricht noch unvollständig
      const payload = this.buf.subarray(3, 3 + len);
      this.buf = this.buf.subarray(3 + len);
      this.handleMessage(kind, payload);
    }
  }

  private handleMessage(kind: number, payload: Buffer): void {
    switch (kind) {
      case KIND_AUDIO:
        if (this.rawEcho) this.writeAudio(payload);
        else this.emit("audio", Buffer.from(payload));
        break;
      case KIND_UUID:
        this.log.info("AudioSocket UUID empfangen", { uuid: payload.toString("hex") });
        break;
      case KIND_TERMINATE:
        this.log.info("AudioSocket Terminate");
        break;
      case KIND_ERROR:
        this.log.warn("AudioSocket Fehler-Nachricht");
        break;
      default:
        this.log.debug("Unbekannter AudioSocket-Typ", { kind });
    }
  }

  /** PCM in slin-Frames an Asterisk schreiben (0x10-Audio-Nachrichten). */
  sendAudio(pcm: Buffer): void {
    if (!this.conn) return;
    this.sendBuffer = this.sendBuffer.length ? Buffer.concat([this.sendBuffer, pcm]) : pcm;
    while (this.sendBuffer.length >= FRAME_BYTES) {
      const frame = this.sendBuffer.subarray(0, FRAME_BYTES);
      this.sendBuffer = this.sendBuffer.subarray(FRAME_BYTES);
      this.writeAudio(frame);
    }
  }

  flush(): void {
    this.sendBuffer = Buffer.alloc(0);
  }

  private writeAudio(payload: Buffer): void {
    if (!this.conn || this.conn.destroyed) return;
    const header = Buffer.alloc(3);
    header.writeUInt8(KIND_AUDIO, 0);
    header.writeUInt16BE(payload.length, 1);
    this.conn.write(Buffer.concat([header, payload]));
  }

  close(): void {
    try {
      this.conn?.destroy();
    } catch {
      /* ignore */
    }
    try {
      this.server.close();
    } catch {
      /* ignore */
    }
  }
}
