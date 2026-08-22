/**
 * Fakes für die Call-Lifecycle-Tests: skriptbare VoiceAgentSession, Media-, ARI- und
 * Repo-Attrappen. Alles In-Memory, kein Netzwerk, keine DB. Wird über den Deps-Parameter
 * von `handleStasisStart` injiziert (siehe CallHandlerDeps in src/ari/callHandler.ts).
 */
import { EventEmitter } from "node:events";

import type { AriChannel, AriClient } from "ari-client";

import type { CallRepo } from "../../src/ari/callHandler.js";
import type {
  CallEndStatus,
  CallMetrics,
  FunctionCallRecord,
  NewRequestInput,
  TranscriptTurn,
} from "../../src/db/repository.js";
import type { CallLocalizerLike, LanguageState } from "../../src/llm/callLocalizer.js";
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
  /** Wenn gesetzt, liefert getUsage() diesen Verbrauch (TTS-Kostenmetrik testen). */
  usage?: import("../../src/voice/types.js").VoiceSessionUsage;

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
  getUsage(): import("../../src/voice/types.js").VoiceSessionUsage | undefined {
    return this.usage;
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
  /** Aufgezeichnete setAmbiencePaused-Aufrufe (Transfer an Mensch → [true]). */
  ambiencePauses: boolean[] = [];

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
  setAmbiencePaused(paused: boolean): void {
    this.ambiencePauses.push(paused);
  }
  /** Anrufer-Audio simulieren (Asterisk → Engine). */
  pushCallerAudio(buf: Buffer = Buffer.alloc(320)): void {
    this.emit("audio", buf);
  }
}

// ── ARI ──────────────────────────────────────────────────────────────────────

/**
 * Asterisks Antwort auf einen ARI-Aufruf gegen einen Kanal, der die Stasis-Anwendung
 * verlassen hat (answer → 409, addChannel → 422). Der ari-client legt den JSON-Körper
 * unverändert in `err.message` — genau diese Form muss die Engine deuten können.
 */
export function channelGoneError(): Error {
  return new Error('{\n  "message": "Channel not in Stasis application"\n}');
}

export class FakeChannel extends EventEmitter {
  answered = false;
  ringing = false;
  hangups: Array<Record<string, unknown> | undefined> = [];
  /** Kanal hat Stasis verlassen: ab jetzt scheitert jeder ARI-Aufruf wie am echten ARI. */
  gone = false;

  constructor(public readonly id: string = "chan-1") {
    super();
  }
  async ring(): Promise<void> {
    if (this.gone) throw channelGoneError();
    this.ringing = true;
  }
  async answer(): Promise<void> {
    if (this.gone) throw channelGoneError();
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
  /** Vom Client gestellt: Ist dieser Kanal noch in Stasis? */
  isGone: (id: string) => boolean = () => false;

  async addChannel(opts: { channel: string }): Promise<void> {
    if (this.isGone(opts.channel)) throw channelGoneError();
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

  constructor() {
    super();
    // Ein aufgelegter Kanal lässt sich auch nicht mehr in eine Bridge hängen — ohne diese
    // Kopplung wäre der Aufbau im Test erfolgreich, während er in der Realität scheitert.
    this.bridge.isGone = (id) => this.goneChannels.has(id);
  }

  private readonly goneChannels = new Set<string>();

  asAri(): AriClient {
    return this as unknown as AriClient;
  }
  /**
   * StasisEnd für einen Kanal feuern (Anrufer hat aufgelegt). Der Kanal gilt danach als
   * weg — echtes ARI liefert für ihn ab diesem Moment Fehler, und genau daran hing der
   * Live-Fehlschlag, den ein Fake mit immer gelingendem answer() nicht zeigen konnte.
   */
  emitStasisEnd(channel: FakeChannel): void {
    channel.gone = true;
    this.goneChannels.add(channel.id);
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
  finalized: Array<{ id: string; status: CallEndStatus; endedReason?: string }> = [];
  metrics: CallMetrics | undefined;
  languages: Array<{ id: string; language: string }> = [];
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
  greetingTexts: string[] = [];
  setGreetingText = async (_id: string, text: string): Promise<void> => {
    this.greetingTexts.push(text);
  };
  setLanguage = async (id: string, language: string): Promise<void> => {
    this.languages.push({ id, language });
  };
  finalizeRequest = async (
    id: string,
    status: CallEndStatus,
    metrics?: CallMetrics,
    endedReason?: string,
  ): Promise<void> => {
    this.finalized.push({ id, status, ...(endedReason ? { endedReason } : {}) });
    this.metrics = metrics;
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
    contentLanguage: "de",
    greeting: "Hallo",
    prompt: "Du bist ein Assistent.",
    listen: { model: "nova-3", language_hints: ["de", "en"], keyterms: [], smart_format: true },
    think: { source: "requesty", model: "openai/gpt-4o", temperature: 0.5 },
    speak: { provider: "deepgram", model: "aura-2-thalia-en", sanitize: true },
    tools: ["transfer_call", "end_call"],
    customTools: [],
    mcpServers: [],
    summary: { enabled: false, prompt: "", model: "openai/gpt-4.1-mini" },
    recording: { enabled: true },
    ambience: { enabled: false, preset: "office", volume: 0.25 },
    fillers: { enabled: false, delayMs: 2000, phrases: [] },
    idlePrompts: {
      enabled: false,
      timeoutMs: 8000,
      maxPrompts: 2,
      phrases: [],
      hangupAfter: false,
    },
    callerMemory: { language: false },
    tags: [],
    mip_opt_out: false,
    ...overrides,
  };
}

// ── Localizer ──────────────────────────────────────────────────────────────────

/** Fake-CallLocalizer: zeichnet observeTurn auf; resolve() liefert konfigurierbare Werte. */
export class FakeLocalizer implements CallLocalizerLike {
  observed: Array<{ speaker: string; text: string }> = [];
  closed = false;
  /** key → Rückgabewert von resolve(); fehlt ein Key, kommt der Key selbst zurück. */
  phrases: Record<string, string> = {};
  language?: string;
  /** Vom callHandler vorbelegte Sprache + Ansagen (Anrufer-Profil). */
  preloaded?: { lang: string; phrases: Record<string, string> };
  /** Was am Gesprächsende über die Sprache bekannt ist — steuert die Profil-Schreibregeln. */
  state: LanguageState = { confirmed: false };

  observeTurn(speaker: string, text: string): void {
    this.observed.push({ speaker, text });
  }
  resolve(key: string, _index?: number): string {
    return this.phrases[key] ?? key;
  }
  getLanguage(): string | undefined {
    return this.language;
  }
  preload(lang: string, phrases: Record<string, string>): void {
    this.preloaded = { lang, phrases };
    this.language = lang;
  }
  getLanguageState(): LanguageState {
    return this.state;
  }
  close(): void {
    this.closed = true;
  }
}
