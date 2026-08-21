/**
 * Repository mit Ereignis-Zustellung (0.9.0).
 *
 * Die `requests`-Schreibpfade liegen alle in `repository.ts` — genau eine Stelle, an der
 * sich beobachten lässt, was einem Anruf widerfährt. Deshalb hängen die Ereignisse hier
 * und nicht im callHandler: kein Aufrufer muss daran denken, und `passthrough` (das das
 * Repo direkt benutzt) ist ohne Sonderfall mit abgedeckt.
 *
 * | Ereignis          | ausgelöst durch                            |
 * | ----------------- | ------------------------------------------ |
 * | `call.started`    | createRequest                              |
 * | `call.ended`      | finalizeRequest mit status "completed"     |
 * | `call.failed`     | finalizeRequest mit status "failed"        |
 * | `recording.ready` | setRecording                               |
 * | `tool.called`     | appendFunctionCall                         |
 *
 * Kein Ereignis für `appendTranscript` — die Turns kommen gesammelt in `call.ended`.
 * Ohne `WEBHOOK_URL` ist der Dekorator ein reiner Durchreicher (auch ohne den Nachlesevorgang
 * beim Finalisieren).
 */
import type { Types } from "mongoose";

import { config } from "../config.js";
import { logger } from "../util/logger.js";
import { notifier, type Notifier } from "../webhooks/notifier.js";
import { RequestModel } from "./models/Request.js";
import * as repo from "./repository.js";

const log = logger.child({ mod: "callRepo" });

/** Nach dieser Zeit gilt ein Anruf-Kontext als Leiche (Absturz zwischen Start und Ende). */
const CONTEXT_TTL_MS = 6 * 60 * 60 * 1000;

/** Was die kleinen Ereignisse brauchen, ohne dafür die Datenbank zu lesen. */
interface CallContext {
  id: string;
  channelId?: string;
  mode: "agent" | "passthrough";
  from?: string;
  to?: string;
  agentId?: string;
  agentRef?: string;
  externalRef?: string;
  resolverStatus?: "ok" | "unavailable";
  startedAt: Date;
  seq: number;
}

export interface EventRepoOptions {
  enabled?: boolean;
  /** Nur beim Finalisieren: das fertige Dokument für die volle Nutzlast. */
  loadRequest?: (id: string) => Promise<Record<string, any> | null>;
}

function loadRequestDoc(id: string): Promise<Record<string, any> | null> {
  return RequestModel.findById(id).lean() as Promise<Record<string, any> | null>;
}

export function createEventRepo(
  base: typeof repo,
  sink: Notifier,
  opts: EventRepoOptions = {},
): typeof repo {
  const enabled = opts.enabled ?? !!config.webhooks.url;
  if (!enabled) return base;

  const loadRequest = opts.loadRequest ?? loadRequestDoc;
  const contexts = new Map<string, CallContext>();

  function sweep(now: number): void {
    for (const [id, ctx] of contexts) {
      if (now - ctx.startedAt.getTime() > CONTEXT_TTL_MS) contexts.delete(id);
    }
  }

  /** Umschlag bauen und `seq` weiterzählen. `call.id` steht in JEDEM Ereignis. */
  function envelope(
    ctx: CallContext,
    call: Record<string, unknown>,
    rest: Record<string, unknown> = {},
  ): Record<string, unknown> {
    return {
      seq: ctx.seq++,
      ...(ctx.agentId ? { agentId: ctx.agentId } : {}),
      ...(ctx.agentRef ? { agentRef: ctx.agentRef } : {}),
      ...(ctx.externalRef ? { externalRef: ctx.externalRef } : {}),
      call: {
        id: ctx.id,
        ...(ctx.channelId ? { channelId: ctx.channelId } : {}),
        mode: ctx.mode,
        ...(ctx.from ? { from: ctx.from } : {}),
        ...(ctx.to ? { to: ctx.to } : {}),
        startedAt: ctx.startedAt.toISOString(),
        ...(ctx.resolverStatus ? { resolverStatus: ctx.resolverStatus } : {}),
        ...call,
      },
      ...rest,
    };
  }

  /** Kontext eines laufenden Anrufs — nach einem Neustart aus dem Dokument rekonstruiert. */
  function context(id: string, doc?: Record<string, any> | null): CallContext | undefined {
    const known = contexts.get(id);
    if (known) return known;
    if (!doc) return undefined;
    const rebuilt: CallContext = {
      id,
      channelId: doc.channelId,
      mode: doc.mode ?? "agent",
      from: doc.callerNumber,
      to: doc.targetNumber,
      agentId: doc.agentId ? String(doc.agentId) : undefined,
      agentRef: doc.agentRef,
      externalRef: doc.externalRef,
      resolverStatus: doc.resolverStatus,
      startedAt: doc.startedAt ? new Date(doc.startedAt) : new Date(),
      seq: 0,
    };
    contexts.set(id, rebuilt);
    return rebuilt;
  }

  return {
    ...base,

    async createRequest(input: repo.NewRequestInput): Promise<string> {
      const id = await base.createRequest(input);
      const now = Date.now();
      sweep(now);
      const ctx: CallContext = {
        id,
        channelId: input.channelId,
        mode: input.mode,
        from: input.callerNumber,
        to: input.targetNumber,
        agentId: input.agentId ? String(input.agentId) : undefined,
        agentRef: input.agentRef,
        externalRef: input.externalRef,
        resolverStatus: input.resolverStatus,
        startedAt: new Date(now),
        seq: 0,
      };
      contexts.set(id, ctx);
      sink.emit("call.started", envelope(ctx, {}));
      return id;
    },

    async appendFunctionCall(id: string, call: repo.FunctionCallRecord): Promise<void> {
      await base.appendFunctionCall(id, call);
      const ctx = context(id);
      if (!ctx) return;
      sink.emit(
        "tool.called",
        envelope(ctx, {}, {
          tool: {
            name: call.name,
            arguments: call.arguments,
            result: call.result,
            status: call.status,
            requestedAt: call.requestedAt?.toISOString?.() ?? call.requestedAt,
            completedAt: call.completedAt?.toISOString?.() ?? call.completedAt,
          },
        }),
      );
    },

    async setRecording(
      id: string,
      recording: {
        gridFsId: Types.ObjectId;
        filename: string;
        durationSec?: number;
        channels?: "mixed" | "separate";
      },
    ): Promise<void> {
      await base.setRecording(id, recording);
      const ctx = context(id);
      if (!ctx) return;
      sink.emit(
        "recording.ready",
        envelope(ctx, {}, {
          recording: { available: true, durationSec: recording.durationSec ?? 0 },
        }),
      );
    },

    async finalizeRequest(
      id: string,
      status: "completed" | "failed",
      metrics?: repo.CallMetrics,
      endedReason?: string,
    ): Promise<void> {
      await base.finalizeRequest(id, status, metrics, endedReason);
      // Der einzige Nachlesevorgang: Transkript, Tool-Aufrufe, Transfer, Aufnahme und
      // Metriken stehen erst jetzt vollständig — und er liegt hinter dem Anrufende.
      const doc = await loadRequest(id).catch((err) => {
        log.warn("Request für Abschluss-Ereignis nicht lesbar", { id, err: String(err) });
        return null;
      });
      const ctx = context(id, doc);
      if (!ctx) return;
      contexts.delete(id);
      // Aus dem Dokument, sonst aus dem Aufruf (falls das Nachlesen scheiterte).
      const endReason = doc?.endedReason ?? endedReason;
      sink.emit(
        status === "completed" ? "call.ended" : "call.failed",
        envelope(
          ctx,
          {
            ...(doc?.endedAt ? { endedAt: new Date(doc.endedAt).toISOString() } : {}),
            ...(doc?.durationSec !== undefined ? { durationSec: doc.durationSec } : {}),
            ...(doc?.language ? { language: doc.language } : {}),
            // Freier String, absichtlich ohne Aufzählung: Ein künftig ergänzter Grund darf
            // beim Empfänger nicht als Validierungsfehler landen.
            ...(endReason ? { endedReason: endReason } : {}),
          },
          {
            // Inhalt, nicht Metadatum — deshalb neben dem Transkript und nicht im `call`-Block.
            ...(doc?.greetingText ? { greetingText: doc.greetingText } : {}),
            transcript: doc?.transcript ?? [],
            functionCalls: doc?.functionCalls ?? [],
            ...(doc?.transfer ? { transfer: doc.transfer } : {}),
            recording: {
              available: !!doc?.recording?.gridFsId,
              ...(doc?.recording?.durationSec !== undefined
                ? { durationSec: doc.recording.durationSec }
                : {}),
            },
            ...(doc?.metrics ? { metrics: doc.metrics } : metrics ? { metrics } : {}),
          },
        ),
      );
    },
  };
}

/** Prozessweites Repo inklusive Ereignis-Zustellung — von callHandler und passthrough genutzt. */
export const callRepo: typeof repo = createEventRepo(repo, notifier);
