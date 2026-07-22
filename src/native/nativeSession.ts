/**
 * NativeSession: eigene STT→LLM→TTS-Kaskade als dritter VoiceAgentSession-Adapter
 * (voiceProvider "native"). callHandler/MediaSession/Toolset bleiben unangetastet —
 * diese Klasse synthetisiert exakt die neutralen Events, die heute der
 * Deepgram-Agent liefert.
 *
 * Orchestrierung:
 *   Flux-EndOfTurn → LLM-Stream (Requesty) → Sätze sofort in die Aura-TTS (Overlap).
 *   Tool-Calls laufen als functionCallRequest zum callHandler und per
 *   sendFunctionResponse zurück in dieselbe LLM-Runde (Loop bis ohne Tools).
 *
 * Barge-in (Flux-StartOfTurn während der Agent antwortet):
 *   Schicht 1: tts.clear() — der Server verwirft, Frames sind bis "Cleared" gesperrt.
 *   Schicht 2: Turn-GENERATIONSZÄHLER — jeder Abbruch inkrementiert; jeder async
 *   Callback (LLM-Delta, TTS-Audio, Tool-Fortsetzung) prüft seine Geburts-Generation
 *   vor jedem emit/sendText. Verspätete Chunks abgebrochener Turns sind damit stumm.
 *
 * EagerEndOfTurn-Spekulation (NATIVE_EAGER_EOT, 0.6.17):
 *   Flux meldet ein vorläufiges Turn-Ende einige hundert ms vor dem bestätigten —
 *   der LLM-Turn startet sofort, aber hinter einem Gate: Sätze werden gepuffert,
 *   Historie/Transkript/Tool-Calls warten. Bestätigt EndOfTurn (gleicher Wortlaut)
 *   → Gate auf, Puffer sprechen; TurnResumed/abweichendes Transkript → Abbruch,
 *   für den Anrufer unhörbar. Kosten einer Fehlspekulation: nur LLM-Input-Tokens.
 */
import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";

import { config } from "../config.js";
import { modelSupportsTemperature } from "../llm/models.js";
import type { ResolvedAgent } from "../types.js";
import { logger } from "../util/logger.js";
import type {
  FunctionDefinition,
  VoiceAgentSession,
  VoiceAgentSessionEvents,
  VoiceSessionUsage,
} from "../voice/types.js";
import { ConversationHistory } from "./history.js";
import { streamChatCompletion, toOpenAiTools, type OpenAiTool } from "./llmStream.js";
import { createSentenceChunker } from "./sentences.js";
import { FluxSttStream, type SttStreamOptions } from "./sttStream.js";
import { ElevenLabsTtsStream } from "./ttsElevenLabs.js";
import { AuraTtsStream } from "./ttsStream.js";
import type { SttStreamLike, TtsStreamLike } from "./types.js";

/** Injizierbare Baustein-Fabriken (Tests reichen Fakes ein — Muster CallHandlerDeps). */
export interface NativeSessionDeps {
  createStt: (opts: SttStreamOptions, callId: string) => SttStreamLike;
  /** TTS-Provider-Matrix: Auswahl anhand agent.speak.provider (Aura oder ElevenLabs). */
  createTts: (agent: ResolvedAgent, callId: string) => TtsStreamLike;
  streamLlm: typeof streamChatCompletion;
}

/**
 * TTS-Auswahl für native: speak.provider "eleven_labs" nutzt ElevenLabs-Streaming
 * (Voice-ID aus speak.voice, Key aus dem Server-Env); unvollständige Konfiguration
 * fällt — wie im Deepgram-Modus (0.6.8) — mit Warnung auf Aura zurück. Ein Anruf
 * scheitert nie an der TTS-Auswahl.
 */
export function buildNativeTts(agent: ResolvedAgent, callId: string): TtsStreamLike {
  const log = logger.child({ mod: "native", callId });
  if (agent.speak.provider === "eleven_labs") {
    const apiKey = config.elevenlabs.apiKey;
    const voiceId = agent.speak.voice?.trim();
    if (apiKey && voiceId) {
      const modelId =
        agent.speak.model && !agent.speak.model.startsWith("aura")
          ? agent.speak.model
          : "eleven_flash_v2_5";
      const { stability, similarityBoost, speed } = agent.speak;
      const hasVoiceSettings =
        stability !== undefined || similarityBoost !== undefined || speed !== undefined;
      return new ElevenLabsTtsStream(
        {
          baseUrl: config.native.elevenUrl,
          apiKey,
          voiceId,
          modelId,
          outputFormat: `pcm_${config.audio.sampleRate}`,
          ...(hasVoiceSettings ? { voiceSettings: { stability, similarityBoost, speed } } : {}),
        },
        callId,
      );
    }
    log.warn("ElevenLabs-TTS unvollständig (ELEVENLABS_API_KEY oder Voice-ID fehlt) — Fallback auf Aura", {
      hasKey: Boolean(apiKey),
      hasVoice: Boolean(voiceId),
    });
  }
  const auraModel =
    agent.speak.model && agent.speak.model.startsWith("aura")
      ? agent.speak.model
      : config.defaultAgent.speakModel;
  return new AuraTtsStream(
    {
      url: config.native.ttsUrl,
      apiKey: config.deepgram.apiKey,
      model: auraModel,
      encoding: config.audio.encoding,
      sampleRate: config.audio.sampleRate,
    },
    callId,
  );
}

const defaultDeps: NativeSessionDeps = {
  createStt: (opts, callId) => new FluxSttStream(opts, callId),
  createTts: buildNativeTts,
  streamLlm: streamChatCompletion,
};

interface ToolRound {
  gen: number;
  pending: Set<string>;
  resolve: () => void;
}

/**
 * Laufende EagerEndOfTurn-Spekulation (0.6.17): Der LLM-Turn startet bereits auf
 * das vorläufige Flux-Transkript; nach außen (TTS, Historie, Tool-Calls,
 * Transkript-Events) passiert NICHTS, bis das bestätigte EndOfTurn das Gate öffnet.
 * TurnResumed oder ein abweichendes Final-Transkript verwerfen die Spekulation —
 * der Anrufer merkt davon nichts (es wurde nie Audio erzeugt).
 */
interface Speculation {
  gen: number;
  transcript: string;
  /** TTS-Gate: false = Sätze werden gepuffert; true (bestätigt) = direkt sprechen. */
  open: boolean;
  buffer: string[];
  confirmed: Promise<void>;
  resolveConfirmed: () => void;
  abort?: AbortController;
}

/** Vergleich Eager- vs. Final-Transkript: Interpunktion/Großschreibung egal, Wortlaut zählt. */
function sameUtterance(a: string, b: string): boolean {
  const norm = (s: string) => s.toLowerCase().replace(/[\s.,!?;:…\-–—]+/gu, " ").trim();
  return norm(a) === norm(b);
}

export declare interface NativeSession {
  on<E extends keyof VoiceAgentSessionEvents>(event: E, listener: VoiceAgentSessionEvents[E]): this;
  emit<E extends keyof VoiceAgentSessionEvents>(
    event: E,
    ...args: Parameters<VoiceAgentSessionEvents[E]>
  ): boolean;
}

export class NativeSession extends EventEmitter implements VoiceAgentSession {
  private readonly stt: SttStreamLike;
  private readonly tts: TtsStreamLike;
  private readonly deps: NativeSessionDeps;
  private readonly history: ConversationHistory;
  private readonly tools: OpenAiTool[];
  private readonly log;

  private started = false;
  private closed = false;
  /** Abbruch-Mechanik: Barge-in/injectMessage/close inkrementieren; Callbacks prüfen. */
  private generation = 0;
  private activeAbort?: AbortController;
  private toolRound?: ToolRound;
  private responding = false;
  /** Bei Konstruktion eingefroren (Tests können config vor dem new umschalten). */
  private readonly eagerEnabled = config.native.eagerEot;
  private speculation?: Speculation;

  // Latenz-Messpunkte des laufenden Assistant-Turns (für agentStartedSpeaking + A/B-Logs).
  private eotAt = 0;
  private firstTokenAt = 0;
  private firstSentenceAt = 0;
  private startedSpeakingEmitted = false;
  private llmDone = false;

  constructor(
    private readonly agent: ResolvedAgent,
    functions: FunctionDefinition[],
    private readonly callId: string,
    depsOverride?: Partial<NativeSessionDeps>,
  ) {
    super();
    this.deps = { ...defaultDeps, ...depsOverride };
    this.log = logger.child({ mod: "native", callId });
    this.tools = toOpenAiTools(functions);
    this.history = new ConversationHistory(
      agent.prompt,
      agent.think.context_length ?? config.native.contextChars,
    );

    // Konstruktion bleibt inert: die Clients verbinden erst in start().
    this.stt = this.deps.createStt(this.buildSttOptions(), callId);
    this.tts = this.deps.createTts(agent, callId);
    this.wireStt();
    this.wireTts();
  }

  private buildSttOptions(): SttStreamOptions {
    let model = this.agent.listen.model;
    if (!model.startsWith("flux")) {
      // Native braucht Flux (modellintegriertes Turn-Taking); nova-3 wäre ohne
      // eigenes Endpointing stumm → deterministischer Fallback mit Warnung.
      this.log.warn("NativeSession braucht ein flux-Modell — Fallback auf flux-general-multi", {
        configured: model,
      });
      model = "flux-general-multi";
    }
    return {
      url: config.native.sttUrl,
      apiKey: config.deepgram.apiKey,
      model,
      sampleRate: config.audio.sampleRate,
      encoding: config.audio.encoding,
      languageHints: this.agent.listen.language_hints,
      keyterms: this.agent.listen.keyterms,
      ...(this.agent.listen.eot_threshold !== undefined
        ? { eotThreshold: this.agent.listen.eot_threshold }
        : {}),
      ...(this.agent.listen.eot_timeout_ms !== undefined
        ? { eotTimeoutMs: this.agent.listen.eot_timeout_ms }
        : {}),
      // Flux deaktiviert den Eager-Modus OHNE Threshold komplett (verifiziert 2026-07-22)
      // — das Flag muss also immer eine Schwelle mitsenden. 0,5 = Mitte des gültigen
      // Bereichs (0,3–0,9); Fehlspekulationen sind dank Gate unhörbar und billig.
      ...(this.eagerEnabled
        ? { eagerEotThreshold: config.native.eagerEotThreshold ?? 0.5 }
        : {}),
    };
  }

  // ── Lebenszyklus ────────────────────────────────────────────────────────────

  async start(): Promise<void> {
    if (this.started || this.closed) return;
    this.started = true;
    // Beide Beine parallel; ein Fehler → reject → callHandler räumt auf (cleanup("failed")).
    await Promise.all([this.stt.start(), this.tts.start()]);

    this.emit("open");
    this.emit("welcome", randomUUID());
    this.emit("settingsApplied");

    if (this.agent.greeting) {
      // Transkript-Parität zum Deepgram-Agent: das Greeting erscheint als Assistant-Turn.
      this.history.addAssistant(this.agent.greeting);
      this.emit("conversationText", { role: "assistant", content: this.agent.greeting });
      this.speak(this.agent.greeting, this.generation);
      this.tts.flush();
    }
  }

  sendAudio(chunk: Buffer): void {
    if (!this.closed) this.stt.sendAudio(chunk);
  }

  sendFunctionResponse(id: string, _name: string, result: unknown): void {
    // Historie IMMER pflegen (auch nach Barge-in während der Tool-Ausführung) —
    // fortgesetzt wird die LLM-Runde nur, wenn ihre Generation noch aktuell ist.
    this.history.addToolResult(id, _name, result);
    const round = this.toolRound;
    if (!round || round.gen !== this.generation) return;
    round.pending.delete(id);
    if (round.pending.size === 0) {
      this.toolRound = undefined;
      round.resolve();
    }
  }

  injectMessage(message: string): void {
    if (this.closed) return;
    // Kanned-Ansage (z. B. Transfer-Fehlschlag): laufenden Turn verwerfen, Zeile sprechen.
    // Die danach eintreffende (stale) Tool-Response landet nur in der Historie — keine
    // automatische LLM-Fortsetzung, kein Doppel-Sprechen.
    this.cancelActiveTurn();
    this.history.addAssistant(message);
    this.emit("conversationText", { role: "assistant", content: message });
    this.speak(message, this.generation);
    this.tts.flush();
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.cancelActiveTurn();
    this.stt.close();
    this.tts.close();
    this.emit("close", 1000);
  }

  /** TTS-Verbrauch der Session (zeichengenau, wie an den Anbieter gesendet). */
  getUsage(): VoiceSessionUsage | undefined {
    const u = this.tts.usage?.();
    if (!u || !u.characters) return undefined;
    return {
      ttsProvider: u.provider,
      ttsModel: u.model,
      ttsCharacters: u.characters,
      ...(u.credits !== undefined ? { ttsCredits: u.credits } : {}),
    };
  }

  // ── STT-Verdrahtung ─────────────────────────────────────────────────────────

  private wireStt(): void {
    this.stt.on("speechStarted", () => {
      if (this.closed) return;
      // Barge-in-Kette: callHandler flusht die Media-Queue; wir verwerfen LLM/TTS.
      this.emit("userStartedSpeaking");
      this.cancelActiveTurn();
    });
    this.stt.on("turnEnded", (transcript: string) => {
      if (this.closed) return;
      const text = transcript.trim();
      const spec = this.speculation;
      this.speculation = undefined;
      if (spec && spec.gen === this.generation && text && sameUtterance(spec.transcript, text)) {
        // Spekulation bestätigt: Historie/Transkript nachziehen, TTS-Gate öffnen —
        // der LLM-Turn läuft bereits (oder ist sogar schon fertig).
        this.history.addUser(text);
        this.emit("conversationText", { role: "user", content: text });
        this.confirmSpeculation(spec);
        return;
      }
      if (spec) this.abortSpeculation(spec); // Final-Transkript weicht ab → sauber neu
      if (!text) return; // "ähm"/Leerlauf: kein LLM-Turn
      this.history.addUser(text);
      this.emit("conversationText", { role: "user", content: text });
      void this.runAssistantTurn(this.generation);
    });
    this.stt.on("eagerTurnEnded", (transcript: string) => {
      if (this.closed || !this.eagerEnabled) return;
      const text = transcript.trim();
      if (!text) return;
      const prev = this.speculation;
      if (prev) {
        if (sameUtterance(prev.transcript, text)) return; // läuft bereits
        this.speculation = undefined;
        this.abortSpeculation(prev);
      }
      if (this.responding) return; // echter Antwort-Turn läuft — kein Spekulationsfall
      const spec: Speculation = {
        gen: this.generation,
        transcript: text,
        open: false,
        buffer: [],
        confirmed: Promise.resolve(),
        resolveConfirmed: () => {},
      };
      spec.confirmed = new Promise<void>((resolve) => {
        spec.resolveConfirmed = resolve;
      });
      this.speculation = spec;
      this.log.debug("EagerEndOfTurn — spekulativer LLM-Start", { transcript: text });
      void this.runAssistantTurn(spec.gen, spec);
    });
    this.stt.on("turnResumed", () => {
      const spec = this.speculation;
      if (!spec) return;
      this.speculation = undefined;
      this.log.debug("TurnResumed — Spekulation verworfen");
      this.abortSpeculation(spec);
    });
    this.stt.on("error", (description: string) => {
      if (!this.closed) this.emit("error", `STT: ${description}`);
    });
    this.stt.on("close", (code: number) => {
      if (this.closed) return;
      // Genau EIN Reconnect-Versuch (Netz-Hickser überbrücken, Schleifen vermeiden).
      // Der Anrufer verliert währenddessen nur die eigene Sprache; die Session lebt.
      if (!this.sttReconnected) {
        this.sttReconnected = true;
        this.log.warn("STT-Verbindung verloren — versuche einmaligen Reconnect", { code });
        void this.stt.start().catch((err) => {
          if (!this.closed) this.emit("error", `STT-Reconnect fehlgeschlagen: ${String(err)}`);
        });
        return;
      }
      this.emit("error", `STT-Verbindung verloren (Code ${code})`);
    });
  }

  private sttReconnected = false;

  // ── TTS-Verdrahtung ─────────────────────────────────────────────────────────

  private wireTts(): void {
    this.tts.on("audio", (chunk: Buffer) => {
      if (this.closed) return;
      // Schicht 2 der Barge-in-Quarantäne: Audio nur, solange die Generation lebt,
      // in der zuletzt Text geschrieben wurde.
      if (this.ttsGen !== this.generation) return;
      if (!this.startedSpeakingEmitted && this.eotAt > 0) {
        this.startedSpeakingEmitted = true;
        const now = Date.now();
        const latency = {
          total: (now - this.eotAt) / 1000,
          ...(this.firstTokenAt ? { ttt: (this.firstTokenAt - this.eotAt) / 1000 } : {}),
          ...(this.firstSentenceAt ? { tts: (now - this.firstSentenceAt) / 1000 } : {}),
        };
        this.emit("agentStartedSpeaking", latency);
        this.log.info("Turn-Latenz", latency);
      }
      this.emit("audio", chunk);
    });
    this.tts.on("flushed", () => {
      if (!this.closed && this.llmDone && this.ttsGen === this.generation) {
        this.emit("agentAudioDone");
      }
    });
    this.tts.on("error", (description: string) => {
      if (!this.closed) this.emit("error", `TTS: ${description}`);
    });
    this.tts.on("close", () => {
      // Lazy-Reconnect übernimmt der Client beim nächsten sendText — kein Session-Ende.
    });
  }

  /** Generation, in der zuletzt TTS-Text geschrieben wurde (Audio-Gate). */
  private ttsGen = 0;

  private speak(text: string, gen: number): void {
    if (gen !== this.generation || this.closed) return;
    if (!this.firstSentenceAt) this.firstSentenceAt = Date.now();
    this.ttsGen = gen;
    this.tts.sendText(text);
  }

  // ── Assistant-Turn (LLM-Loop inkl. Tools) ───────────────────────────────────

  private cancelActiveTurn(): void {
    const spec = this.speculation;
    this.speculation = undefined;
    spec?.resolveConfirmed(); // wartenden Spekulations-Runner wecken (erkennt stale Gen)
    this.generation += 1;
    this.responding = false;
    this.activeAbort?.abort();
    this.activeAbort = undefined;
    const round = this.toolRound;
    this.toolRound = undefined;
    round?.resolve(); // wartende Runde aufwecken — sie erkennt ihre stale Generation selbst
    this.tts.clear();
  }

  /** Bestätigtes EndOfTurn: Gate öffnen, gepufferte Sätze sprechen, Latenz ab JETZT messen. */
  private confirmSpeculation(spec: Speculation): void {
    spec.open = true;
    this.eotAt = Date.now();
    // Token kamen ggf. schon vor dem bestätigten Turn-Ende → ttt nicht negativ ausweisen.
    if (this.firstTokenAt && this.firstTokenAt < this.eotAt) this.firstTokenAt = this.eotAt;
    for (const s of spec.buffer.splice(0)) this.speak(s, spec.gen);
    spec.resolveConfirmed();
  }

  /** Spekulation verwerfen (TurnResumed/abweichendes Transkript) — es wurde nie Audio erzeugt. */
  private abortSpeculation(spec: Speculation): void {
    if (spec.gen === this.generation) this.generation += 1;
    this.responding = false;
    spec.abort?.abort();
    spec.resolveConfirmed();
  }

  private async runAssistantTurn(gen: number, spec?: Speculation): Promise<void> {
    if (gen !== this.generation || this.closed) return;
    this.responding = true;
    // Spekulativ: Latenz erst ab dem BESTÄTIGTEN Turn-Ende messen (confirmSpeculation).
    this.eotAt = spec ? 0 : Date.now();
    this.firstTokenAt = 0;
    this.firstSentenceAt = 0;
    this.startedSpeakingEmitted = false;
    this.llmDone = false;

    const abort = new AbortController();
    this.activeAbort = abort;
    if (spec) spec.abort = abort;
    const model = this.agent.think.model || config.llm.model;
    let firstRound = true;

    try {
      // Tool-Loop: LLM-Runden, bis eine Antwort ohne tool_calls kommt.
      for (;;) {
        let chunker = createSentenceChunker(config.native.minSentenceChars);
        const result = await this.deps.streamLlm(
          {
            baseUrl: config.llm.requestyBaseUrl,
            apiKey: config.llm.requestyApiKey,
            model,
            // Spekulative Runde 1: User-Turn nur im Request, NICHT in der Historie —
            // die wird erst beim bestätigten EndOfTurn nachgezogen.
            messages:
              spec && firstRound
                ? [...this.history.messages(), { role: "user" as const, content: spec.transcript }]
                : this.history.messages(),
            ...(this.tools.length ? { tools: this.tools } : {}),
            ...(modelSupportsTemperature(model)
              ? { temperature: this.agent.think.temperature }
              : {}),
            signal: abort.signal,
          },
          (delta) => {
            if (gen !== this.generation) return;
            if (!this.firstTokenAt) this.firstTokenAt = Date.now();
            for (const sentence of chunker.push(delta)) {
              // TTS-Gate der Spekulation: puffern, bis das Turn-Ende bestätigt ist.
              if (spec && !spec.open) spec.buffer.push(sentence);
              else this.speak(sentence, gen);
            }
          },
        );
        if (gen !== this.generation || this.closed) return;
        if (spec && firstRound && !spec.open) {
          // Nichts darf nach außen (TTS/Historie/Tools), bevor das EndOfTurn bestätigt.
          await spec.confirmed;
          if (gen !== this.generation || this.closed) return;
        }
        firstRound = false;

        const rest = chunker.flush();
        if (rest) this.speak(rest, gen);
        // Auch vor einer Tool-Wartezeit flushen: „Einen Moment, ich schaue nach" soll raus.
        this.tts.flush();

        if (result.toolCalls.length) {
          this.history.addAssistantToolCalls(result.content, result.toolCalls);
          if (result.content) {
            this.emit("conversationText", { role: "assistant", content: result.content });
          }
          const done = new Promise<void>((resolve) => {
            this.toolRound = { gen, pending: new Set(result.toolCalls.map((t) => t.id)), resolve };
          });
          this.emit("functionCallRequest", {
            functions: result.toolCalls.map((t) => ({
              id: t.id,
              name: t.function.name,
              argumentsJson: t.function.arguments,
              clientSide: true,
            })),
          });
          // end_call-Muster: der callHandler beantwortet end_call bewusst NICHT —
          // die Runde bleibt offen, der Abschied ist bereits in der TTS, der Hangup
          // kommt drain-basiert. cancelActiveTurn()/close() weckt uns auf.
          await done;
          if (gen !== this.generation || this.closed) return;
          continue;
        }

        this.history.addAssistant(result.content);
        if (result.content) {
          this.emit("conversationText", { role: "assistant", content: result.content });
        }
        this.llmDone = true;
        this.responding = false;
        return;
      }
    } catch (err) {
      // Tote Spekulation freigeben — das bestätigte EndOfTurn startet dann normal neu.
      if (spec && this.speculation === spec) this.speculation = undefined;
      if ((err as Error).name === "AbortError") return; // Barge-in: bewusst verworfen
      this.responding = false;
      if (gen !== this.generation || this.closed) return;
      this.log.warn("LLM-Turn fehlgeschlagen — zurück zu Listening", { err: String(err) });
      this.emit("error", `LLM: ${String(err)}`);
    } finally {
      if (this.activeAbort === abort) this.activeAbort = undefined;
    }
  }
}
