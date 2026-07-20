/**
 * Gemeinsame Domänentypen. `ResolvedAgent` ist die normalisierte Form, auf die sowohl
 * der Default-Agent (aus config) als auch ein DB-Agent abgebildet werden — der gesamte
 * restliche Code (settings-Builder, callHandler) arbeitet nur damit.
 */
import type { ThinkSource, CallMode } from "./db/models/Agent.js";
import type { VoiceProvider } from "./voice/types.js";

export type { ThinkSource, CallMode };
export type { VoiceProvider };

export interface ResolvedListen {
  model: string;
  language_hints: string[];
  keyterms: string[];
  smart_format: boolean;
  eot_threshold?: number;
  eot_timeout_ms?: number;
}

export interface ResolvedThink {
  source: ThinkSource;
  model: string;
  temperature: number;
  reasoning_mode?: "low" | "medium" | "high";
  context_length?: number | "max";
}

export interface ResolvedSpeak {
  provider: string;
  model: string;
  voice?: string;
  language?: string;
  speed?: number;
  volume?: number;
}

export interface ResolvedCustomToolEndpoint {
  url: string;
  method: "GET" | "POST";
  /** Werte dürfen `${ENV:NAME}`-Platzhalter enthalten (Auflösung erst beim Aufruf). */
  headers: Record<string, string>;
  timeoutMs: number;
}

/** Am Agent hinterlegtes HTTP-Tool (Engine ruft den Endpoint selbst auf). */
export interface ResolvedCustomTool {
  name: string;
  description: string;
  /** JSON-Schema der Argumente (geht 1:1 als function.parameters an den Voice-Provider). */
  parameters: Record<string, unknown>;
  endpoint: ResolvedCustomToolEndpoint;
  enabled: boolean;
}

export interface ResolvedSummary {
  enabled: boolean;
  prompt: string;
  /** Eigenes Summary-Modell (Requesty), unabhängig vom Konversations-Modell (think). */
  model: string;
}

export interface ResolvedAgent {
  id?: string;
  name: string;
  mode: CallMode;
  /** Welche Voice-Plattform den Anruf bedient (siehe voice/factory.ts). */
  voiceProvider: VoiceProvider;
  passthroughTarget?: string;
  /** Eigene DDIs des Agenten (für die Absender-CLI bei externem Transfer/Outbound). */
  targetNumbers: string[];
  /** Bei externem Transfer die Original-Anrufernummer als Absender präsentieren (CLIP no screening). */
  useTransferCallerId: boolean;
  /** STT-Sprache → agent.listen.provider.language ("multi" für nova-3 multilingual, "de", "en", …). */
  language: string;
  greeting?: string;
  prompt: string;
  listen: ResolvedListen;
  think: ResolvedThink;
  speak: ResolvedSpeak;
  tools: string[];
  customTools: ResolvedCustomTool[];
  summary: ResolvedSummary;
  tags: string[];
  mip_opt_out: boolean;
}
