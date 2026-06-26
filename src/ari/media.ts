/**
 * Media-Bridge zwischen Asterisk (externalMedia) und unserem Server.
 *
 * Asterisk sendet bei `externalMedia` einen RTP-Stream (slin16) an unseren UDP-Port; wir
 * extrahieren das PCM und reichen es an Deepgram weiter. Deepgram-TTS-Audio wird hier in
 * RTP verpackt und an Asterisk zurückgeschickt.
 *
 * ⚠ SPIKE-Verifikationspunkt (siehe Plan): RTP-Packetisierung (Payload-Type, ptime, Timing)
 *   sowie die Alternative AudioSocket-Transport sind im ersten Spike final zu verifizieren.
 *   Die 12-Byte-RTP-Headerbehandlung unten ist die gängige Grundannahme für slin.
 */
import { EventEmitter } from "node:events";
import dgram from "node:dgram";

import { config } from "../config.js";
import { logger } from "../util/logger.js";

const RTP_HEADER_BYTES = 12;
const SAMPLE_RATE = config.audio.sampleRate;
const FRAME_MS = 20;
// slin16: 2 Byte/Sample → Bytes pro 20ms-Frame
const FRAME_BYTES = (SAMPLE_RATE * 2 * FRAME_MS) / 1000;

export interface MediaBridgeEvents {
  audio: (pcm: Buffer) => void;
}

export declare interface MediaBridge {
  on<E extends keyof MediaBridgeEvents>(event: E, listener: MediaBridgeEvents[E]): this;
  emit<E extends keyof MediaBridgeEvents>(event: E, ...args: Parameters<MediaBridgeEvents[E]>): boolean;
}

export class MediaBridge extends EventEmitter {
  private socket: dgram.Socket;
  private remote?: { address: string; port: number };
  private seq = 0;
  private timestamp = 0;
  // Payload-Type aus dem eingehenden Asterisk-Stream übernehmen (statt hartzucodieren),
  // sonst interpretiert Asterisk unsere slin16-Bytes mit falschem Format → Rauschen.
  private payloadType = 0;
  private learnedPt = false;
  private rawEcho = false;
  private readonly ssrc = (Math.random() * 0xffffffff) >>> 0;
  private sendBuffer: Buffer = Buffer.alloc(0);
  private readonly log;

  constructor(private readonly port: number, callId: string) {
    super();
    this.log = logger.child({ mod: "media", callId });
    this.socket = dgram.createSocket("udp4");
    this.socket.on("message", (msg, rinfo) => this.onPacket(msg, rinfo));
    this.socket.on("error", (err) => this.log.error("UDP-Fehler", { err: String(err) }));
  }

  async start(): Promise<void> {
    await new Promise<void>((resolve) => {
      this.socket.bind(this.port, config.audio.externalMediaHost, () => {
        this.log.info("Media-Socket gebunden", { port: this.port });
        resolve();
      });
    });
  }

  private onPacket(msg: Buffer, rinfo: dgram.RemoteInfo): void {
    // Remote-Adresse aus dem ersten Paket lernen (Rückkanal).
    if (!this.remote) this.remote = { address: rinfo.address, port: rinfo.port };
    if (msg.length <= RTP_HEADER_BYTES) return;
    // Payload-Type aus dem eingehenden Stream übernehmen (einmalig + loggen).
    if (!this.learnedPt) {
      this.payloadType = msg.readUInt8(1) & 0x7f;
      this.learnedPt = true;
      this.log.info("Erstes RTP-Paket", {
        bytes: msg.length,
        payloadBytes: msg.length - RTP_HEADER_BYTES,
        payloadType: this.payloadType,
      });
    }
    // Reiner Echo-Modus: empfangenes Paket unverändert zurückspielen (nur eigene SSRC),
    // bewahrt Framing/Rate/Timestamp exakt → isolierter Test des Audio-Pfads.
    if (this.rawEcho) {
      this.sendRawBack(msg);
      return;
    }
    const pcm = msg.subarray(RTP_HEADER_BYTES);
    this.emit("audio", pcm);
  }

  /** Aktiviert den reinen RTP-Echo (nur für den Spike/Diagnose). */
  enableRawEcho(): void {
    this.rawEcho = true;
  }

  private sendRawBack(msg: Buffer): void {
    if (!this.remote) return;
    const out = Buffer.from(msg); // Kopie, Original nicht verändern
    out.writeUInt32BE(this.ssrc, 8); // eigene SSRC, sonst evtl. Loopback-Ignore
    this.socket.send(out, this.remote.port, this.remote.address);
  }

  /** Deepgram-TTS-PCM in 20ms-RTP-Frames an Asterisk senden. */
  sendAudio(pcm: Buffer): void {
    if (!this.remote) return; // noch kein Rückkanal bekannt
    this.sendBuffer = Buffer.concat([this.sendBuffer, pcm]);
    while (this.sendBuffer.length >= FRAME_BYTES) {
      const frame = this.sendBuffer.subarray(0, FRAME_BYTES);
      this.sendBuffer = this.sendBuffer.subarray(FRAME_BYTES);
      this.sendRtp(frame);
    }
  }

  /** Restpuffer/Wiedergabe verwerfen (Barge-in). */
  flush(): void {
    this.sendBuffer = Buffer.alloc(0);
  }

  private sendRtp(payload: Buffer): void {
    if (!this.remote) return;
    const header = Buffer.alloc(RTP_HEADER_BYTES);
    header[0] = 0x80; // Version 2
    header[1] = 0x00; // Payload-Type 0 (Spike: ggf. an ausgehandeltes Format anpassen)
    header.writeUInt16BE(this.seq & 0xffff, 2);
    header.writeUInt32BE(this.timestamp >>> 0, 4);
    header.writeUInt32BE(this.ssrc, 8);
    this.seq = (this.seq + 1) & 0xffff;
    this.timestamp = (this.timestamp + payload.length / 2) >>> 0;
    const packet = Buffer.concat([header, payload]);
    this.socket.send(packet, this.remote.port, this.remote.address);
  }

  close(): void {
    try {
      this.socket.close();
    } catch {
      /* bereits geschlossen */
    }
  }
}
