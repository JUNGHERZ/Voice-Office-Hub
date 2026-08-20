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
 * Meldet URLs, die nicht zur gewählten Region passen. Zielt genau auf den
 * halb gesetzten Zustand: Region auf `eu`, aber eine einzelne URL-Variable zeigt
 * noch woanders hin — dann liefe ein Teil des Verkehrs weiter in die USA, und
 * ohne diese Prüfung fiele das niemandem auf. Liefert die Feldnamen der
 * Abweichler (leer = alles stimmig).
 */
export function mismatchedEndpoints(
  region: DeepgramRegion,
  effective: DeepgramEndpoints,
): string[] {
  const expected = deepgramEndpoints(region);
  const hostOf = (u: string): string => {
    try {
      return new URL(u).host;
    } catch {
      return u; // unparsbar ist selbst schon ein Befund
    }
  };
  return (Object.keys(expected) as Array<keyof DeepgramEndpoints>).filter(
    (k) => hostOf(effective[k]) !== hostOf(expected[k]),
  );
}
