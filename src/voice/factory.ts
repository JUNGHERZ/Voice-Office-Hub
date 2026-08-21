/**
 * Factory: wählt anhand von `agent.voiceProvider` die Session-Implementierung.
 *
 * Neue Provider (geplant: elevenlabs, openai-realtime, grok, native) werden hier als
 * weiterer case ergänzt — der callHandler bleibt unverändert. Provider-Spezifika
 * (Settings-Format, Encoding, KeepAlive) bleiben vollständig im jeweiligen Adapter.
 */
import { AgentSession } from "../deepgram/agentSession.js";
import { buildSettings } from "../deepgram/settings.js";
import { NativeSession, type FillerLocalizer } from "../native/nativeSession.js";
import type { ResolvedAgent } from "../types.js";
import type { FunctionDefinition, VoiceAgentSession } from "./types.js";

export interface VoiceSessionOptions {
  /** Anruf-Bezug für Logging (ARI-Channel-ID). */
  callId: string;
  /** Für den Think-Schritt verfügbare Tools. */
  functions: FunctionDefinition[];
  /** Laufzeit-Lokalisierung der Filler-Ansagen (nur native genutzt; Deepgram ignoriert ihn). */
  localizer?: FillerLocalizer;
  /**
   * Noch nicht abgespieltes Agent-Audio in ms (MediaSession.pendingMs()).
   * Nur der callHandler kennt den Playout-Puffer; TTS-Anbieter mit
   * serverseitigem Truncate (Flux TTS) brauchen ihn fürs Barge-in, um die
   * tatsächlich GEHÖRTE Position zu melden statt der gesendeten.
   * Bewusst ein Callback und keine Referenz — die Session bekommt eine Zahl,
   * keinen Zugriff auf die Medienstrecke (Muster wie FillerLocalizer/setTimer).
   */
  pendingPlayoutMs?: () => number;
  /**
   * false = der Agent spricht nur (reine Ansage, siehe verdict "announce"). Die native
   * Kaskade öffnet dann keinen STT-Strom; gebündelte Provider ignorieren die Angabe,
   * weil dort ein Transport beide Richtungen trägt.
   */
  listen?: boolean;
}

export function createVoiceAgentSession(
  agent: ResolvedAgent,
  opts: VoiceSessionOptions,
): VoiceAgentSession {
  switch (agent.voiceProvider) {
    case "deepgram":
      return new AgentSession(buildSettings(agent, opts.functions), opts.callId);
    case "native":
      // Eigene STT→LLM→TTS-Kaskade: Flux + Requesty + TTS-Matrix (Aura oder ElevenLabs
      // je nach agent.speak.provider — Auswahl/Fallback in native/nativeSession.ts).
      return new NativeSession(
        agent,
        opts.functions,
        opts.callId,
        undefined,
        opts.localizer,
        opts.pendingPlayoutMs,
        opts.listen ?? true,
      );
    // Geplante Adapter — Enum im Agent-Schema erst bei Implementierung freischalten:
    case "elevenlabs":
    case "openai-realtime":
    case "grok":
      throw new Error(`voiceProvider "${agent.voiceProvider}" ist noch nicht implementiert`);
    default:
      throw new Error(`Unbekannter voiceProvider: ${String(agent.voiceProvider)}`);
  }
}
