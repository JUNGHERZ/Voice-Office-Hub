/**
 * Basisklasse für TTS-Anbieter, die pro Äußerung EINEN HTTP-Request fahren
 * (Mistral Voxtral über SSE, Speechify über chunked HTTP) statt einen dauerhaften
 * Socket zu halten — und die trotzdem hinter TtsStreamLike passen müssen.
 *
 * Die Impedanz-Anpassung besteht aus drei Zusagen:
 *
 *  1. REIHENFOLGE. Der Satz-Chunker feuert mehrere sendText() pro Turn ohne zu
 *     warten; zwei parallel laufende fetch-Reader würden ihr Audio verschränken.
 *     Deshalb Auftragsliste + Head-of-Line-Emitter: jeder Auftrag puffert sein PCM,
 *     nur der vorderste gibt aus. Steht ein Auftrag vorn, geht sein Chunk sofort
 *     raus — gegenüber einer streng seriellen Schleife entsteht keine Zusatzlatenz.
 *  2. FLUSH. `flushed` erst, wenn die Liste leer ist UND nichts mehr läuft.
 *  3. CLEAR (Barge-in). abort() allein genügt nicht: bereits im undici-Reader
 *     liegende Chunks laufen noch durch. Deshalb zusätzlich ein Epochenzähler —
 *     das Gegenstück zum `clearing`-Flag von Aura und zum removeAllListeners
 *     von ElevenLabs.
 *
 * Abgerechnet wird beim ABSENDEN des Requests, nicht bei sendText(): ein per
 * Barge-in verworfener Satz wurde nie gesendet und darf nicht zählen (gleiche
 * Regel wie AuraTtsStream.rawSend).
 */
import { EventEmitter } from "node:events";

import { createResampler, type Resampler } from "../audio/resample.js";
import type { logger } from "../util/logger.js";
import type { TtsStreamEvents } from "./ttsStream.js";
import type { TtsUsage } from "./types.js";

type Logger = ReturnType<typeof logger.child>;

/** Ein Synthese-Auftrag = ein HTTP-Request. Puffert sein PCM, bis er an der Reihe ist. */
interface TtsJob {
  text: string;
  /** Epoche bei Einreihung; ein clear() erhöht sie und macht ältere Aufträge stumm. */
  epoch: number;
  abort: AbortController;
  chunks: Buffer[];
  running: boolean;
  done: boolean;
  /** Segmentgrenze schon gemeldet? (genau einmal, vor dem ersten eigenen PCM) */
  announced: boolean;
}

export interface HttpTtsBaseOptions {
  /** Sample-Rate des Anbieter-PCM (Mistral: 24000; Speechify: System-Rate). */
  sourceRate: number;
  /** Systemweite Ziel-Rate (config.audio.sampleRate). */
  targetRate: number;
  /**
   * Gleichzeitig laufende Requests. 1 = streng seriell, 2 = ein Prefetch.
   * Seriell bedeutet an JEDER Satzgrenze eine Lücke in Höhe der Request-Latenz —
   * MediaSession blendet bei leerer Playout-Queue aus und wieder ein, das ist als
   * Kerbe hörbar. Deshalb ist der Wert konfigurierbar (NATIVE_HTTP_TTS_CONCURRENCY).
   */
  concurrency: number;
}

export declare interface HttpTtsStream {
  on<E extends keyof TtsStreamEvents>(event: E, listener: TtsStreamEvents[E]): this;
  emit<E extends keyof TtsStreamEvents>(event: E, ...args: Parameters<TtsStreamEvents[E]>): boolean;
}

export abstract class HttpTtsStream extends EventEmitter {
  private readonly jobs: TtsJob[] = [];
  private readonly resampler: Resampler;
  private epoch = 0;
  private flushPending = false;
  protected closed = false;
  /** Tatsächlich abgesendete Zeichen (= Abrechnungsbasis). */
  protected charactersSent = 0;

  protected constructor(
    private readonly httpOpts: HttpTtsBaseOptions,
    protected readonly log: Logger,
  ) {
    super();
    // Achtung: sourceRate MUSS über die Options kommen. Ein `abstract readonly`-Feld
    // der Unterklasse wäre hier noch undefined — Feldinitialisierer laufen nach dem
    // Basiskonstruktor.
    this.resampler = createResampler(httpOpts.sourceRate, httpOpts.targetRate);
  }

  /**
   * Einen Satz synthetisieren. MUSS linear16 mono @ sourceRate an onPcm liefern.
   * Abbruch läuft über signal; ein AbortError wird vom Rahmen geschluckt.
   */
  protected abstract synthesize(
    text: string,
    signal: AbortSignal,
    onPcm: (pcm: Buffer) => void,
  ): Promise<void>;

  abstract usage(): TtsUsage;

  /** HTTP kennt keinen Verbindungsaufbau — der erste Satz baut die Verbindung auf. */
  async start(): Promise<void> {}

  sendText(text: string): void {
    if (this.closed || !text) return;
    this.jobs.push({
      text,
      epoch: this.epoch,
      abort: new AbortController(),
      chunks: [],
      running: false,
      done: false,
      announced: false,
    });
    this.startPending();
  }

  flush(): void {
    if (this.closed) return;
    this.flushPending = true;
    this.pump();
  }

  /**
   * Barge-in. Der unplayedMs-Parameter ist Teil des Vertrags (Flux-TTS nutzt ihn
   * für ein serverseitiges Truncate) — HTTP-Anbieter können nichts truncaten und
   * ignorieren ihn.
   */
  clear(_unplayedMs?: number): void {
    this.epoch += 1;
    this.flushPending = false;
    for (const job of this.jobs) job.abort.abort();
    this.jobs.length = 0;
    this.resampler.reset(); // Filterzustand des alten Turns verwerfen
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.epoch += 1;
    this.flushPending = false;
    for (const job of this.jobs) job.abort.abort();
    this.jobs.length = 0;
  }

  /** So viele Aufträge starten, wie die Nebenläufigkeit erlaubt. */
  private startPending(): void {
    const limit = Math.max(1, this.httpOpts.concurrency);
    let running = this.jobs.filter((j) => j.running && !j.done).length;
    for (const job of this.jobs) {
      if (running >= limit) break;
      if (job.running || job.done) continue;
      job.running = true;
      running += 1;
      void this.run(job);
    }
  }

  private async run(job: TtsJob): Promise<void> {
    this.charactersSent += job.text.length; // ab hier wird abgerechnet
    try {
      await this.synthesize(job.text, job.abort.signal, (pcm) => {
        // Verspätete Chunks eines abgebrochenen Turns verwerfen.
        if (job.epoch !== this.epoch || !pcm.length) return;
        job.chunks.push(pcm);
        this.pump();
      });
    } catch (err) {
      // undici meldet einen Abbruch mitten im Stream als "TypeError: terminated"
      // (siehe llmStream.ts) — das ist kein Fehler, sondern der Barge-in.
      if (!job.abort.signal.aborted && job.epoch === this.epoch && !this.closed) {
        this.emit("error", String(err));
      }
    } finally {
      job.done = true;
      this.pump();
      this.startPending();
    }
  }

  /**
   * Head-of-Line-Ausgabe: nur der vorderste Auftrag darf senden. Resampelt wird
   * hier — in Ausgabereihenfolge —, damit der Filterzustand auch bei Prefetch
   * niemals durcheinandergerät.
   */
  private pump(): void {
    if (this.closed) return;
    for (;;) {
      const head = this.jobs[0];
      if (!head) break;
      while (head.chunks.length) {
        const raw = head.chunks.shift();
        if (!raw) break;
        const pcm = this.resampler.push(raw);
        if (!pcm.length) continue;
        // Erst hier — nicht beim Einreihen: Die Sprechuhr braucht die Grenze in
        // AUSGABE-Reihenfolge, und die stellt allein der Head-of-Line-Emitter her.
        if (!head.announced) {
          head.announced = true;
          this.emit("segment", head.text);
        }
        this.emit("audio", pcm);
      }
      if (!head.done) return; // läuft noch — der Nachfolger muss warten
      this.jobs.shift();
    }
    if (this.flushPending) {
      this.flushPending = false;
      this.emit("flushed", undefined);
    }
  }
}
