/**
 * Geteilter, persistenter AudioSocket-Server (TCP). Ein einziger Server für alle Anrufe;
 * eingehende Verbindungen werden über die zuerst gesendete UUID dem passenden Anruf zugeordnet.
 * Das behebt das EADDRINUSE-Problem bei Parallelanrufen (kein Server pro Anruf mehr).
 *
 * AudioSocket-Protokoll: [1 Byte Typ][2 Byte Länge BE][payload].
 *   0x01 = UUID (16 Byte), 0x10 = Audio (slin), 0x00 = Terminate, 0xff = Error.
 *
 * Pro Anruf registriert der callHandler eine UUID und erhält eine MediaSession
 * (Interface kompatibel zur RTP-MediaBridge: start/on('audio')/sendAudio/flush/close/enableRawEcho).
 */
import { EventEmitter } from "node:events";
import net from "node:net";

import { config } from "../config.js";
import { logger } from "../util/logger.js";

export const KIND_TERMINATE = 0x00;
export const KIND_UUID = 0x01;
export const KIND_AUDIO = 0x10;
export const KIND_ERROR = 0xff;
const HEADER_BYTES = 3;
const MAX_PAYLOAD = 65535;

export interface AudioSocketFrame {
  kind: number;
  payload: Buffer;
}

/**
 * Reiner AudioSocket-Frame-Parser: zerlegt einen (TCP-)Puffer in vollständige Nachrichten
 * und gibt den unvollständigen Rest zurück. Bewusst seiteneffektfrei → unit-testbar.
 */
export function parseFrames(buf: Buffer): { frames: AudioSocketFrame[]; rest: Buffer } {
  const frames: AudioSocketFrame[] = [];
  let offset = 0;
  while (buf.length - offset >= HEADER_BYTES) {
    const kind = buf.readUInt8(offset);
    const len = buf.readUInt16BE(offset + 1);
    if (buf.length - offset < HEADER_BYTES + len) break; // Nachricht unvollständig
    const payload = buf.subarray(offset + HEADER_BYTES, offset + HEADER_BYTES + len);
    frames.push({ kind, payload });
    offset += HEADER_BYTES + len;
  }
  return { frames, rest: offset > 0 ? buf.subarray(offset) : buf };
}

/** Baut eine AudioSocket-Audio-Nachricht (0x10) inkl. Header. */
export function buildAudioFrame(payload: Buffer): Buffer {
  const header = Buffer.alloc(HEADER_BYTES);
  header.writeUInt8(KIND_AUDIO, 0);
  header.writeUInt16BE(payload.length, 1);
  return Buffer.concat([header, payload]);
}

const FRAME_MS = 20;
const FRAME_BYTES = (config.audio.sampleRate * 2 * FRAME_MS) / 1000;

export interface MediaSessionEvents {
  audio: (pcm: Buffer) => void;
}

export declare interface MediaSession {
  on<E extends keyof MediaSessionEvents>(event: E, listener: MediaSessionEvents[E]): this;
  emit<E extends keyof MediaSessionEvents>(event: E, ...args: Parameters<MediaSessionEvents[E]>): boolean;
}

/** Pro Anruf: bündelt Socket-Anbindung + Audio-I/O für eine AudioSocket-UUID. */
export class MediaSession extends EventEmitter {
  private socket?: net.Socket;
  private sendBuffer: Buffer = Buffer.alloc(0);
  private rawEcho = false;
  private closed = false;
  private readonly log;

  constructor(
    readonly uuid: string,
    callId: string,
    private readonly onClose: (uuid: string) => void,
  ) {
    super();
    this.log = logger.child({ mod: "audiosocket", callId, uuid });
  }

  /** No-op: der geteilte Server lauscht bereits. */
  async start(): Promise<void> {}

  enableRawEcho(): void {
    this.rawEcho = true;
  }

  /** Vom Server aufgerufen, sobald die passende Verbindung da ist. */
  attach(socket: net.Socket): void {
    this.socket = socket;
    this.log.info("AudioSocket-Verbindung zugeordnet");
  }

  /** Vom Server pro empfangenem Audio-Frame aufgerufen. */
  handleAudio(payload: Buffer): void {
    if (this.closed) return;
    if (this.rawEcho) this.writeAudio(payload);
    else this.emit("audio", Buffer.from(payload));
  }

  /** PCM in slin-Frames an Asterisk schreiben. */
  sendAudio(pcm: Buffer): void {
    if (this.closed) return;
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
    if (!this.socket || this.socket.destroyed) return;
    for (let off = 0; off < payload.length; off += MAX_PAYLOAD) {
      const chunk = payload.subarray(off, Math.min(off + MAX_PAYLOAD, payload.length));
      this.socket.write(buildAudioFrame(chunk));
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    try {
      this.socket?.destroy();
    } catch {
      /* ignore */
    }
    this.onClose(this.uuid);
  }
}

export class AudioSocketServer {
  private server?: net.Server;
  private readonly sessions = new Map<string, MediaSession>();
  private readonly log = logger.child({ mod: "audiosocket-server" });

  async start(port = config.audio.externalMediaPort): Promise<void> {
    if (this.server) return;
    this.server = net.createServer((socket) => this.onConnection(socket));
    this.server.on("error", (err) => this.log.error("Server-Fehler", { err: String(err) }));
    await new Promise<void>((resolve) => {
      this.server!.listen(port, config.audio.externalMediaHost, () => {
        this.log.info("AudioSocket-Server lauscht", { port });
        resolve();
      });
    });
  }

  /** Anruf registrieren; liefert die MediaSession, an die die UUID-Verbindung gebunden wird. */
  register(uuid: string, callId: string): MediaSession {
    const session = new MediaSession(uuid, callId, (u) => this.sessions.delete(u));
    this.sessions.set(uuid, session);
    return session;
  }

  private onConnection(socket: net.Socket): void {
    let buf: Buffer = Buffer.alloc(0);
    let session: MediaSession | undefined;

    socket.on("data", (chunk) => {
      buf = buf.length ? Buffer.concat([buf, chunk]) : chunk;
      const { frames, rest } = parseFrames(buf);
      buf = rest;
      for (const { kind, payload } of frames) {
        if (kind === KIND_UUID) {
          const uuid = formatUuid(payload);
          session = this.sessions.get(uuid);
          if (!session) {
            this.log.warn("Verbindung mit unbekannter UUID — schließe", { uuid });
            socket.destroy();
            return;
          }
          session.attach(socket);
        } else if (kind === KIND_AUDIO) {
          session?.handleAudio(payload);
        } else if (kind === KIND_TERMINATE) {
          this.log.debug("Terminate empfangen");
        } else if (kind === KIND_ERROR) {
          this.log.warn("AudioSocket-Fehler-Nachricht");
        }
      }
    });

    socket.on("error", (err) => this.log.warn("Socket-Fehler", { err: String(err) }));
    socket.on("close", () => this.log.debug("Verbindung geschlossen"));
  }

  async stop(): Promise<void> {
    for (const s of this.sessions.values()) s.close();
    this.sessions.clear();
    await new Promise<void>((resolve) => (this.server ? this.server.close(() => resolve()) : resolve()));
    this.server = undefined;
  }
}

/** Wandelt 16 rohe Bytes in die kanonische UUID-Schreibweise (mit Bindestrichen). */
function formatUuid(raw: Buffer): string {
  const hex = raw.toString("hex");
  if (hex.length !== 32) return hex;
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export const audioSocketServer = new AudioSocketServer();
