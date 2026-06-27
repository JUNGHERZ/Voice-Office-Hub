/**
 * Post-Call-Summary: läuft nach dem Gespräch einmal über das Transkript und erzeugt
 * eine Zusammenfassung via Requesty (OpenAI-kompatibler Chat-Completion-Request) —
 * dieselbe LLM-Anbindung wie der live `think`-Schritt.
 *
 * Asynchron nach Hangup aufrufen; blockiert den Anruf nicht.
 */
import { config } from "../config.js";
import * as repo from "../db/repository.js";
import type { TranscriptTurn } from "../db/repository.js";
import type { ResolvedAgent } from "../types.js";
import { logger } from "../util/logger.js";

const log = logger.child({ mod: "summarize" });

export interface SummaryResult {
  text: string;
  model: string;
}

export async function summarizeTranscript(
  transcript: TranscriptTurn[],
  prompt: string,
  model?: string,
): Promise<SummaryResult> {
  const usedModel = model || config.llm.model;
  const transcriptText = transcript
    .map((t) => `[${t.t.toFixed(1)}s] ${t.speaker}: ${t.text}`)
    .join("\n");

  const res = await fetch(`${config.llm.requestyBaseUrl.replace(/\/$/, "")}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${config.llm.requestyApiKey}`,
    },
    body: JSON.stringify({
      model: usedModel,
      messages: [
        { role: "system", content: prompt },
        { role: "user", content: transcriptText },
      ],
      temperature: 0.3,
    }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    log.error("Summary-Request fehlgeschlagen", { status: res.status, body });
    throw new Error(`Requesty ${res.status}`);
  }

  const json = (await res.json()) as ChatCompletionResponse;
  const text = json.choices?.[0]?.message?.content?.trim() ?? "";
  return { text, model: usedModel };
}

interface ChatCompletionResponse {
  choices?: Array<{ message?: { content?: string } }>;
}

/**
 * Post-Call-Summary für einen Request: liest das Transkript, ruft Requesty und schreibt
 * `requests.summary`. Gemeinsam genutzt von Agent- und Passthrough-Modus. Asynchron
 * aufrufen (blockiert den Anruf nicht); Fehler werden geloggt, nicht geworfen.
 */
export async function runPostCallSummary(
  requestId: string,
  agent: Pick<ResolvedAgent, "summary">,
  childLog: ReturnType<typeof logger.child> = log,
): Promise<void> {
  try {
    await repo.setSummary(requestId, { status: "pending" });
    const transcript = await repo.getTranscript(requestId);
    if (!transcript.length) {
      await repo.setSummary(requestId, { status: "done", text: "", model: agent.summary.model });
      return;
    }
    const { text, model } = await summarizeTranscript(transcript, agent.summary.prompt, agent.summary.model);
    await repo.setSummary(requestId, { status: "done", text, model, createdAt: new Date() });
    childLog.info("Summary erstellt", { chars: text.length });
  } catch (err) {
    childLog.warn("Summary fehlgeschlagen", { err: String(err) });
    await repo.setSummary(requestId, { status: "failed" });
  }
}
