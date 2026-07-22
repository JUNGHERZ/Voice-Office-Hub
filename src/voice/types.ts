/**
 * Provider-neutrale Voice-Session-Schnittstelle.
 *
 * Der callHandler spricht ausschließlich gegen `VoiceAgentSession` — welcher Anbieter
 * dahinter steht (Deepgram heute; ElevenLabs, OpenAI Realtime, Grok, NativeSession später),
 * entscheidet die Factory (voice/factory.ts) anhand von `agent.voiceProvider`.
 *
 * Dieses Modul importiert bewusst nichts (zyklenfrei): db-Schicht, Tools und Adapter
 * hängen alle hierauf.
 */

/** Alle geplanten Provider (Roadmap); implementiert ist davon nur ein Teil. */
export const VOICE_PROVIDERS = ["deepgram", "elevenlabs", "openai-realtime", "grok", "native"] as const;
export type VoiceProvider = (typeof VOICE_PROVIDERS)[number];

/** Nur diese Werte sind im Agent-Schema zugelassen (DB weist Nichtlauffähiges beim Speichern ab). */
export const IMPLEMENTED_VOICE_PROVIDERS: readonly VoiceProvider[] = ["deepgram", "native"];

/**
 * Tool-/Function-Definition für den Think-Schritt (JSON-Schema-Parameter).
 * Provider-neutral; `endpoint` ist für server-side-Ausführung durch den Provider reserviert
 * (aktuell ungenutzt — wir dispatchen client_side in der Engine).
 */
export interface FunctionDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  endpoint?: { url: string; method?: string; headers?: Record<string, string> };
}

/** Ein Transkript-Turn (User oder Agent), wie ihn der Provider liefert. */
export interface VoiceConversationText {
  role: "user" | "assistant";
  content: string;
}

/** Ein einzelner Function-Call-Wunsch des Providers (Argumente als roher JSON-String). */
export interface VoiceFunctionCall {
  id: string;
  name: string;
  argumentsJson: string;
  /** true = die Engine führt aus (Standardmodell); false = der Provider ruft selbst auf. */
  clientSide: boolean;
}

export interface VoiceFunctionCallRequest {
  functions: VoiceFunctionCall[];
}

/**
 * Verbrauchsdaten der Session (sofern der Adapter sie kennt) — Grundlage der
 * Pro-Anruf-Kostenrechnung. Heute liefert nur die NativeSession Werte (dort
 * senden WIR den TTS-Text und kennen die Abrechnungsbasis zeichengenau);
 * gebündelte Provider (Deepgram-Agent) sprechen intern → undefined.
 */
export interface VoiceSessionUsage {
  ttsProvider?: string;
  ttsModel?: string;
  ttsCharacters?: number;
  ttsCredits?: number;
}

/** Latenz-Angaben des Providers zum Sprechbeginn (sofern geliefert), in Sekunden. */
export interface VoiceAgentLatency {
  total?: number;
  tts?: number;
  ttt?: number;
}

export interface VoiceAgentSessionEvents {
  /** Transportverbindung steht (providerintern; vor `welcome`). */
  open: () => void;
  /** Provider hat die Session bestätigt (Payload: provider-eigene Session-/Request-ID). */
  welcome: (providerSessionId: string) => void;
  /** Provider hat die Konfiguration übernommen. */
  settingsApplied: () => void;
  /** TTS-Audio des Agenten (rohes PCM im systemweiten Format, siehe config.audio). */
  audio: (chunk: Buffer) => void;
  conversationText: (ev: VoiceConversationText) => void;
  functionCallRequest: (ev: VoiceFunctionCallRequest) => void;
  /** Anrufer spricht (auch während der Agent spricht → Barge-in-Trigger). */
  userStartedSpeaking: () => void;
  agentStartedSpeaking: (latency: VoiceAgentLatency) => void;
  agentAudioDone: () => void;
  error: (description: string) => void;
  close: (code: number) => void;
}

/**
 * Eine Voice-Session pro Anruf. Lebenszyklus: Konstruktion ist inert (keine I/O),
 * `start()` verbindet und übermittelt die Konfiguration, `close()` beendet.
 * Encoding/KeepAlive/Wire-Format sind Sache des jeweiligen Adapters.
 */
export interface VoiceAgentSession {
  /** Verbindet zum Provider; resolved, sobald die Session sendebereit ist. */
  start(): Promise<void>;
  /** Anrufer-Audio (rohes PCM) an den Provider streamen. */
  sendAudio(chunk: Buffer): void;
  /** Ergebnis eines client_side-Function-Calls zurückmelden (id = Korrelation). */
  sendFunctionResponse(id: string, name: string, result: unknown): void;
  /** Den Agenten eine vorgegebene Nachricht sprechen lassen (z. B. Transfer-Fehlschlag). */
  injectMessage(message: string): void;
  /** Verbrauch der Session (TTS-Zeichen/Credits), sofern der Adapter ihn kennt. */
  getUsage?(): VoiceSessionUsage | undefined;
  close(): void;
  on<E extends keyof VoiceAgentSessionEvents>(event: E, listener: VoiceAgentSessionEvents[E]): this;
}
