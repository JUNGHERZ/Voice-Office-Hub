/**
 * Ausgehende Ereignis-Zustellung (0.9.0).
 *
 * Ein externer Empfänger bekommt Gesprächsereignisse zugestellt, statt `/api/requests`
 * zu pollen. Die Warteschlange liegt im Speicher und ist bewusst schlicht:
 *   - `emit()` blockiert nie — kein Anruf wartet auf einen fremden HTTP-Endpunkt;
 *   - wiederholt wird bei Timeout, 5xx und 429 mit exponentiellem Backoff. Ein 4xx
 *     (außer 429) ist ein Vertragsfehler und wird NICHT wiederholt, sondern einmal laut
 *     protokolliert — sonst hämmert die Engine gegen eine Wand;
 *   - die Warteschlange ist gedeckelt. Ein endliches Limit ohne Verwerfen erzeugt genau
 *     die Hänger, die es verhindern soll: lieber verwerfen und protokollieren als stauen.
 *
 * Die Reihenfolge der Zustellung ist NICHT zugesichert (mehrere Arbeiter, Wiederholungen).
 * Der Empfänger dedupliziert über (`call.id`, `event`, `seq`); `X-VOH-Delivery` bleibt über
 * Wiederholungen konstant.
 *
 * Ohne `WEBHOOK_URL` ist der Notifier inert — kein Timer, kein Verkehr.
 */
import { randomUUID } from "node:crypto";

import { config } from "../config.js";
import { fetchWithTimeout } from "../util/http.js";
import { logger } from "../util/logger.js";
import { signBody } from "../util/signature.js";

const log = logger.child({ mod: "webhooks" });

/** Gleichzeitige Zustellungen. Reihenfolge ist ohnehin nicht zugesichert. */
const WORKERS = 4;

export interface NotifierOptions {
  url?: string;
  secret?: string;
  timeoutMs?: number;
  maxRetries?: number;
  queueLimit?: number;
  /** Wartezeit vor dem nächsten Versuch (Tests reichen 0 ein). */
  backoffMs?: (attempt: number) => number;
}

export interface Notifier {
  /** Feuert und vergisst. Wirft nie. */
  emit(event: string, payload: Record<string, unknown>): void;
  /** Wartet, bis die Warteschlange leer ist — höchstens `deadlineMs`. */
  flush(deadlineMs?: number): Promise<void>;
  /** Offene Zustellungen (Warteschlange + laufende Versuche). */
  pending(): number;
}

interface Job {
  event: string;
  callId: unknown;
  body: string;
  delivery: string;
  attempt: number;
}

/** 1 s, 2 s, 4 s … mit etwas Streuung, damit nicht alle Wiederholungen gleichzeitig laufen. */
function defaultBackoff(attempt: number): number {
  return Math.round(1000 * 2 ** (attempt - 1) * (0.85 + Math.random() * 0.3));
}

export function createNotifier(opts: NotifierOptions = {}): Notifier {
  const url = opts.url ?? config.webhooks.url;
  const secret = opts.secret ?? config.webhooks.secret;
  const timeoutMs = opts.timeoutMs ?? config.webhooks.timeoutMs;
  const maxRetries = opts.maxRetries ?? config.webhooks.maxRetries;
  const queueLimit = opts.queueLimit ?? config.webhooks.queueLimit;
  const backoffMs = opts.backoffMs ?? defaultBackoff;

  const queue: Job[] = [];
  const timers = new Set<NodeJS.Timeout>();
  let active = 0;

  const pending = () => queue.length + active + timers.size;

  function enqueue(job: Job): void {
    if (queue.length >= queueLimit) {
      // Ältestes verwerfen: das jüngste Ereignis ist das aussagekräftigere (z. B. call.ended).
      const dropped = queue.shift();
      log.error("Warteschlange voll — Ereignis verworfen", {
        event: dropped?.event,
        callId: dropped?.callId,
        queueLimit,
      });
    }
    queue.push(job);
    pump();
  }

  function pump(): void {
    while (active < WORKERS && queue.length) {
      const job = queue.shift() as Job;
      active++;
      void deliver(job).finally(() => {
        active--;
        pump();
      });
    }
  }

  function retryLater(job: Job): void {
    const delay = backoffMs(job.attempt);
    const timer = setTimeout(() => {
      timers.delete(timer);
      queue.push(job);
      pump();
    }, delay);
    // Eine offene Wiederholung darf den Prozess nicht am Beenden hindern.
    timer.unref?.();
    timers.add(timer);
  }

  async function deliver(job: Job): Promise<void> {
    job.attempt++;
    try {
      const res = await fetchWithTimeout(url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-voh-event": job.event,
          "x-voh-delivery": job.delivery,
          ...(secret ? { "x-voh-signature": signBody(job.body, secret) } : {}),
        },
        body: job.body,
        timeoutMs,
      });
      if (res.ok) return;
      // 4xx außer 429: der Empfänger lehnt den Inhalt ab — Wiederholen ändert daran nichts.
      if (res.status >= 400 && res.status < 500 && res.status !== 429) {
        log.error("Empfänger lehnt Ereignis ab — keine Wiederholung", {
          event: job.event,
          callId: job.callId,
          status: res.status,
        });
        return;
      }
      throw new Error(`HTTP ${res.status}`);
    } catch (err) {
      if (job.attempt > maxRetries) {
        log.error("Ereignis nach allen Versuchen nicht zugestellt", {
          event: job.event,
          callId: job.callId,
          attempts: job.attempt,
          err: String(err),
        });
        return;
      }
      log.warn("Zustellung fehlgeschlagen — Wiederholung", {
        event: job.event,
        callId: job.callId,
        attempt: job.attempt,
        err: String(err),
      });
      retryLater(job);
    }
  }

  return {
    emit(event, payload) {
      if (!url) return;
      try {
        // Einmal serialisieren: signiert und gesendet wird exakt dieselbe Zeichenkette,
        // auch bei jeder Wiederholung.
        const body = JSON.stringify({ event, sentAt: new Date().toISOString(), ...payload });
        enqueue({
          event,
          callId: (payload.call as Record<string, unknown> | undefined)?.id,
          body,
          delivery: randomUUID(),
          attempt: 0,
        });
      } catch (err) {
        log.error("Ereignis nicht serialisierbar — verworfen", { event, err: String(err) });
      }
    },
    async flush(deadlineMs = 5000) {
      const until = Date.now() + deadlineMs;
      while (pending() && Date.now() < until) {
        await new Promise<void>((r) => setTimeout(r, 25));
      }
      if (pending()) log.warn("Shutdown mit offenen Zustellungen", { pending: pending() });
    },
    pending,
  };
}

/** Prozessweiter Notifier aus der Config — genutzt vom Repo-Dekorator und beim Shutdown. */
export const notifier: Notifier = createNotifier();
