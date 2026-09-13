/**
 * Ausweichkette über mehrere Modelle (0.18.0).
 *
 * Die Modellangaben `LLM_MODEL`, `SUMMARY_MODEL` und `LOCALIZE_MODEL` dürfen
 * kommagetrennt mehrere Modelle tragen: erste Stufe primär, danach die
 * Ausweichstufen in Reihenfolge. Fällt eine Stufe aus (HTTP-Fehler, Timeout,
 * Netzabbruch), übernimmt die nächste.
 *
 * Zwei Grenzen, die bewusst so sind:
 *
 *  - **Ein Abbruch ist kein Ausfall.** Ein `AbortError` kommt vom Barge-in oder vom
 *    Teardown; die Kette bricht dann sofort ab, statt beim nächsten Anbieter eine
 *    Antwort zu bestellen, die niemand mehr hören will.
 *  - **Alle Stufen laufen über denselben Router.** Fällt Requesty selbst aus, hilft
 *    die Kette nicht — dagegen bräuchte es einen zweiten Router. Sie deckt den
 *    häufigeren Fall: ein einzelnes Modell oder ein einzelner Anbieter dahinter.
 */
import { logger } from "../util/logger.js";

const log = logger.child({ mod: "llm-chain" });

export interface ChainOutcome<T> {
  value: T;
  /** Modell, das tatsächlich geantwortet hat. */
  model: string;
  /** 0 = primär, 1 = erste Ausweichstufe, … */
  stage: number;
}

/** True, wenn der Fehler ein bewusster Abbruch ist (Barge-in/Teardown) — nie ausweichen. */
export function isAbort(err: unknown): boolean {
  return (err as { name?: string } | null)?.name === "AbortError";
}

/**
 * Führt `attempt` über die Kette aus, bis eine Stufe liefert. Für One-Shots
 * (Zusammenfassung, Lokalisierung, Begrüßung) — der Streaming-Pfad der
 * NativeSession hat eine eigene Schleife, weil er zusätzlich prüfen muss, ob
 * schon Text an die Sprachausgabe gegangen ist.
 *
 * Wirft den Fehler der LETZTEN Stufe, wenn keine liefert.
 */
export async function runOverChain<T>(
  chain: string[],
  attempt: (model: string, stage: number) => Promise<T>,
  ctx: { task: string; log?: typeof log } = { task: "llm" },
): Promise<ChainOutcome<T>> {
  if (!chain.length) throw new Error(`${ctx.task}: keine Modellangabe`);
  const l = ctx.log ?? log;
  let last: unknown;
  for (let stage = 0; stage < chain.length; stage++) {
    const model = chain[stage] as string;
    try {
      const value = await attempt(model, stage);
      if (stage > 0) {
        l.warn("Ausweichstufe hat geantwortet", {
          task: ctx.task,
          model,
          stage: stage + 1,
          von: chain[0],
        });
      }
      return { value, model, stage };
    } catch (err) {
      last = err;
      if (isAbort(err)) throw err;
      if (stage === chain.length - 1) break;
      l.warn("Modellstufe fehlgeschlagen — nächste Stufe", {
        task: ctx.task,
        model,
        stage: stage + 1,
        next: chain[stage + 1],
        err: String(err),
      });
    }
  }
  throw last;
}
