/**
 * Deepgram-Endpunkte je Region. Deepgram bietet dieselben Dienste unter einer
 * EU-Domain an (seit 10.01.2026 allgemein verfügbar) — gleicher Key, nur andere
 * Domain. Für eine Installation in Europa ist das doppelt relevant:
 *
 *  - **Verarbeitungsort.** Ohne EU-Domain geht das Anruferaudio zur Erkennung in
 *    die USA. Das ist eine Drittlandsübermittlung, keine Latenzfrage.
 *  - **Latenz.** Von Nürnberg aus gemessen (2026-08-20, echter Flux-WebSocket):
 *    `api.deepgram.com` 514 ms bis zur offenen Verbindung, `api.eu.deepgram.com`
 *    52 ms. Der Aufbau gattet die Begrüßung (`Promise.all` in nativeSession), und
 *    die laufende Round-Trip-Zeit (143 ms gegen 7 ms) verzögert jedes EndOfTurn.
 *
 * Warum eine Region statt vier URLs: Genau diese vier einzeln zu pflegen war die
 * Falle — vergisst man eine, läuft ein Teil des Verkehrs weiter in die USA, ohne
 * dass irgendetwas warnt. Ein Schalter kann nicht halb greifen. Die einzelnen
 * URL-Variablen bleiben als Escape-Hatch bestehen und gewinnen weiterhin.
 */

export type DeepgramRegion = "global" | "eu";

export const DEEPGRAM_REGIONS: readonly DeepgramRegion[] = ["global", "eu"];

/**
 * Hosts je Region. Die Asymmetrie ist echt und nicht zu vereinheitlichen:
 * global liegt der Voice-Agent auf `agent.deepgram.com`, in der EU dagegen auf
 * derselben `api.eu`-Domain wie alles andere. Ein `agent.eu.deepgram.com`
 * existiert NICHT (live geprüft — DNS löst nicht auf).
 */
const HOSTS: Record<DeepgramRegion, { api: string; agent: string }> = {
  global: { api: "api.deepgram.com", agent: "agent.deepgram.com" },
  eu: { api: "api.eu.deepgram.com", agent: "api.eu.deepgram.com" },
};

export interface DeepgramEndpoints {
  /** Flux-STT (native Kaskade). */
  sttUrl: string;
  /** Aura-TTS (native Kaskade). */
  ttsUrl: string;
  /** Flux-TTS (native Kaskade). */
  fluxTtsUrl: string;
  /** Voice-Agent-API (Deepgram-Pfad). */
  agentUrl: string;
}

/** Die vier Deepgram-URLs der Region. */
export function deepgramEndpoints(region: DeepgramRegion): DeepgramEndpoints {
  const { api, agent } = HOSTS[region];
  return {
    sttUrl: `wss://${api}/v2/listen`,
    ttsUrl: `wss://${api}/v1/speak`,
    fluxTtsUrl: `wss://${api}/v2/speak`,
    agentUrl: `wss://${agent}/v1/agent/converse`,
  };
}

/**
 * `DEEPGRAM_REGION` einlesen. Tolerant gegenüber Groß-/Kleinschreibung und
 * Leerzeichen — ein Tippfehler soll nicht stillschweigend in den USA landen.
 * `recognized: false` meldet der Aufrufer beim Start laut; die Konfiguration
 * wirft hier bewusst nicht (kein anderer Wert in config.ts tut das).
 */
export function parseDeepgramRegion(raw: string): {
  region: DeepgramRegion;
  recognized: boolean;
} {
  const v = raw.trim().toLowerCase();
  if (!v) return { region: "global", recognized: true };
  if ((DEEPGRAM_REGIONS as readonly string[]).includes(v)) {
    return { region: v as DeepgramRegion, recognized: true };
  }
  return { region: "global", recognized: false };
}

/**
 * Abweichung zwischen `DEEPGRAM_REGION` und den tatsächlich wirksamen URLs.
 * Die Unterscheidung ist bewusst dreiteilig, weil die Fälle unterschiedlich
 * gefährlich sind:
 *
 *  - `ok` — Region und URLs sagen dasselbe.
 *  - `uniform` — alle vier URLs zeigen geschlossen auf eine ANDERE bekannte
 *    Region. Der Verkehr ist konsistent, nur das Feld `DEEPGRAM_REGION` ist
 *    dekorativ (die URLs gewinnen). Das ist der Normalfall einer Installation,
 *    die vor 0.8.12 eingerichtet wurde — kein Fehler, sondern ein Hinweis.
 *  - `mixed` — die URLs sind untereinander uneinheitlich. Genau hier läuft
 *    wirklich ein Teil des Verkehrs woanders, und genau das bleibt ohne Prüfung
 *    unbemerkt.
 */
export type EndpointDrift =
  | { kind: "ok" }
  | { kind: "uniform"; actual: DeepgramRegion }
  | { kind: "mixed"; fields: Array<keyof DeepgramEndpoints> };

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url; // unparsbar ist selbst schon ein Befund
  }
}

/** Felder, deren Host von der Region abweicht (leer = deckungsgleich). */
function differingFields(
  region: DeepgramRegion,
  effective: DeepgramEndpoints,
): Array<keyof DeepgramEndpoints> {
  const expected = deepgramEndpoints(region);
  return (Object.keys(expected) as Array<keyof DeepgramEndpoints>).filter(
    (k) => hostOf(effective[k]) !== hostOf(expected[k]),
  );
}

/** Region gegen die wirksamen URLs prüfen — siehe EndpointDrift. */
export function endpointDrift(
  region: DeepgramRegion,
  effective: DeepgramEndpoints,
): EndpointDrift {
  if (!differingFields(region, effective).length) return { kind: "ok" };
  for (const candidate of DEEPGRAM_REGIONS) {
    if (candidate !== region && !differingFields(candidate, effective).length) {
      return { kind: "uniform", actual: candidate };
    }
  }
  return { kind: "mixed", fields: differingFields(region, effective) };
}
