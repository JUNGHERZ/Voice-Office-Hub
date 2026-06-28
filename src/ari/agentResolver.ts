/**
 * Löst pro eingehendem Anruf den zuständigen Agent auf:
 *   1. Suche in der `agents`-Collection nach der gewählten DDI (targetNumber).
 *   2. Kein Treffer → Default-Agent aus der Config (heutiges ENV-Verhalten als Fallback).
 *
 * Beide Wege liefern einen normalisierten `ResolvedAgent`, mit dem der restliche Code arbeitet.
 */
import { config } from "../config.js";
import { Agent } from "../db/models/Agent.js";
import type { ResolvedAgent, ThinkSource } from "../types.js";
import { logger } from "../util/logger.js";
import { normalizePhone } from "../util/phone.js";

const log = logger.child({ mod: "agentResolver" });

export async function resolveAgent(targetNumber?: string): Promise<ResolvedAgent> {
  if (targetNumber) {
    // 1. Exakte Übereinstimmung (schnellster Pfad, deckt Dev-Durchwahlen wie 120 ab).
    let doc = await Agent.findOne({ enabled: true, targetNumbers: targetNumber }).lean();

    // 2. Normalisierter Vergleich (E.164-Varianten: +49…/0049…/Trennzeichen). Erst bei Miss,
    //    daher selten; pro Appliance gibt es nur wenige Agents → vollständiger Scan vertretbar.
    if (!doc) {
      const want = normalizePhone(targetNumber);
      if (want) {
        const candidates = await Agent.find({ enabled: true }).lean();
        doc =
          candidates.find((a) =>
            (a.targetNumbers ?? []).some((n: string) => normalizePhone(n) === want),
          ) ?? null;
      }
    }

    if (doc) {
      log.info("Agent per DDI aufgelöst", { agent: doc.name, targetNumber });
      return fromDoc(doc);
    }
  }
  log.info("Kein Agent für DDI — Default-Agent", { targetNumber });
  return defaultAgent();
}

function defaultAgent(): ResolvedAgent {
  const d = config.defaultAgent;
  return {
    name: "default",
    mode: (config.defaultAgent.mode === "passthrough" ? "passthrough" : "agent"),
    passthroughTarget: config.transfer.passthroughTarget || undefined,
    language: d.language,
    greeting: d.greeting,
    prompt: d.prompt,
    listen: {
      model: d.listenModel,
      language_hints: ["de", "en"],
      keyterms: [],
      smart_format: true,
    },
    think: {
      source: config.llm.provider,
      model: config.llm.model,
      temperature: 0.5,
    },
    speak: {
      provider: "deepgram",
      model: d.speakModel,
    },
    tools: ["transfer_call", "end_call"],
    summary: {
      enabled: config.summary.enabled,
      prompt: config.summary.prompt,
      model: config.summary.model,
    },
    tags: [],
    mip_opt_out: false,
  };
}

// `doc` ist ein lean()-Ergebnis des Agent-Schemas.
function fromDoc(doc: Record<string, any>): ResolvedAgent {
  return {
    id: String(doc._id),
    name: doc.name,
    mode: doc.mode ?? "agent",
    passthroughTarget: doc.passthroughTarget ?? config.transfer.passthroughTarget ?? undefined,
    language: doc.language ?? doc.listen?.language ?? config.defaultAgent.language,
    greeting: doc.greeting ?? config.defaultAgent.greeting,
    prompt: doc.prompt ?? config.defaultAgent.prompt,
    listen: {
      model: doc.listen?.model ?? config.defaultAgent.listenModel,
      language_hints: doc.listen?.language_hints ?? ["de", "en"],
      keyterms: doc.listen?.keyterms ?? [],
      smart_format: doc.listen?.smart_format ?? true,
      eot_threshold: doc.listen?.eot_threshold,
      eot_timeout_ms: doc.listen?.eot_timeout_ms,
    },
    think: {
      source: (doc.think?.source ?? config.llm.provider) as ThinkSource,
      model: doc.think?.model ?? config.llm.model,
      temperature: doc.think?.temperature ?? 0.5,
      reasoning_mode: doc.think?.reasoning_mode,
      context_length: doc.think?.context_length,
    },
    speak: {
      provider: doc.speak?.provider ?? "deepgram",
      model: doc.speak?.model ?? config.defaultAgent.speakModel,
      voice: doc.speak?.voice,
      language: doc.speak?.language,
      speed: doc.speak?.speed,
      volume: doc.speak?.volume,
    },
    tools: doc.tools ?? ["transfer_call", "end_call"],
    summary: {
      enabled: doc.summary?.enabled ?? config.summary.enabled,
      prompt: doc.summary?.prompt || config.summary.prompt,
      model: doc.summary?.model || config.summary.model,
    },
    tags: doc.tags ?? [],
    mip_opt_out: doc.mip_opt_out ?? false,
  };
}
