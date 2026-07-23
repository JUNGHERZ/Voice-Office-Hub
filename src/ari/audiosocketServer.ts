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

import type { AmbienceMixer } from "../audio/ambience.js";
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

/** Komplett stilles Frame? (Lead-in-Stille darf die Burst-Einblende nicht verbrauchen.) */
function isSilent(frame: Buffer): boolean {
  for (let i = 0; i < frame.length; i += 2) {
    if (frame.readInt16LE(i) !== 0) return false;
  }
  return true;
}

/** Lineare Einblende über die ersten RAMP_SAMPLES eines 16-bit-Frames (in place). */
function fadeIn(frame: Buffer): void {
  const n = Math.min(RAMP_SAMPLES, frame.length / 2);
  for (let i = 0; i < n; i++) {
    frame.writeInt16LE(Math.round(frame.readInt16LE(i * 2) * (i / n)), i * 2);
  }
}

/** Lineare Ausblende über die letzten RAMP_SAMPLES (endet exakt auf 0, in place). */
function fadeOut(frame: Buffer): void {
  const total = frame.length / 2;
  const n = Math.min(RAMP_SAMPLES, total);
  for (let i = 0; i < n; i++) {
    const idx = total - n + i;
    frame.writeInt16LE(Math.round(frame.readInt16LE(idx * 2) * (1 - (i + 1) / n)), idx * 2);
  }
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
const PREBUFFER_MS = 80; // Jitter-Puffer vor Start des Playouts (absorbiert Deepgram-Bursts → weniger Underruns/Knacken)
const LEAD_IN_MS = 240; // einmalige Stille vor dem allerersten Ton (Greeting), bis die Medienstrecke „warm" ist
// Burst-Grenzen-Rampe (~5 ms): Aura-Streams starten mit hartem DC-Sprung (gemessen 2026-07-23:
// erstes Sample −388…−627, DC-Sockel bis −1600) — ohne Fade klickt jeder Äußerungsbeginn.
const RAMP_SAMPLES = Math.max(16, Math.round(config.audio.sampleRate / 200));
// Komfortrauschen im Leerlauf (~±12 ≈ −65 dBFS): reine digitale Nullen klingen nach „toter
// Leitung" und machen jede Mikro-Kante hörbar; ein hauchleiser Rauschteppich maskiert beides.
const NOISE_AMP = 12;
// DC-Blocker (Ein-Pol-Hochpass, fc ≈ 6 Hz): Aura-Sprache sitzt auf einem DC-Sockel bis
// −1600 — die Nulllinien-Verschiebung an Äußerungsgrenzen bleibt sonst als leiser
// „Bums" hörbar (und wandert im Widget-Pfad ungefiltert bis in den Browser-Lautsprecher).
const DC_ALPHA = 1 - 40 / config.audio.sampleRate;

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
  private readonly playQueue: Buffer[] = []; // getaktete 20-ms-Frames für die Ausgabe
  private playTimer?: NodeJS.Timeout;
  private playing = false;
  private nextSendTime = 0; // absolute Soll-Zeit des nächsten Frames (driftfreier Takt)
  private leadIn = true; // erster Ton der Session bekommt eine Stille-Anlaufzeit
  private rampNext = true; // nächstes TTS-Frame einblenden (Burst-Anfang nach Leerlauf)
  private noiseState = 0x9e3779b9; // LCG-Zustand fürs Komfortrauschen (pro Session)
  // DC-Blocker-Zustand (x[n-1], y[n-1]) — läuft über Frame-Grenzen hinweg weiter.
  private dcPrevIn = 0;
  private dcPrevOut = 0;
  private rawEcho = false;
  private closed = false;
  private ambiencePaused = false;
  private readonly log;

  constructor(
    readonly uuid: string,
    callId: string,
    private readonly onClose: (uuid: string) => void,
    private readonly ambience?: AmbienceMixer,
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
    // Der Takt läuft ab jetzt DURCHGEHEND bis close() — auch ohne Ambience wird in
    // Sprechpausen Stille gesendet. Ein abreißender Audiostrom erzeugt auf Endgeräten
    // hörbare Klick-Artefakte (Jitter-Buffer kippt in den Leerlauf; 0.6.21-Fix).
    this.ensurePlayout();
  }

  /** Vom Server pro empfangenem Audio-Frame aufgerufen. */
  handleAudio(payload: Buffer): void {
    if (this.closed) return;
    if (this.rawEcho) this.writeAudio(payload);
    else this.emit("audio", Buffer.from(payload));
  }

  /**
   * TTS-PCM von Deepgram in 20-ms-slin-Frames zerlegen und in die Playout-Queue legen.
   * Gesendet wird getaktet über einen selbstkorrigierenden Takt (siehe tick()) — sonst spielt
   * Asterisk das Audio zu schnell/abgehackt ab (kein eigener Jitter-Buffer für AudioSocket-Eingang).
   */
  sendAudio(pcm: Buffer): void {
    if (this.closed) return;
    this.sendBuffer = this.sendBuffer.length ? Buffer.concat([this.sendBuffer, pcm]) : pcm;
    while (this.sendBuffer.length >= FRAME_BYTES) {
      this.playQueue.push(Buffer.from(this.sendBuffer.subarray(0, FRAME_BYTES)));
      this.sendBuffer = this.sendBuffer.subarray(FRAME_BYTES);
    }
    // Einmalig vor dem allerersten Ton etwas Stille voranstellen, damit das erste Wort des
    // Greetings nicht abgeschnitten wird (Medienstrecke ist beim ersten Frame noch nicht „warm").
    if (this.leadIn && this.playQueue.length) {
      this.leadIn = false;
      for (let i = 0; i < Math.round(LEAD_IN_MS / FRAME_MS); i++) {
        this.playQueue.unshift(Buffer.alloc(FRAME_BYTES));
      }
    }
    this.ensurePlayout();
  }

  /** Playout-Takt starten (mit kleinem Jitter-Puffer), falls er gerade nicht läuft. */
  private ensurePlayout(): void {
    // Erst starten, wenn die Verbindung steht — sonst würden frühe Frames (Greeting) verworfen.
    if (this.playing || !this.socket) return;
    this.playing = true;
    this.nextSendTime = Date.now() + PREBUFFER_MS;
    this.scheduleTick();
  }

  /** Nächsten Frame zur absoluten Soll-Zeit einplanen → kein kumulativer Drift. */
  private scheduleTick(): void {
    const delay = Math.max(0, this.nextSendTime - Date.now());
    this.playTimer = setTimeout(() => this.tick(), delay);
  }

  /**
   * Ein Tick = genau ein 20-ms-Frame, durchgehend von attach() bis close(): TTS-Frame,
   * sonst Ambience, sonst Komfortrauschen. Der kontinuierliche Strom hält Jitter-Buffer
   * und Bridge stabil — der frühere Underrun-Stopp (~1 s nach Äußerungsende) erzeugte
   * auf den Endgeräten ein hörbares Klicken beim Übergang „Stille-Strom → kein Strom".
   * TTS-Bursts werden an ihren Grenzen kurz ein-/ausgeblendet (RAMP_SAMPLES): Aura
   * startet mit hartem DC-Sprung, der sonst als Klick am Äußerungsbeginn hörbar ist.
   */
  private tick(): void {
    if (this.closed || !this.playing) return;
    const frame = this.playQueue.shift();
    const ambience = this.ambiencePaused ? undefined : this.ambience;
    if (frame) {
      this.dcBlock(frame);
      // Stille-Frames (Lead-in) verbrauchen die Einblende nicht — erst echtes Signal rampt.
      if (this.rampNext && !isSilent(frame)) {
        fadeIn(frame);
        this.rampNext = false;
      }
      if (this.playQueue.length === 0) {
        // Vorerst letztes Frame des Bursts → ausblenden; der nächste blendet wieder ein.
        fadeOut(frame);
        this.rampNext = true;
      }
      this.writeAudio(ambience ? ambience.mix(frame) : frame);
    } else {
      this.rampNext = true;
      this.writeAudio(ambience ? ambience.mix(null) : this.nextNoiseFrame());
    }
    this.nextSendTime += FRAME_MS;
    this.scheduleTick();
  }

  /** Ein-Pol-Hochpass in place: y[n] = x[n] − x[n−1] + a·y[n−1] (entfernt den DC-Sockel). */
  private dcBlock(frame: Buffer): void {
    let xPrev = this.dcPrevIn;
    let yPrev = this.dcPrevOut;
    for (let i = 0; i < frame.length; i += 2) {
      const xn = frame.readInt16LE(i);
      const yn = xn - xPrev + DC_ALPHA * yPrev;
      xPrev = xn;
      yPrev = yn;
      frame.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(yn))), i);
    }
    this.dcPrevIn = xPrev;
    this.dcPrevOut = yPrev;
  }

  /** Hauchleises Rauschen (±NOISE_AMP) für den Leerlauf — klingt nach lebendiger Leitung. */
  private nextNoiseFrame(): Buffer {
    const frame = Buffer.alloc(FRAME_BYTES);
    let s = this.noiseState;
    for (let i = 0; i < FRAME_BYTES; i += 2) {
      s = (s * 1664525 + 1013904223) >>> 0; // LCG (Numerical Recipes)
      frame.writeInt16LE((s % (2 * NOISE_AMP + 1)) - NOISE_AMP, i);
    }
    this.noiseState = s;
    return frame;
  }

  /** Noch nicht ausgespielte Audiozeit in ms (für sauberes Auflegen nach dem Abschied). */
  pendingMs(): number {
    return this.playQueue.length * FRAME_MS;
  }

  flush(): void {
    // Barge-in/Transfer verwirft nur das gepufferte TTS — der Takt läuft nahtlos weiter
    // (Ambience bzw. Stille), damit der Audiostrom zum Endgerät nie abreißt.
    this.sendBuffer = Buffer.alloc(0);
    this.playQueue.length = 0;
  }

  /** Ambience stummschalten/fortsetzen (Transfer an einen Menschen: volle Stille im Gespräch). */
  setAmbiencePaused(paused: boolean): void {
    this.ambiencePaused = paused;
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
    this.playing = false;
    if (this.playTimer) {
      clearTimeout(this.playTimer);
      this.playTimer = undefined;
    }
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
  register(uuid: string, callId: string, ambience?: AmbienceMixer): MediaSession {
    const session = new MediaSession(uuid, callId, (u) => this.sessions.delete(u), ambience);
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
