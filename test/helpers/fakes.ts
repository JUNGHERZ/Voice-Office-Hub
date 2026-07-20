/**
 * Fakes für die Call-Lifecycle-Tests: skriptbare VoiceAgentSession, Media-, ARI- und
 * Repo-Attrappen. Alles In-Memory, kein Netzwerk, keine DB. Wird über den Deps-Parameter
 * von `handleStasisStart` injiziert (siehe CallHandlerDeps in src/ari/callHandler.ts).
 */
import { EventEmitter } from "node:events";

import type { AriChannel, AriClient } from "ari-client";

import type { CallRepo } from "../../src/ari/callHandler.js";
import type {
  FunctionCallRecord,
  NewRequestInput,
  TranscriptTurn,
} from "../../src/db/repository.js";
import type { ResolvedAgent } from "../../src/types.js";
import type { VoiceAgentSession, VoiceFunctionCall } from "../../src/voice/types.js";

/** Mikrotask-/Immediate-Queue leerlaufen lassen (für nicht awaitete async Event-Handler). */
export async function settle(rounds = 3): Promise<void> {
  for (let i = 0; i < rounds; i++) await new Promise<void>((r) => setImmediate(r));
}

/** Pollt eine Bedingung (Echtzeit-Timer — nicht mit Mock-Timern kombinieren). */
export async function waitFor(cond: () => boolean, timeoutMs = 1000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error("waitFor: Timeout");
    await new Promise<void>((r) => setTimeout(r, 10));
  }
}

// ── Voice-Session ─────────────────────────────────────────────────────────────

export class FakeVoiceAgentSession extends EventEmitter implements VoiceAgentSession {
  started = false;
  closed = false;
  /** Wenn gesetzt, wirft start() diesen Fehler (Connect-Fehlschlag simulieren). */
  startError?: Error;
  sentAudio: Buffer[] = [];
  functionResponses: Array<{ id: string; name: string; result: unknown }> = [];
  injectedMessages: string[] = [];

  async start(): Promise<void> {
    if (this.startError) throw this.startError;
    this.started = true;
  }
  sendAudio(chunk: Buffer): void {
    this.sentAudio.push(chunk);
  }
  sendFunctionResponse(id: string, name: string, result: unknown): void {
    this.functionResponses.push({ id, name, result });
  }
  injectMessage(message: string): void {
    this.injectedMessages.push(message);
  }
  close(): void {
    this.closed = true;
  }

  // ── Skript-API (Provider-Events auslösen) ──
  emitWelcome(id = "session-1"): void {
    this.emit("welcome", id);
  }
  emitAudio(buf: Buffer = Buffer.alloc(320)): void {
    this.emit("audio", buf);
  }
  emitUserStartedSpeaking(): void {
    this.emit("userStartedSpeaking");
  }
  emitConversationText(role: "user" | "assistant", content: string): void {
    this.emit("conversationText", { role, content });
  }
  emitError(desc: string): void {
    this.emit("error", desc);
  }
  /** Löst functionCallRequest aus und lässt den (nicht awaiteten) async Handler nachlaufen. */
  async emitFunctionCall(fns: Array<Partial<VoiceFunctionCall> & { name: string }>): Promise<void> {
    this.emit("functionCallRequest", {
      functions: fns.map((f, i) => ({
        id: f.id ?? `fn-${i + 1}`,
        name: f.name,
        argumentsJson: f.argumentsJson ?? "{}",
        clientSide: f.clientSide ?? true,
      })),
    });
    await settle();
  }
}

// ── Media ────────────────────────────────────────────────────────────────────

export class FakeMedia extends EventEmitter {
  started = false;
  closed = false;
  flushCount = 0;
  sentAudio: Buffer[] = [];
  /** Steuerbarer Rückgabewert von pendingMs() (Playout-Puffer in ms). */
  pending = 0;

  async start(): Promise<void> {
    this.started = true;
  }
  sendAudio(pcm: Buffer): void {
    this.sentAudio.push(pcm);
  }
  flush(): void {
    this.flushCount++;
  }
  close(): void {
    this.closed = true;
  }
  enableRawEcho(): void {}
  pendingMs(): number {
    return this.pending;
  }
  /** Anrufer-Audio simulieren (Asterisk → Engine). */
  pushCallerAudio(buf: Buffer = Buffer.alloc(320)): void {
    this.emit("audio", buf);
  }
}

// ── ARI ──────────────────────────────────────────────────────────────────────

export class FakeChannel extends EventEmitter {
  answered = false;
  hangups: Array<Record<string, unknown> | undefined> = [];

  constructor(public readonly id: string = "chan-1") {
    super();
  }
  async answer(): Promise<void> {
    this.answered = true;
  }
  async hangup(opts?: Record<string, unknown>): Promise<void> {
    this.hangups.push(opts);
  }
  /** Als AriChannel verwenden (Ambient-Typ ist lose; Duck-Typing wie in transferOutbound.test.ts). */
  asAri(): AriChannel {
    return this as unknown as AriChannel;
  }
}

export class FakeBridge {
  channels: string[] = [];
  destroyed = 0;

  async addChannel(opts: { channel: string }): Promise<void> {
    this.channels.push(opts.channel);
  }
  async destroy(): Promise<void> {
    this.destroyed++;
  }
}

export class FakeClient extends EventEmitter {
  bridge = new FakeBridge();
  externalChannel = new FakeChannel("ext-1");
  bridges = { create: async (_opts: Record<string, unknown>) => this.bridge };
  channels = { externalMedia: async (_params: Record<string, unknown>) => this.externalChannel };

  asAri(): AriClient {
    return this as unknown as AriClient;
  }
  /** StasisEnd für einen Kanal feuern (Anrufer hat aufgelegt). */
  emitStasisEnd(channel: FakeChannel): void {
    this.emit("StasisEnd", {}, channel);
  }
  /** ChannelDestroyed auf Client-Ebene feuern (z. B. Callee nach Transfer aufgelegt). */
  emitChannelDestroyed(channel: FakeChannel): void {
    this.emit("ChannelDestroyed", {}, channel);
  }
}

// ── Repository ───────────────────────────────────────────────────────────────

export class FakeRepo implements CallRepo {
  requests: NewRequestInput[] = [];
  transcript: TranscriptTurn[] = [];
  functionCalls: FunctionCallRecord[] = [];
  transfers: Array<{ attempted: boolean; target?: string; connected?: boolean }> = [];
  finalized: Array<{ id: string; status: "completed" | "failed" }> = [];
  requestId = "req-1";

  createRequest = async (input: NewRequestInput): Promise<string> => {
    this.requests.push(input);
    return this.requestId;
  };
  appendTranscript = async (_id: string, turn: TranscriptTurn): Promise<void> => {
    this.transcript.push(turn);
  };
  appendFunctionCall = async (_id: string, call: FunctionCallRecord): Promise<void> => {
    this.functionCalls.push(call);
  };
  setTransfer = async (
    _id: string,
    transfer: { attempted: boolean; target?: string; connected?: boolean },
  ): Promise<void> => {
    this.transfers.push(transfer);
  };
  setRecording = async (): Promise<void> => {};
  finalizeRequest = async (id: string, status: "completed" | "failed"): Promise<void> => {
    this.finalized.push({ id, status });
  };
}

// ── Agent-Fixture ────────────────────────────────────────────────────────────

export function testAgent(overrides: Partial<ResolvedAgent> = {}): ResolvedAgent {
  return {
    name: "test",
    mode: "agent",
    voiceProvider: "deepgram",
    targetNumbers: ["120"],
    useTransferCallerId: false,
    language: "multi",
    greeting: "Hallo",
    prompt: "Du bist ein Assistent.",
    listen: { model: "nova-3", language_hints: ["de", "en"], keyterms: [], smart_format: true },
    think: { source: "requesty", model: "openai/gpt-4o", temperature: 0.5 },
    speak: { provider: "deepgram", model: "aura-2-thalia-en" },
    tools: ["transfer_call", "end_call"],
    summary: { enabled: false, prompt: "", model: "openai/gpt-4.1-mini" },
    tags: [],
    mip_opt_out: false,
    ...overrides,
  };
}
