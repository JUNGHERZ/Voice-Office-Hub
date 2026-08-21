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
  /** ElevenLabs voice_settings (nur native Kaskade), 0..1. */
  stability?: number;
  similarityBoost?: number;
  /** Fish-Audio-Feinschliff (0.8.4), 0..1. */
  temperature?: number;
  topP?: number;
  latencyMode?: "low" | "balanced" | "normal";
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
  /** Optionale eigene Filler-Ansage für dieses Tool (Standardsprache; wird zur Laufzeit lokalisiert). */
  fillerPhrase?: string;
}

/** Am Agent hinterlegter MCP-Server als Tool-Quelle (Streamable HTTP, statische Header). */
export interface ResolvedMcpServer {
  /** Präfix der Tool-Namen: `<name>_<tool>` (kollisionsfrei, Deepgram-kompatibel). */
  name: string;
  url: string;
  /** Werte dürfen `${ENV:NAME}`-Platzhalter enthalten (Auflösung erst beim Verbinden). */
  headers: Record<string, string>;
  enabled: boolean;
  /** Leer = alle Tools des Servers; sonst Whitelist der (unpräfixierten) Tool-Namen. */
  toolFilter: string[];
  timeoutMs: number;
}

export interface ResolvedSummary {
  enabled: boolean;
  prompt: string;
  /** Eigenes Summary-Modell (Requesty), unabhängig vom Konversations-Modell (think). */
  model: string;
}

/** Hintergrundatmosphäre im Anruf (leise Dauerschleife unter/zwischen der Agent-Sprache). */
export interface ResolvedAmbience {
  enabled: boolean;
  /** Preset-Id aus audio/ambiencePresets.ts (Manifest). */
  preset: string;
  /** Linearer Pegel 0..1 (0.25 = dezent hörbar). */
  volume: number;
}

/** Timer-Filler bei Tool-Wartezeiten (native): kurze Ansage aus dem Pool, wenn Stille droht. */
export interface ResolvedFillers {
  enabled: boolean;
  /** Verzögerung (ms), bevor der Filler spricht — sofern die Folgerunde nicht vorher antwortet. */
  delayMs: number;
  /** Pool von Ansagen (Standardsprache; werden zur Laufzeit lokalisiert und rotiert). */
  phrases: string[];
}

/**
 * Stille-Reengagement (0.6.27, beide Provider): Schweigt der Anrufer, spricht der Agent eine
 * Ansage aus `phrases` — die Reihenfolge der Zeilen ist die Eskalationsstufe. Die Abstände
 * wachsen je Stufe (Backoff), optional endet die Leiter im Auflegen.
 */
export interface ResolvedIdlePrompts {
  enabled: boolean;
  /** Stille (ms) bis zur ersten Ansage. Spätere Stufen warten anteilig länger. */
  timeoutMs: number;
  /** Wie viele Ansagen pro Stille-Phase, bevor die Leiter endet. */
  maxPrompts: number;
  /** Pool von Ansagen (Standardsprache; werden zur Laufzeit lokalisiert). Index = Stufe. */
  phrases: string[];
  /** Nach der letzten Stufe auflegen (Abschied wird vorher gesprochen). */
  hangupAfter: boolean;
  /** Abschied vor dem Auflegen (Standardsprache; wird lokalisiert). Leer = Config-Default. */
  hangupAnnouncement?: string;
}

/**
 * Was sich der Agent über Anrufe hinweg zu einer Rufnummer merken darf. Gestuft angelegt,
 * damit spätere Fakten (Gesprächsnotizen o. ä.) eigene Zustimmung brauchen statt unter einem
 * Sammel-Schalter mitzulaufen.
 */
export interface ResolvedRecording {
  /** false = dieser Anruf wird nicht mitgeschnitten. Fehlendes Feld gilt als `true`. */
  enabled: boolean;
}

export interface ResolvedCallerMemory {
  /** Zuletzt bestätigte Gesprächssprache merken → Begrüßung beim nächsten Anruf. */
  language: boolean;
}

export interface ResolvedAgent {
  id?: string;
  name: string;
  /** Freie Kennung des anlegenden Systems (0.10.0). Wird nur mitgeführt, nie ausgewertet. */
  externalRef?: string;
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
  /**
   * Sprache, in der Greeting und Ansagen VERFASST sind — die Ausgangssprache jeder Übersetzung.
   * Bewusst getrennt von `language` (das ist die STT-Sprache und bei "multi" ohne Aussage über
   * den Katalog). Wird beim Speichern aus Greeting/Prompt ermittelt, wenn am Agenten leer.
   */
  contentLanguage: string;
  greeting?: string;
  /**
   * Anweisung, aus der die Begrüßung je Anruf entsteht (0.10.0). Gesetzt = `greeting` ist
   * nur noch der Rückfall, wenn die Erzeugung scheitert oder zu lange braucht.
   */
  greetingPrompt?: string;
  /** Harte Obergrenze der Gesprächsdauer in Sekunden (0.10.0). Fehlt = unbegrenzt. */
  maxDurationSec?: number;
  prompt: string;
  listen: ResolvedListen;
  think: ResolvedThink;
  speak: ResolvedSpeak;
  tools: string[];
  customTools: ResolvedCustomTool[];
  mcpServers: ResolvedMcpServer[];
  summary: ResolvedSummary;
  recording: ResolvedRecording;
  ambience: ResolvedAmbience;
  fillers: ResolvedFillers;
  idlePrompts: ResolvedIdlePrompts;
  callerMemory: ResolvedCallerMemory;
  /** Ansage bei fehlgeschlagenem Transfer (Standardsprache; wird lokalisiert). Leer = Config-Default. */
  transferFailedAnnouncement?: string;
  tags: string[];
  mip_opt_out: boolean;
}
