/**
 * TTS-Provider-Manifest — die eine Quelle der Wahrheit für Auswahl, Validierung
 * und Dokumentation. Muster: audio/ambiencePresets.ts.
 *
 * Verbraucher:
 *  - db/models/Agent.ts   → speak.provider-Enum (TTS_PROVIDER_IDS)
 *  - native/ttsFactory.ts → welcher Adapter gebaut wird
 *  - admin/routes/tts.ts  → GET /api/tts/providers fürs Agenten-Panel
 *  - docs/tts-provider.md → Steckbrief- und DSGVO-Tabellen
 *
 * Keine API-Keys hier: die stehen im Server-Env und verlassen es nie. Der
 * Endpoint meldet nur, OB ein Key gesetzt ist (configured), nie seinen Wert.
 */

export const TTS_PROVIDER_IDS = [
  "deepgram",
  "deepgram_flux",
  "eleven_labs",
  "mistral",
  "azure",
  "speechify",
  "fish_audio",
] as const;

export type TtsProviderId = (typeof TTS_PROVIDER_IDS)[number];

/** Feinschliff-Felder; steuert, welche Eingaben das Panel je Provider zeigt. */
export type TtsKnobId =
  | "speed"
  | "volume"
  | "stability"
  | "similarityBoost"
  | "expressivity"
  | "temperature"
  | "topP"
  | "latencyMode";

/**
 * Datenschutz-Einstufung des Verarbeitungsorts:
 *  eu            – Verarbeitung in der EU (kein Drittlandtransfer)
 *  eu-optional   – EU-Endpoint verfügbar, muss aber konfiguriert werden
 *  us            – Verarbeitung in den USA (SCC/DPF erforderlich)
 *  third-country – Drittland ohne Angemessenheitsbeschluss
 */
export type TtsResidency = "eu" | "eu-optional" | "us" | "third-country";

export interface TtsModelEntry {
  id: string;
  label: string;
  /** ISO-639-1 bzw. Locale; "multi" = sprachübergreifend. */
  languages: string[];
}

export interface TtsVoiceEntry {
  id: string;
  label: string;
  languages: string[];
  /** Wenn gesetzt: Stimme gilt nur für diese Modelle (Speechify bindet Stimmen ans Modell). */
  models?: string[];
}

export interface TtsProviderEntry {
  id: TtsProviderId;
  /** Deutsches Label fürs Panel. */
  label: string;
  /** In welchem voiceProvider-Pfad nutzbar. Die Voice-Agent-API reicht nur eigene + ElevenLabs durch. */
  paths: Array<"native" | "deepgram">;
  models: TtsModelEntry[];
  defaultModel: string;
  /** Liste ist eine Auswahl, kein vollständiger Katalog → Freitextfeld anbieten. */
  modelFreeText: boolean;
  voices: TtsVoiceEntry[];
  /** Eigene bzw. geklonte Stimm-IDs per Freitext zulassen. */
  voiceFreeText: boolean;
  knobs: TtsKnobId[];
  residency: TtsResidency;
  /** Deutscher Klartext fürs Badge im Panel und für die Doku. */
  residencyNote: string;
  /** Richtwert in USD je 1000 Zeichen. */
  costPer1kChars: number;
  costNote?: string;
  /** ENV-Variable mit dem API-Key (nur der Name — nie der Wert). */
  envKey: string;
  /**
   * Adapter ist gebaut. Wie bei IMPLEMENTED_VOICE_PROVIDERS enthält das
   * Mongoose-Enum bewusst nur implementierte Provider — ein Agent lässt sich gar
   * nicht erst auf etwas speichern, das im Anruf nicht liefe.
   */
  implemented: boolean;
  /**
   * Muss ausdrücklich freigeschaltet werden (Drittland). Ohne die ENV-Freigabe
   * bietet das Panel den Provider nicht an und der Adapter fällt zurück.
   */
  optInEnv?: string;
}

/**
 * Aura-Stimmen stecken im Modellnamen (aura-2-<name>-<sprache>). Der volle
 * Katalog ist groß und ändert sich — hier steht eine Auswahl, Freitext bleibt offen.
 */
const AURA_MODELS: TtsModelEntry[] = [
  { id: "aura-2-thalia-en", label: "Thalia (englisch, weiblich)", languages: ["en"] },
  { id: "aura-2-viktoria-de", label: "Viktoria (deutsch, weiblich)", languages: ["de"] },
];

/** Flux-TTS-Stimmen: derzeit ausschließlich englisch, Modellname = flux-<stimme>-en. */
const FLUX_MODELS: TtsModelEntry[] = [
  { id: "flux-haley-en", label: "Haley (amerikanisch, weiblich)", languages: ["en"] },
  { id: "flux-heather-en", label: "Heather (amerikanisch, weiblich)", languages: ["en"] },
  { id: "flux-priya-en", label: "Priya (indisch, weiblich)", languages: ["en"] },
  { id: "flux-jack-en", label: "Jack (britisch, männlich)", languages: ["en"] },
  { id: "flux-bruce-en", label: "Bruce (amerikanisch, männlich)", languages: ["en"] },
  { id: "flux-rufus-en", label: "Rufus (britisch, männlich)", languages: ["en"] },
  { id: "flux-drew-en", label: "Drew (amerikanisch, männlich)", languages: ["en"] },
];

/**
 * Voxtral-Preset-Stimmen — abgerufen von `GET /v1/audio/voices` am 2026-08-18.
 *
 * ACHTUNG bei Deutsch: Es gibt KEINE deutschen Preset-Stimmen. Die Presets sind
 * ein kleiner Demo-Satz (acht Varianten einer US-Stimme, zwei britische); Voxtral
 * ist ein Cloning-Modell, die eigentliche Stimme bringt man selbst mit. Deutscher
 * Text funktioniert damit trotzdem (cross-lingual, live geprüft) — aber mit
 * englischem Einschlag. Für einen deutschen Agenten gehört eine geklonte Stimme
 * hierher (siehe /api/tts/voices und docs/tts-provider.md).
 *
 * Als voice_id akzeptiert die API sowohl den Slug als auch die UUID; der Slug ist
 * lesbarer und wird deshalb hier geführt.
 */
const VOXTRAL_VOICES: TtsVoiceEntry[] = [
  { id: "en_paul_sad", label: "Paul - Sad (heavy, hushed, sad)", languages: ["en"] },
  { id: "en_paul_neutral", label: "Paul - Neutral (relaxed, balanced, neutral)", languages: ["en"] },
  { id: "en_paul_happy", label: "Paul - Happy (sunny, easygoing, happy)", languages: ["en"] },
  { id: "en_paul_frustrated", label: "Paul - Frustrated (edgy, snappy, frustrated)", languages: ["en"] },
  { id: "en_paul_excited", label: "Paul - Excited (bouncy, spirited, excited)", languages: ["en"] },
  { id: "en_paul_confident", label: "Paul - Confident (bold, punchy, confident)", languages: ["en"] },
  { id: "en_paul_cheerful", label: "Paul - Cheerful (upbeat, breezy, cheerful)", languages: ["en"] },
  { id: "en_paul_angry", label: "Paul - Angry (raw, gruff, angry)", languages: ["en"] },
  { id: "gb_oliver_neutral", label: "Oliver - Neutral (calm, even, neutral)", languages: ["en"] },
  { id: "gb_jane_sarcasm", label: "Jane - Sarcasm (dry, wry, sarcastic)", languages: ["en"] },
];

/**
 * Speechify-Stimmen für simba-3.0, live abgerufen am 2026-08-18 (der Katalog führt
 * 983 Stimmen, davon 44 mit de-DE für 3.0). Hier steht eine Auswahl — die
 * `-agent`-Varianten sind ausdrücklich für Sprachassistenten gebaut. Die volle
 * Liste holt `GET /api/tts/voices?provider=speechify`.
 *
 * simba-3.2 ist absichtlich NICHT mit deutschen Stimmen belegt: das Modell kann
 * kein Deutsch.
 */
const SPEECHIFY_VOICES: TtsVoiceEntry[] = [
  { id: "katharina-agent", label: "Katharina (deutsch, weiblich, Agent)", languages: ["de"], models: ["simba-3.0"] },
  { id: "benedikt-agent", label: "Benedikt (deutsch, männlich, Agent)", languages: ["de"], models: ["simba-3.0"] },
  { id: "henrik-agent", label: "Henrik (deutsch, männlich, Agent)", languages: ["de"], models: ["simba-3.0"] },
  { id: "greta", label: "Greta (deutsch, weiblich)", languages: ["de"], models: ["simba-3.0"] },
  { id: "luisa", label: "Luisa (deutsch, weiblich)", languages: ["de"], models: ["simba-3.0"] },
  { id: "anton", label: "Anton (deutsch, männlich)", languages: ["de"], models: ["simba-3.0"] },
  { id: "markus", label: "Markus (deutsch, männlich)", languages: ["de"], models: ["simba-3.0"] },
];

/**
 * Azure-Stimmen. Bei Azure IST der Stimmname das Modell ("de-DE-KatjaNeural") —
 * dieselbe Form wie bei Aura, deshalb stehen sie in `models` und nicht in `voices`.
 *
 * Die Liste ist bewusst KURZ: Azure führt über 600 Stimmen, und der Katalog soll
 * keine Namen enthalten, die niemand gegengeprüft hat (die erfundenen
 * Voxtral-Presets waren genau dieser Fehler). Die vollständige, regionsaktuelle
 * Liste holt `GET /api/tts/voices?provider=azure` direkt bei Azure ab; das
 * Freitextfeld nimmt jeden Namen entgegen, auch Custom Neural Voices.
 */
const AZURE_VOICES: TtsModelEntry[] = [
  { id: "de-DE-KatjaNeural", label: "Katja (deutsch, weiblich)", languages: ["de"] },
];

export const TTS_PROVIDERS: readonly TtsProviderEntry[] = [
  {
    id: "deepgram",
    label: "Deepgram Aura",
    paths: ["native", "deepgram"],
    models: AURA_MODELS,
    defaultModel: "aura-2-thalia-en",
    modelFreeText: true,
    voices: [],
    voiceFreeText: false,
    knobs: ["speed", "volume"],
    residency: "eu-optional",
    residencyNote:
      "Deepgram Inc. (USA). Mit api.eu.deepgram.com läuft die Verarbeitung vollständig in der EU; ohne EU-Endpoint sind SCC nötig.",
    costPer1kChars: 0.03,
    envKey: "DEEPGRAM_API_KEY",
    implemented: true,
  },
  {
    id: "deepgram_flux",
    label: "Deepgram Flux TTS",
    paths: ["native", "deepgram"],
    models: FLUX_MODELS,
    defaultModel: "flux-haley-en",
    modelFreeText: false,
    voices: [],
    voiceFreeText: false,
    knobs: ["speed", "expressivity"],
    residency: "eu-optional",
    residencyNote:
      "Deepgram Inc. (USA). Der EU-Endpoint api.eu.deepgram.com bedient /v2/speak nachweislich (live geprüft 2026-08-18, von Deutschland aus sogar schneller als global) — Deepgram führt den Pfad in seiner Regionsliste allerdings NICHT auf. Für eine belastbare Zusage vorher bei Deepgram bestätigen lassen; ohne EU-Endpoint USA und damit SCC.",
    costPer1kChars: 0.045,
    costNote: "Bis 12.09.2026 kostenlos (45 parallele Streams, davon 5 in EU/AU); danach teurer als Aura.",
    envKey: "DEEPGRAM_API_KEY",
    implemented: true,
  },
  {
    id: "eleven_labs",
    label: "ElevenLabs",
    paths: ["native", "deepgram"],
    models: [
      { id: "eleven_flash_v2_5", label: "Flash v2.5 (schnellste)", languages: ["multi"] },
      { id: "eleven_turbo_v2_5", label: "Turbo v2.5", languages: ["multi"] },
      { id: "eleven_multilingual_v2", label: "Multilingual v2 (beste Qualität)", languages: ["multi"] },
    ],
    defaultModel: "eleven_flash_v2_5",
    modelFreeText: true,
    voices: [],
    voiceFreeText: true,
    knobs: ["speed", "stability", "similarityBoost"],
    residency: "eu-optional",
    residencyNote:
      "ElevenLabs Inc. (USA). Mit EU-Data-Residency (nur Enterprise) läuft die Speicherung in der EU — zusammen mit Zero Retention Mode auch die Verarbeitung. Endpoint über ELEVENLABS_BASE_URL setzen; ohne ihn USA und damit SCC/DPF.",
    costPer1kChars: 0.11,
    costNote: "0,5 Credits/Zeichen bei Flash/Turbo; der Eurobetrag hängt vom gebuchten Tarif ab.",
    envKey: "ELEVENLABS_API_KEY",
    implemented: true,
  },
  {
    id: "mistral",
    label: "Mistral Voxtral TTS",
    paths: ["native"],
    models: [
      { id: "voxtral-mini-tts-latest", label: "Voxtral Mini TTS", languages: ["de", "en", "fr", "es", "it", "pt", "nl", "hi", "ar"] },
    ],
    defaultModel: "voxtral-mini-tts-latest",
    modelFreeText: false,
    voices: VOXTRAL_VOICES,
    voiceFreeText: true,
    knobs: [],
    residency: "eu",
    residencyNote:
      "Mistral AI SAS, Paris (Frankreich). Verarbeitung standardmäßig in der EU, 30 Tage Missbrauchs-Retention; Zero Data Retention im Scale-Tarif. Beste Einstufung im Feld.",
    costPer1kChars: 0.016,
    envKey: "MISTRAL_API_KEY",
    implemented: true,
  },
  {
    id: "azure",
    label: "Azure Neural TTS",
    paths: ["native"],
    models: AZURE_VOICES,
    defaultModel: "de-DE-KatjaNeural",
    // Über 600 Stimmen — die Auswahl oben ist ein Einstieg, nicht der Katalog.
    modelFreeText: true,
    voices: [],
    voiceFreeText: false,
    knobs: [],
    residency: "eu",
    residencyNote:
      "Microsoft Ireland Operations Ltd. Der Verarbeitungsort ist die gewählte Azure-Region — mit AZURE_SPEECH_REGION=westeurope oder germanywestcentral bleibt alles in der EU. Standard hier ist westeurope.",
    costPer1kChars: 0.016,
    costNote:
      "Neural-Stimmen $16 / 1 Mio. Zeichen; Neural HD $22. Mit Commitment-Tarif bis herunter zu $7,50 / 1 Mio.",
    envKey: "AZURE_SPEECH_KEY",
    implemented: true,
  },
  {
    id: "speechify",
    label: "Speechify Simba",
    paths: ["native"],
    models: [
      { id: "simba-3.0", label: "Simba 3.0 (mehrsprachig, inkl. Deutsch)", languages: ["de", "en", "es", "fr", "it", "pt"] },
      { id: "simba-3.2", label: "Simba 3.2 (nur Englisch, niedrigste Latenz)", languages: ["en"] },
      { id: "simba-multilingual", label: "Simba Multilingual (Legacy, 30+ Sprachen)", languages: ["multi"] },
    ],
    // 3.0 statt des neueren 3.2: nur 3.0 kann Deutsch.
    defaultModel: "simba-3.0",
    modelFreeText: false,
    voices: SPEECHIFY_VOICES,
    voiceFreeText: true,
    knobs: ["speed"],
    residency: "us",
    residencyNote:
      "Speechify Inc. (USA). Laut Datenschutzerklärung werden Daten in den USA verarbeitet und gespeichert — SCC/DPF erforderlich.",
    costPer1kChars: 0.01,
    costNote: "Starter-Tarif; im Pro-/Scale-Tarif $0,008 bzw. $0,006 je 1000 Zeichen.",
    envKey: "SPEECHIFY_API_KEY",
    implemented: true,
  },
  {
    id: "fish_audio",
    label: "Fish Audio S2",
    paths: ["native"],
    models: [
      { id: "s2.1-pro", label: "S2.1 Pro", languages: ["multi"] },
      { id: "s2.1-pro-free", label: "S2.1 Pro (kostenfrei, ohne SLA)", languages: ["multi"] },
      { id: "s2-pro", label: "S2 Pro", languages: ["multi"] },
      { id: "s1", label: "S1 (Legacy)", languages: ["multi"] },
    ],
    // Default bleibt der bezahlte Tarif: die kostenfreie Variante ist dasselbe
    // Modell, aber ausdrücklich ohne Uptime- und TTFA-Zusage — für einen
    // Telefonagenten die falsche Grundlage.
    defaultModel: "s2.1-pro",
    modelFreeText: false,
    voices: [],
    voiceFreeText: true,
    knobs: ["speed", "volume", "temperature", "topP", "latencyMode"],
    residency: "third-country",
    residencyNote:
      "Shanghai Qita Dynamic Technology Co., Ltd (China). Drittlandübermittlung ohne Angemessenheitsbeschluss; Anrufaudio und -text sind personenbezogen. Nicht ohne eigene Transfer-Folgenabschätzung und SCC einsetzen.",
    costPer1kChars: 0.015,
    costNote:
      "Abgerechnet werden UTF-8-BYTES, nicht Zeichen — deutsche Umlaute und ß kosten doppelt. Das Modell s2.1-pro-free kostet nichts (verifiziert: Guthaben bleibt unverändert), unterliegt aber einer Fair-Use-Policy und gibt keine Uptime- oder TTFA-Zusage. API-Guthaben wird getrennt vom Plattform-Guthaben geführt.",
    envKey: "FISH_AUDIO_API_KEY",
    implemented: true,
    optInEnv: "FISH_AUDIO_ENABLED",
  },
];

/**
 * Enum-Quelle für db/models/Agent.ts — bewusst NUR implementierte Provider,
 * damit unrunnbare Konfigurationen schon beim Speichern abgelehnt werden.
 */
export const IMPLEMENTED_TTS_PROVIDER_IDS: readonly TtsProviderId[] = TTS_PROVIDERS.filter(
  (p) => p.implemented,
).map((p) => p.id);

const BY_ID = new Map<string, TtsProviderEntry>(TTS_PROVIDERS.map((p) => [p.id, p]));

export function findTtsProvider(id: string): TtsProviderEntry | undefined {
  return BY_ID.get(id);
}

/** Implementierte Provider, die in diesem voiceProvider-Pfad laufen können. */
export function providersForPath(path: "native" | "deepgram"): TtsProviderEntry[] {
  return TTS_PROVIDERS.filter((p) => p.implemented && p.paths.includes(path));
}
