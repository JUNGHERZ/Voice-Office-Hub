/**
 * Gemeinsame Domänentypen. `ResolvedAgent` ist die normalisierte Form, auf die sowohl
 * der Default-Agent (aus config) als auch ein DB-Agent abgebildet werden — der gesamte
 * restliche Code (settings-Builder, callHandler) arbeitet nur damit.
 */
import type { ThinkSource, CallMode } from "./db/models/Agent.js";

export type { ThinkSource, CallMode };

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

export interface ResolvedSummary {
  enabled: boolean;
  prompt: string;
}

export interface ResolvedAgent {
  id?: string;
  name: string;
  mode: CallMode;
  passthroughTarget?: string;
  greeting?: string;
  prompt: string;
  listen: ResolvedListen;
  think: ResolvedThink;
  speak: ResolvedSpeak;
  tools: string[];
  summary: ResolvedSummary;
  tags: string[];
  mip_opt_out: boolean;
}
