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
import { BUILTIN_TOOL_NAMES } from "../tools/names.js";
import type { ResolvedAgent } from "../types.js";
import { logger } from "../util/logger.js";
import type {
  FunctionDefinition,
  VoiceAgentSession,
  VoiceAgentSessionEvents,
  VoiceSessionUsage,
} from "../voice/types.js";
import { ConversationHistory } from "./history.js";
import {
  promptCacheBelowMinimum,
  streamChatCompletion,
  toOpenAiTools,
  type OpenAiTool,
} from "./llmStream.js";
import { createSentenceChunker } from "./sentences.js";
import { FluxSttStream, type SttStreamOptions } from "./sttStream.js";
import { buildNativeTts } from "./ttsFactory.js";
import type { SttStreamLike, TtsStreamLike } from "./types.js";

// Die Provider-Matrix liegt in ttsFactory.ts; hier re-exportiert, damit bestehende
// Importe und die Testnaht (NativeSessionDeps.createTts) unverändert bleiben.
export { buildNativeTts };

/** Injizierbare Baustein-Fabriken (Tests reichen Fakes ein — Muster CallHandlerDeps). */
export interface NativeSessionDeps {
  createStt: (opts: SttStreamOptions, callId: string) => SttStreamLike;
  /** TTS-Provider-Matrix: Auswahl anhand agent.speak.provider (siehe ttsFactory.ts). */
  createTts: (agent: ResolvedAgent, callId: string) => TtsStreamLike;
  streamLlm: typeof streamChatCompletion;
  /** One-shot Timer für den Filler (injizierbar: Fake-Clock statt Wall-Clock); gibt Canceler zurück. */
  setTimer: (fn: () => void, ms: number) => () => void;
}

/** Minimaler Localizer-Vertrag für den Filler (CallLocalizer erfüllt ihn strukturell; Tests: Fake). */
export interface FillerLocalizer {
  resolve(key: string, index?: number): string;
}

const defaultDeps: NativeSessionDeps = {
  createStt: (opts, callId) => new FluxSttStream(opts, callId),
  createTts: buildNativeTts,
  streamLlm: streamChatCompletion,
  setTimer: (fn, ms) => {
    const h = setTimeout(fn, ms);
    h.unref?.(); // ein vergessener Filler-Timer darf die Test-Suite/Event-Loop nie aufhalten
    return () => clearTimeout(h);
  },
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
  /** Ausgang der Spekulation des laufenden Turns (nur fürs Turn-Latenz-Log). */
  private eagerOutcome?: "hit" | "miss";

  // Latenz-Messpunkte des laufenden Assistant-Turns (für agentStartedSpeaking + A/B-Logs).
  private eotAt = 0;
  private firstTokenAt = 0;
  private firstSentenceAt = 0;
  private startedSpeakingEmitted = false;
  private llmDone = false;

  // Timer-Filler bei Tool-Wartezeiten (0.6.26).
  private fillerIndex = 0;
  private toolWaitSpoken = false;
  private cancelFillerTimer?: () => void;
  /**
   * Lief in diesem Turn ein Filler? Der Filler selbst darf die Latenzmessung nicht auslösen
   * (er ist nicht die Antwort), die Tool-Fortsetzung danach aber schon — sonst bleiben
   * ausgerechnet die langsamen Runden ungemessen. Markiert die Messung als `afterFiller`,
   * weil sie die Tool-Wartezeit enthält und nicht mit normalen Turns vergleichbar ist.
   */
  private fillerSpokenThisTurn = false;
  /** Cache-Diagnose einmal je Anruf — pro Turn waere sie reines Log-Rauschen. */
  private cacheDiagLogged = false;

  constructor(
    private readonly agent: ResolvedAgent,
    functions: FunctionDefinition[],
    private readonly callId: string,
    depsOverride?: Partial<NativeSessionDeps>,
    private readonly localizer?: FillerLocalizer,
    /** Noch nicht abgespieltes Agent-Audio (ms) — siehe VoiceSessionOptions. */
    private readonly pendingPlayoutMs?: () => number,
    /**
     * false = reine Ansage: Es wird nur gesprochen, nicht zugehört (siehe VoiceSessionOptions).
     * Der STT-Strom wird dann gar nicht erst geöffnet — das spart nicht nur den Posten,
     * es verhindert auch, dass eine Ansage in ein Gespräch kippt.
     */
    private readonly listen: boolean = true,
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
    await Promise.all([...(this.listen ? [this.stt.start()] : []), this.tts.start()]);

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
    if (!this.closed && this.listen) this.stt.sendAudio(chunk);
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

  /**
   * Verbrauch der Session: TTS zeichengenau (wie an den Anbieter gesendet) und die
   * LLM-Mengen. Beide Teile sind unabhängig — ein Anruf, in dem nichts gesprochen wurde,
   * kann trotzdem LLM-Runden gehabt haben und umgekehrt.
   */
  getUsage(): VoiceSessionUsage | undefined {
    const u = this.tts.usage?.();
    const llm = this.llmUsage;
    if (!u?.characters && !llm.requests) return undefined;
    return {
      ...(u?.characters
        ? {
            ttsProvider: u.provider,
            ttsModel: u.model,
            ttsCharacters: u.characters,
            ...(u.credits !== undefined ? { ttsCredits: u.credits } : {}),
          }
        : {}),
      ...(llm.requests
        ? {
            llmModel: llm.model,
            llmPromptTokens: llm.promptTokens,
            llmCachedPromptTokens: llm.cachedPromptTokens,
            llmCompletionTokens: llm.completionTokens,
            llmRequests: llm.requests,
          }
        : {}),
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
      // Fürs A/B-Log: Trug eine Spekulation diesen Turn (hit) oder wurde sie verworfen (miss)?
      this.eagerOutcome = spec ? "miss" : undefined;
      if (spec && spec.gen === this.generation && text && sameUtterance(spec.transcript, text)) {
        this.eagerOutcome = "hit";
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
      // info statt debug: die Verwerfungsquote ist die zentrale Tuning-Größe fürs Threshold.
      this.log.info("TurnResumed — Spekulation verworfen", { transcript: spec.transcript });
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
  /**
   * LLM-Verbrauch dieses Anrufs (0.10.0). Summiert über alle Turns UND Tool-Runden — die
   * Zahlen liegen im Stream ohnehin an (llmStream.ts liest sie), bis hierher landeten sie
   * nur im Debug-Log. `llmModel` hält das TATSÄCHLICH benutzte Modell fest, damit ein Agent
   * ohne eigene Modellwahl nicht ohne Preisgrundlage dasteht.
   */
  private llmUsage = {
    model: "" as string,
    promptTokens: 0,
    cachedPromptTokens: 0,
    completionTokens: 0,
    requests: 0,
  };

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
        this.log.info("Turn-Latenz", {
          ...latency,
          ...(this.eagerOutcome ? { eager: this.eagerOutcome } : {}),
          // Enthält die Tool-Wartezeit → beim A/B-Vergleich getrennt auswerten.
          ...(this.fillerSpokenThisTurn ? { afterFiller: true } : {}),
        });
      }
      this.emit("audio", chunk);
    });
    this.tts.on("flushed", () => {
      if (!this.closed && this.llmDone && this.ttsGen === this.generation) {
        this.emit("agentAudioDone");
      }
    });
    /**
     * Barge-in vom Anbieter bestätigt (nur Flux TTS): `text_spoken` ist das, was
     * der Anrufer WIRKLICH gehört hat. Ohne dieses Event fehlt der halbe Satz
     * komplett in der Historie — runAssistantTurn schreibt den Assistententurn
     * erst nach vollständigem LLM-Stream, und bei Barge-in kehrt der catch vorher
     * zurück. Das Modell weiß dann nicht, was es gesagt hat, als es unterbrochen
     * wurde, und wiederholt es gern.
     *
     * Bewusst NICHT generationsgegated: Gesprochen ist gesprochen, unabhängig
     * davon, ob der Turn abgebrochen wurde (gleiche Begründung wie bei
     * sendFunctionResponse).
     */
    this.tts.on("interrupted", (ev: { spokenText: string; audioPlayedMs: number }) => {
      const text = ev.spokenText.trim();
      if (!text || this.closed) return;
      this.log.debug("Barge-in: tatsächlich gesprochener Text", {
        chars: text.length,
        audioPlayedMs: ev.audioPlayedMs,
      });
      this.history.addAssistant(text);
      this.emit("conversationText", { role: "assistant", content: text });
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
    this.toolWaitSpoken = true; // die (Folge-)Runde spricht → ein wartender Filler ist unnötig
    if (!this.firstSentenceAt) this.firstSentenceAt = Date.now();
    this.ttsGen = gen;
    this.tts.sendText(text);
  }

  // ── Timer-Filler (Tool-Wartezeiten) ─────────────────────────────────────────

  /** Fillbar = mindestens ein customTool/MCP-Tool und KEIN end_call/transfer_call in der Runde. */
  private isFillableRound(calls: Array<{ function: { name: string } }>): boolean {
    const names = calls.map((c) => c.function.name);
    if (names.some((n) => n === "end_call" || n === "transfer_call")) return false;
    return names.some((n) => !(BUILTIN_TOOL_NAMES as readonly string[]).includes(n));
  }

  private armFiller(
    gen: number,
    round: ToolRound,
    calls: Array<{ function: { name: string } }>,
    announceText: string,
  ): void {
    // Ein Ansage-Text der Runde (falls das Modell etwas sagte) verschiebt den Filler um dessen
    // geschätzte Sprechdauer (~14 Zeichen/s) → eine echte Ansage verdrängt den Filler natürlich.
    const extraMs = Math.ceil(((announceText?.length ?? 0) / 14) * 1000);
    const names = calls.map((c) => c.function.name);
    this.cancelFillerTimer = this.deps.setTimer(
      () => this.fireFiller(gen, round, names, 1),
      this.agent.fillers.delayMs + extraMs,
    );
  }

  private fireFiller(gen: number, round: ToolRound, names: string[], repeatsLeft: number): void {
    this.cancelFillerTimer = undefined;
    if (this.closed || gen !== this.generation) return; // Barge-in/close
    if (this.toolRound !== round) return; // Runde schon aufgelöst — Antwort ist unterwegs
    if (this.toolWaitSpoken) return; // Folgerunde sprach bereits
    const phrase = this.resolveFillerPhrase(names);
    if (!phrase.trim()) return;
    // Symmetrisch zur "Stille-Ansage" im callHandler: ohne diese Zeile ist der Filler nur im
    // Transkript sichtbar, nicht im Log — und damit im Betrieb kaum zu diagnostizieren.
    this.log.info("Filler-Ansage", { text: phrase, tools: names, repeat: repeatsLeft === 0 });
    this.speakFiller(phrase, gen);
    if (repeatsLeft > 0) {
      this.cancelFillerTimer = this.deps.setTimer(
        () => this.fireFiller(gen, round, names, repeatsLeft - 1),
        6000,
      );
    }
  }

  /** Per-Tool-Ansage (falls definiert) vor rotierendem Pool — beides über den Localizer (lokalisiert). */
  private resolveFillerPhrase(names: string[]): string {
    for (const name of names) {
      const tool = this.agent.customTools.find(
        (t) => t.name === name && t.enabled && t.fillerPhrase?.trim(),
      );
      if (tool) return this.localizer?.resolve(`tool.${name}`) ?? tool.fillerPhrase!.trim();
    }
    if (this.localizer) return this.localizer.resolve("filler", this.fillerIndex++);
    // Fallback ohne injizierten Localizer (z. B. Tests): direkter Pool-Zugriff.
    const phrases = this.agent.fillers.phrases;
    return phrases.length ? (phrases[this.fillerIndex++ % phrases.length] ?? "") : "";
  }

  /**
   * Filler sprechen — bewusst NICHT über speak(): setzt kein toolWaitSpoken (sonst würde der
   * Filler seine eigene Wiederholung abwürgen) und geht NICHT in die LLM-Historie (eine
   * assistant-Message zwischen tool_calls und tool-Antworten wäre ein OpenAI-400). Nur ins Transkript.
   */
  private speakFiller(text: string, gen: number): void {
    if (gen !== this.generation || this.closed) return;
    this.ttsGen = gen; // Audio-Gate passieren lassen
    // Filler ist nicht die substanzielle Antwort → aus dem Latenz-Emit heraushalten (A/B sauber).
    // Die Fortsetzung nach der Tool-Antwort wird dafür neu scharf geschaltet (s. runAssistantTurn).
    this.startedSpeakingEmitted = true;
    this.fillerSpokenThisTurn = true;
    this.tts.sendText(text);
    this.tts.flush();
    this.emit("conversationText", { role: "assistant", content: text });
  }

  private clearFiller(): void {
    this.cancelFillerTimer?.();
    this.cancelFillerTimer = undefined;
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
    this.clearFiller(); // laufenden Filler-Timer abbrechen (Barge-in/injectMessage/close)
    this.tts.clear(this.pendingPlayoutMs?.() ?? 0);
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
    this.fillerSpokenThisTurn = false;
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
            promptCache: config.llm.promptCache,
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
        this.llmUsage.model = model;
        this.llmUsage.requests += 1;
        if (result.usage) {
          const u = result.usage;
          this.llmUsage.promptTokens += u.promptTokens ?? 0;
          this.llmUsage.cachedPromptTokens += u.cachedTokens ?? 0;
          this.llmUsage.completionTokens += u.completionTokens ?? 0;
          this.log.debug("LLM-Nutzung", {
            model,
            promptTokens: u.promptTokens,
            completionTokens: u.completionTokens,
            cachedTokens: u.cachedTokens,
            cacheWriteTokens: u.cacheWriteTokens,
          });
          // Caching an, Praefix aber zu kurz: die API ignoriert den Breakpoint
          // kostenneutral — ohne Hinweis sucht man den ausbleibenden Effekt im Code.
          if (
            !this.cacheDiagLogged &&
            config.llm.promptCache &&
            !u.cachedTokens &&
            !u.cacheWriteTokens &&
            promptCacheBelowMinimum(this.history.messages(), model, true, this.tools)
          ) {
            this.cacheDiagLogged = true;
            this.log.info("Prompt-Caching wirkungslos: System-Prompt unter Mindestlaenge", {
              model,
              promptTokens: u.promptTokens,
            });
          }
        }
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
          // Timer-Filler: droht während einer langsamen customTool/MCP-Runde Stille, spricht
          // der Agent nach delayMs eine kurze (lokalisierte) Ansage. NICHT bei end_call
          // (Runde nie beantwortet) / transfer_call (Modell kündigt selbst an).
          this.toolWaitSpoken = false;
          if (this.agent.fillers.enabled && this.isFillableRound(result.toolCalls)) {
            this.armFiller(gen, this.toolRound!, result.toolCalls, result.content);
          }
          // end_call-Muster: der callHandler beantwortet end_call bewusst NICHT —
          // die Runde bleibt offen, der Abschied ist bereits in der TTS, der Hangup
          // kommt drain-basiert. cancelActiveTurn()/close() weckt uns auf.
          await done;
          this.clearFiller();
          if (gen !== this.generation || this.closed) return;
          if (this.fillerSpokenThisTurn) {
            // Messung für die Fortsetzung neu scharf schalten. `eotAt` bleibt stehen — `total`
            // ist bewusst die volle Wartezeit des Anrufers inklusive Tool; ttt/tts der ersten
            // Runde wären hier veraltet und werden ab dieser Runde neu genommen.
            this.startedSpeakingEmitted = false;
            this.firstTokenAt = 0;
            this.firstSentenceAt = 0;
          }
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
      this.clearFiller(); // Absicherung: kein Filler-Timer überlebt das Turn-Ende
      if (this.activeAbort === abort) this.activeAbort = undefined;
    }
  }
}
