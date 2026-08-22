/**
 * Zentrale Konfiguration aus ENV. Eine einzige Quelle der Wahrheit, die das
 * Verhalten des Containers steuert (lokal wie Prod — nur die .env unterscheidet sich).
 *
 * Der Default-Agent hier ist der Fallback, wenn keine DDI in der `agents`-Collection
 * passt (siehe agentResolver). Pro-Nummer-Agents überschreiben diese Werte.
 */
import "dotenv/config";

import {
  deepgramEndpoints,
  parseDeepgramRegion,
  type DeepgramRegion,
} from "./deepgram/endpoints.js";

function opt(name: string, fallback = ""): string {
  return process.env[name] ?? fallback;
}

function bool(name: string, fallback: boolean): boolean {
  const v = process.env[name];
  if (v === undefined) return fallback;
  return v === "true" || v === "1" || v === "yes";
}

function int(name: string, fallback: number): number {
  const v = process.env[name];
  if (v === undefined || v === "") return fallback;
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) ? n : fallback;
}

export type LlmProvider = "requesty" | "deepgram";

export interface Config {
  deepgram: {
    apiKey: string;
    /**
     * Verarbeitungsregion. `eu` schaltet STT, Aura-TTS, Flux-TTS und die
     * Voice-Agent-API gemeinsam auf `api.eu.deepgram.com` — gleicher Key, nur
     * andere Domain. Ohne sie geht das Anruferaudio in die USA (Drittland), und
     * der Verbindungsaufbau kostet aus Deutschland rund 460 ms mehr.
     */
    region: DeepgramRegion;
    /** false = DEEPGRAM_REGION trug einen unbekannten Wert; es gilt `global`. */
    regionRecognized: boolean;
    agentUrl: string;
  };
  llm: {
    provider: LlmProvider;
    requestyApiKey: string;
    requestyBaseUrl: string;
    model: string;
    /**
     * Prompt-Caching-Breakpoint auf den System-Prompt (nur Claude-Modelle — bei
     * allen anderen bleibt der Request unveraendert). Lohnt erst ab dem
     * Mindest-Praefix des Modells (Haiku 4.5: 4096 Tokens ~ 11.300 Zeichen
     * Deutsch); darunter ignoriert die API den Block kostenneutral.
     */
    promptCache: boolean;
  };
  mongo: {
    uri: string;
    useLocal: boolean;
  };
  ari: {
    url: string;
    username: string;
    password: string;
    app: string;
    embedAsterisk: boolean;
  };
  audio: {
    encoding: string;
    sampleRate: number;
    /** Asterisk-externalMedia-Format: "slin"=8kHz, "slin16"=16kHz, "ulaw"=8kHz µ-law. */
    externalMediaFormat: string;
    /** Medien-Transport: "audiosocket" (TCP, robust) oder "rtp" (UDP). */
    transport: string;
    externalMediaHost: string;
    externalMediaPort: number;
    /**
     * Optionales Verzeichnis mit eigenen Ambience-Loops (<preset>.raw, slin 16-bit LE
     * mono in AUDIO_SAMPLE_RATE); leer = eingebaute prozedurale Presets.
     */
    ambienceDir: string;
  };
  /** ElevenLabs-TTS (optional): Key liegt nur im Server-Env, nie in der DB. */
  elevenlabs: {
    apiKey: string;
    /**
     * Basis bis /v1 — gilt für BEIDE Pfade (native Kaskade und die Dritt-TTS-
     * Durchreiche der Voice-Agent-API). EU-Data-Residency (nur Enterprise):
     * wss://api.eu.residency.elevenlabs.io/v1
     */
    baseUrl: string;
  };
  /**
   * NativeSession (0.6.10): eigene STT→LLM→TTS-Kaskade als voiceProvider "native".
   * Nutzt die vorhandenen Keys (deepgram.apiKey für STT+TTS, llm.* für das LLM).
   */
  mistral: {
    /** Nur nötig für Agents mit speak.provider=mistral (Voxtral TTS). */
    apiKey: string;
  };
  speechify: {
    /** Nur nötig für Agents mit speak.provider=speechify. */
    apiKey: string;
  };
  fishAudio: {
    /** Nur nötig für Agents mit speak.provider=fish_audio. */
    apiKey: string;
    /**
     * Drittland-Freigabe. Fish Audio wird aus China betrieben; ohne diese
     * ausdrückliche Freigabe baut der Adapter gar nicht erst (Fallback auf Aura).
     */
    enabled: boolean;
  };
  azure: {
    /** Nur nötig für Agents mit speak.provider=azure (Azure Neural TTS). */
    apiKey: string;
    /** Azure-Region — bestimmt Endpoint UND Verarbeitungsort (DSGVO!). */
    region: string;
    /** Vollständige Synthese-URL; leer = aus der Region abgeleitet. */
    endpoint: string;
  };
  native: {
    /** Flux-Streaming-STT (v2-Listen-WS). */
    sttUrl: string;
    /** Aura-Streaming-TTS (Speak-WS). */
    ttsUrl: string;
    /** Flux-Streaming-TTS (v2-Speak-WS; Key kommt aus deepgram.apiKey). */
    fluxTtsUrl: string;
    /** Speechify Simba (Basis bis /v1). */
    speechifyUrl: string;
    /** Fish Audio Live-TTS (vollständige WS-URL). */
    fishUrl: string;
    /** Mistral Voxtral TTS (Basis bis /v1; Key kommt aus mistral.apiKey). */
    mistralUrl: string;
    /**
     * Gleichzeitig laufende Synthese-Requests bei HTTP-TTS (1 = streng seriell).
     * Seriell heißt an jeder Satzgrenze eine Lücke in Höhe der Request-Latenz —
     * bei hörbaren Kerben auf 2 erhöhen (ein Satz wird dann vorgeholt).
     */
    httpTtsConcurrency: number;
    /** Mindestlänge (Zeichen), bevor der Satz-Chunker einen Satz an die TTS gibt. */
    minSentenceChars: number;
    /** Spekulativer LLM-Start auf EagerEndOfTurn (0.6.17; Audio erst nach bestätigtem Turn-Ende). */
    eagerEot: boolean;
    /** Optionale Flux-Schwelle für EagerEndOfTurn (0–1); undefined = Flux-Default. */
    eagerEotThreshold?: number;
    /** Zeichenbudget der Konversationshistorie (Fallback, wenn agent.think.context_length fehlt). */
    contextChars: number;
    /** Default-Verzögerung (ms) für den Timer-Filler, wenn agent.fillers.delayMs fehlt. */
    fillerDelayMs: number;
  };
  /** WebRTC-Web-Widget (0.6.9): Browser-Softphone über Asterisk chan_pjsip/WS. */
  widget: {
    /** Kill-Switch: ohne WEBRTC_ENABLED=true liefert der Session-Endpoint 404. */
    enabled: boolean;
    /** SIP-Benutzer des Widget-Endpoints (pjsip_webrtc.conf). */
    sipUser: string;
    /** Deployment-SIP-Passwort; ohne ENV generiert es der entrypoint pro Container-Start. */
    sipPassword: string;
    /** Escape-Hatch: feste WS-URL (z. B. Sonder-Proxy); leer = aus Request-Host abgeleitet. */
    wsUrlOverride: string;
    /** STUN-Server für ICE im Browser. */
    stunServer: string;
    /** Max. gleichzeitige Web-Anrufe (Session-Endpoint lehnt darüber ab). */
    maxConcurrent: number;
    /** Rate-Limits für den Session-Endpoint (Anfragen pro Minute). */
    sessionRatePerMinIp: number;
    sessionRatePerMinKey: number;
    /** Web-Anruf nur mit eingelöster Sitzung zulassen (0.11.0). Aus = Verhalten vor 0.11.0. */
    requireSession: boolean;
    /** Wie lange eine ausgestellte Sitzung auf ihr INVITE warten darf (Sekunden). */
    sessionTtlSec: number;
    /** Taktrate des Transkript-Stroms in ms (0.11.1) — ein Nachschlag für ALLE Ströme. */
    streamIntervalMs: number;
    /** Deckel für gleichzeitig offene Transkript-Ströme. */
    streamMax: number;
  };
  speech: {
    /**
     * Voreinstellung für `speak.sanitize` (0.11.2): Formatierung vor der Synthese entfernen.
     * Ein Agent kann davon abweichen; der Standard putzt, weil eine Synthese Sternchen und
     * Emoji sonst vorliest.
     */
    sanitize: boolean;
  };
  defaultAgent: {
    /** Betriebsmodus des Default-Agenten: "agent" (KI) oder "passthrough" (Durchleitung+Aufnahme). */
    mode: string;
    prompt: string;
    greeting: string;
    language: string;
    /** Sprache, in der Greeting und Ansagen verfasst sind (NICHT die STT-Sprache). */
    contentLanguage: string;
    listenModel: string;
    speakModel: string;
  };
  /** Post-Call-Summary: eigenes Modell + Prompt, unabhängig vom Konversations-LLM. */
  summary: {
    enabled: boolean;
    prompt: string;
    model: string;
  };
  /** Laufzeit-Lokalisierung fest hinterlegter Ansagen (One-Shot, eigenes günstiges Modell). */
  localize: {
    model: string;
  };
  /** Stille-Reengagement (0.6.27): Nachfassen, wenn der Anrufer schweigt. */
  idle: {
    /** Default-Stille (ms) bis zur ersten Ansage, wenn agent.idlePrompts.timeoutMs fehlt. */
    timeoutMs: number;
  };
  /** Anrufer-Gedächtnis (0.7.0): pseudonymisierte Sprachpräferenz je Rufnummer, opt-in pro Agent. */
  callerProfile: {
    /** HMAC-Schlüssel für den Profil-Key. Leer = Gedächtnis inaktiv (kein Fallback). */
    secret: string;
    /** Verfallsfrist ohne erneuten Kontakt (TTL-Index auf updatedAt). */
    ttlDays: number;
  };
  /** Default-Texte für System-Ansagen (Standardsprache; werden zur Laufzeit lokalisiert). */
  announcements: {
    transferFailed: string;
    /** Abschied vor dem Auflegen wegen Stille (nur bei idlePrompts.hangupAfter). */
    idleHangup: string;
  };
  transfer: {
    passthroughTarget: string;
    timeoutSec: number;
  };
  /** SIP-Trunk-Parameter, die auch der Node-Code (Outbound/Transfer) braucht. */
  trunk: {
    server: string;
    /** PJSIP-Endpoint-Name für ausgehende Wahl über den Trunk. */
    endpoint: string;
    /** Erlaubt der Trunk das Setzen einer fremden Absender-CLI (CLIP no screening)? */
    clipNoScreening: boolean;
    /** Eigene Default-Absendernummer (DID) als Fallback, z. B. für den Default-Agent. */
    outboundCallerId: string;
    /** SIP-Header für die Absender-Rufnummer: "P-Preferred-Identity" (sipgate) oder "P-Asserted-Identity". */
    clipHeader: string;
  };
  recordingPath: string;
  /**
   * Aufbewahrungs- UND Abholfrist für Aufnahmen in Tagen (0/leer = aus, heutiges Verhalten:
   * unbefristet). Nach Ablauf verfallen Aufnahmen samt GridFS-Chunks; Gespräch und
   * Transkript bleiben vollständig erhalten.
   */
  recordingTtlDays: number;
  /**
   * Zeitfenster (ms), in dem ein zweiter eingehender Anruf mit gleicher
   * Anrufer-/Zielnummer als Duplikat verworfen wird. SIP-Trunks (z. B. sipgate)
   * stellen denselben Anruf teils als zwei parallele INVITEs zu — ohne Dedup
   * entstünden zwei Sessions/Requests. 0 = Dedup aus.
   */
  callDedupWindowMs: number;
  /** Admin-UI + Management-API (eigener Fastify-Prozess). */
  admin: {
    /** UI-Login-Passwort; ist es leer, startet der Admin-Server nicht. */
    password: string;
    /** API-Key für externen Zugriff auf /api (Header: x-api-key). Leer = API-Key-Zugang aus. */
    apiKey: string;
    /** Secret zum Signieren des Session-Cookies (Fallback: aus password abgeleitet). */
    sessionSecret: string;
    port: number;
  };
  /**
   * Verhalten, wenn die gewählte DDI KEINEM Agent zugeordnet ist (kein Treffer in
   * `agents`). Verhindert, dass Scanner-/Fehlanrufe einen Test-Default-Agent (Deepgram/
   * LLM) auslösen und Kosten + Logeinträge produzieren.
   *   - "reject"   (Default): vor dem Answer mit 404 ablehnen → Anrufer-Netz spielt
   *                 die Standardansage ("kein Anschluss"). 0 Kosten, kein Logeintrag.
   *   - "announce": kurz answern, eine Ansage abspielen, dann auflegen (kein LLM).
   *   - "agent":    heutiges Verhalten — Default-Agent (nur für Dev sinnvoll).
   */
  unknownNumber: {
    behavior: string;
    /** ARI-Media-ID für die Ansage im "announce"-Modus (z. B. "sound:custom/kein-anschluss"). */
    announcement: string;
  };
  /**
   * Konfigurations-Overlay pro Anruf (0.9.0): Vor dem Answer fragt die Engine einen
   * externen Dienst, ob der Anruf laufen darf und ob ein Teil der Agent-Konfiguration
   * für genau diesen Anruf ersetzt wird (v. a. der Systemprompt mit Laufzeitwerten).
   * Leere URL = Feature aus (Default) — der Klingelpfad verhält sich dann wie bisher.
   */
  resolver: {
    url: string;
    /** HMAC-Schlüssel für X-VOH-Signature. Leer = unsigniert senden. */
    secret: string;
    /**
     * Hartes Zeitbudget. Der Hook liegt auf dem Klingelpfad — läuft er ab, gilt der
     * gespeicherte Agent (Fail-open), damit ein Ausfall der Gegenstelle nicht alle
     * Anschlüsse stumm schaltet.
     */
    timeoutMs: number;
  };
  /**
   * Ausgehende Ereignis-Zustellung (0.9.0): Gesprächsereignisse werden an einen
   * externen Empfänger geschickt, statt dass dieser /api/requests pollen muss.
   * Leere URL = Feature aus (Default), dann entsteht kein ausgehender Verkehr.
   */
  webhooks: {
    url: string;
    secret: string;
    timeoutMs: number;
    /** Wiederholungen bei Timeout/5xx/429 (exponentieller Backoff). */
    maxRetries: number;
    /** Obergrenze der Warteschlange; darüber wird verworfen und laut geloggt. */
    queueLimit: number;
  };
  /** Spike/Diagnose: Anrufer-Audio direkt zurückspielen (ohne Deepgram). */
  echoTest: boolean;
  /** Echo-Variante: "packet" = re-paketisiert (eigene seq/ts), "raw" = 1:1 zurück. */
  echoMode: string;
}

/**
 * Default-Modell der beiden Nebenaufgaben (Übersetzung/Begrüßung und Zusammenfassung).
 * Bewusst regionsgebunden: Diese Aufrufe sehen den kompletten Ansagen-Katalog, das ganze
 * Transkript und künftig die Begrüßung mit Firmen- und perspektivisch Anrufernamen. Für eine
 * Appliance, deren Existenzgrund die Datenhaltung in der EU ist, darf der VOREINGESTELLTE
 * Endpunkt dafür kein ungebundener sein. Wer ein anderes Modell will, setzt die Variablen.
 */
const EU_ONESHOT_MODEL = "bedrock/claude-haiku-4-5@eu-central-1";

// Region einmal auflösen: die vier URL-Variablen bleiben als Escape-Hatch und
// gewinnen weiterhin (opt() nimmt den ENV-Wert, sonst den Regions-Default).
const dgRegion = parseDeepgramRegion(opt("DEEPGRAM_REGION"));
const dgUrls = deepgramEndpoints(dgRegion.region);

export const config: Config = {
  deepgram: {
    // Optional beim Start (z.B. Echo-Test braucht ihn nicht); beim Anruf erforderlich.
    apiKey: opt("DEEPGRAM_API_KEY"),
    region: dgRegion.region,
    regionRecognized: dgRegion.recognized,
    agentUrl: opt("DEEPGRAM_AGENT_URL", dgUrls.agentUrl),
  },
  llm: {
    provider: (opt("LLM_PROVIDER", "requesty") as LlmProvider),
    requestyApiKey: opt("REQUESTY_API_KEY"),
    requestyBaseUrl: opt("REQUESTY_BASE_URL", "https://router.requesty.ai/v1"),
    model: opt("LLM_MODEL", "openai/gpt-4o"),
    promptCache: bool("LLM_PROMPT_CACHE", true),
  },
  mongo: {
    uri: opt("MONGO_URI", "mongodb://127.0.0.1:27017/voiceagent"),
    useLocal: bool("USE_LOCAL_MONGO", true),
  },
  ari: {
    url: opt("ARI_URL", "http://127.0.0.1:8088"),
    username: opt("ARI_USERNAME", "voiceagent"),
    password: opt("ARI_PASSWORD", ""),
    app: opt("ARI_APP", "voice-office-hub"),
    embedAsterisk: bool("EMBED_ASTERISK", true),
  },
  audio: {
    encoding: opt("AUDIO_ENCODING", "linear16"),
    // AudioSocket-Default: slin = 8 kHz signed linear (Telefonie-Standard).
    sampleRate: int("AUDIO_SAMPLE_RATE", 8000),
    externalMediaFormat: opt("EXTERNAL_MEDIA_FORMAT", "slin"),
    transport: opt("MEDIA_TRANSPORT", "audiosocket"),
    externalMediaHost: opt("EXTERNAL_MEDIA_HOST", "127.0.0.1"),
    externalMediaPort: int("EXTERNAL_MEDIA_PORT", 8090),
    ambienceDir: opt("AMBIENCE_DIR", ""),
  },
  elevenlabs: {
    apiKey: opt("ELEVENLABS_API_KEY"),
    // NATIVE_TTS_ELEVEN_URL bleibt als Alias gültig: die Variable galt bis 0.8.0 nur
    // für die native Kaskade, jetzt steuert ELEVENLABS_BASE_URL beide Pfade.
    baseUrl: opt("ELEVENLABS_BASE_URL") || opt("NATIVE_TTS_ELEVEN_URL", "wss://api.elevenlabs.io/v1"),
  },
  mistral: {
    apiKey: opt("MISTRAL_API_KEY"),
  },
  speechify: {
    apiKey: opt("SPEECHIFY_API_KEY"),
  },
  fishAudio: {
    apiKey: opt("FISH_AUDIO_API_KEY"),
    enabled: bool("FISH_AUDIO_ENABLED", false),
  },
  azure: {
    apiKey: opt("AZURE_SPEECH_KEY"),
    // Default bewusst eine EU-Region: Azure verarbeitet dort, wo die Region liegt.
    region: opt("AZURE_SPEECH_REGION", "westeurope"),
    endpoint: opt("AZURE_SPEECH_ENDPOINT"),
  },
  native: {
    sttUrl: opt("NATIVE_STT_URL", dgUrls.sttUrl),
    ttsUrl: opt("NATIVE_TTS_URL", dgUrls.ttsUrl),
    fluxTtsUrl: opt("NATIVE_TTS_FLUX_URL", dgUrls.fluxTtsUrl),
    mistralUrl: opt("NATIVE_TTS_MISTRAL_URL", "https://api.mistral.ai/v1"),
    speechifyUrl: opt("NATIVE_TTS_SPEECHIFY_URL", "https://api.speechify.ai/v1"),
    fishUrl: opt("NATIVE_TTS_FISH_URL", "wss://api.fish.audio/v1/tts/live"),
    httpTtsConcurrency: int("NATIVE_HTTP_TTS_CONCURRENCY", 1),
    minSentenceChars: int("NATIVE_MIN_SENTENCE_CHARS", 12),
    eagerEot: bool("NATIVE_EAGER_EOT", false),
    // Leerer String zählt als "nicht gesetzt" (ENV-Pinning der Tests nutzt das).
    ...(process.env.NATIVE_EAGER_EOT_THRESHOLD &&
    Number.isFinite(Number(process.env.NATIVE_EAGER_EOT_THRESHOLD))
      ? { eagerEotThreshold: Number(process.env.NATIVE_EAGER_EOT_THRESHOLD) }
      : {}),
    contextChars: int("NATIVE_CONTEXT_CHARS", 16000),
    fillerDelayMs: int("NATIVE_FILLER_DELAY_MS", 2000),
  },
  widget: {
    enabled: bool("WEBRTC_ENABLED", false),
    sipUser: opt("WIDGET_SIP_USER", "webwidget"),
    sipPassword: opt("WIDGET_SIP_PASSWORD"),
    wsUrlOverride: opt("WIDGET_WS_URL"),
    stunServer: opt("WIDGET_STUN_SERVER", "stun:stun.l.google.com:19302"),
    maxConcurrent: int("WIDGET_MAX_CONCURRENT", 5),
    sessionRatePerMinIp: int("WIDGET_SESSION_RATE_IP", 10),
    sessionRatePerMinKey: int("WIDGET_SESSION_RATE_KEY", 30),
    requireSession: bool("WIDGET_REQUIRE_SESSION", true),
    // 300 s: Zwischen Sitzung und INVITE liegt die Mikrofon-Freigabe des Browsers, und die
    // kann dauern — eine knappere Frist ließe echte Anrufe an der Nachfrage scheitern.
    sessionTtlSec: int("WIDGET_SESSION_TTL_SEC", 300),
    streamIntervalMs: int("WIDGET_STREAM_INTERVAL_MS", 250),
    streamMax: int("WIDGET_STREAM_MAX", 50),
  },
  speech: {
    sanitize: bool("SPEECH_SANITIZE", true),
  },
  defaultAgent: {
    // "agent" (KI beantwortet) oder "passthrough" (Anruf an PASSTHROUGH_TARGET durchleiten + aufnehmen).
    mode: opt("DEFAULT_MODE", "agent"),
    prompt: opt(
      "DEFAULT_AGENT_PROMPT",
      "Du bist ein hilfreicher Telefon-Assistent. Antworte in der Sprache des Anrufers.",
    ),
    greeting: opt("DEFAULT_AGENT_GREETING", "Hallo! Wie kann ich Ihnen helfen?"),
    // "multi" = nova-3 multilingual (erkennt u.a. Deutsch); alternativ "de"/"en".
    language: opt("DEFAULT_LANGUAGE", "multi"),
    // Ausgangssprache der Ansagen. Fallback, wenn am Agenten nichts gesetzt ist UND die
    // automatische Erkennung aus Greeting/Prompt kein eindeutiges Ergebnis liefert.
    contentLanguage: opt("DEFAULT_CONTENT_LANGUAGE", "de"),
    listenModel: opt("DEFAULT_LISTEN_MODEL", "nova-3"),
    speakModel: opt("DEFAULT_SPEAK_MODEL", "aura-2-thalia-en"),
  },
  summary: {
    enabled: bool("SUMMARY_ENABLED", false),
    prompt: opt(
      "SUMMARY_PROMPT",
      "Fasse das folgende Telefongespräch in 3-5 Sätzen sachlich zusammen.",
    ),
    // Eigenes Summary-Modell über Requesty (unabhängig vom Konversations-Modell).
    model: opt("SUMMARY_MODEL", EU_ONESHOT_MODEL),
  },
  localize: {
    // Erkennung + Übersetzung der Ansagen und Erzeugung der Begrüßung (günstig,
    // temperature 0; unabhängig vom Konversations-LLM).
    model: opt("LOCALIZE_MODEL", EU_ONESHOT_MODEL),
  },
  idle: {
    timeoutMs: int("IDLE_PROMPT_TIMEOUT_MS", 8000),
  },
  callerProfile: {
    // Ohne Secret bleibt das Anrufer-Gedächtnis AUS — es gibt bewusst keinen Fallback auf
    // ADMIN_SESSION_SECRET: ein Pseudonymisierungs-Schlüssel hat einen anderen Zweck und
    // eine andere Rotationsfrequenz als ein Cookie-Secret.
    secret: opt("CALLER_PROFILE_SECRET"),
    ttlDays: int("CALLER_PROFILE_TTL_DAYS", 180),
  },
  announcements: {
    transferFailed: opt(
      "TRANSFER_FAILED_ANNOUNCEMENT",
      "Ich konnte leider niemanden erreichen. Wir machen zusammen weiter.",
    ),
    idleHangup: opt(
      "IDLE_HANGUP_ANNOUNCEMENT",
      "Ich melde mich dann ab. Rufen Sie gern noch einmal an.",
    ),
  },
  transfer: {
    passthroughTarget: opt("PASSTHROUGH_TARGET", ""),
    timeoutSec: int("TRANSFER_TIMEOUT", 30),
  },
  trunk: {
    server: opt("TRUNK_SERVER", "sipconnect.sipgate.de"),
    endpoint: opt("TRUNK_OUTBOUND_ENDPOINT", "trunk-endpoint"),
    clipNoScreening: bool("TRUNK_CLIP_NO_SCREENING", false),
    outboundCallerId: opt("OUTBOUND_CALLER_ID", ""),
    // "ppi" → P-Preferred-Identity (sipgate, Default), "pai" → P-Asserted-Identity (manche Provider).
    clipHeader: opt("TRUNK_CLIP_HEADER", "ppi").toLowerCase() === "pai" ? "P-Asserted-Identity" : "P-Preferred-Identity",
  },
  recordingPath: opt("RECORDING_PATH", "/data/recordings"),
  recordingTtlDays: int("RECORDING_TTL_DAYS", 0),
  callDedupWindowMs: int("CALL_DEDUP_WINDOW_MS", 4000),
  admin: {
    password: opt("ADMIN_PASSWORD"),
    apiKey: opt("ADMIN_API_KEY"),
    sessionSecret: opt("ADMIN_SESSION_SECRET") || opt("ADMIN_PASSWORD"),
    port: int("UI_PORT", 8080),
  },
  unknownNumber: {
    behavior: opt("UNKNOWN_NUMBER_BEHAVIOR", "reject").toLowerCase(),
    announcement: opt("UNKNOWN_NUMBER_ANNOUNCEMENT", "sound:custom/kein-anschluss"),
  },
  resolver: {
    url: opt("RESOLVER_URL"),
    secret: opt("RESOLVER_SECRET"),
    timeoutMs: int("RESOLVER_TIMEOUT_MS", 2500),
  },
  webhooks: {
    url: opt("WEBHOOK_URL"),
    secret: opt("WEBHOOK_SECRET"),
    timeoutMs: int("WEBHOOK_TIMEOUT_MS", 15000),
    maxRetries: int("WEBHOOK_MAX_RETRIES", 5),
    queueLimit: int("WEBHOOK_QUEUE_LIMIT", 500),
  },
  echoTest: bool("ECHO_TEST", false),
  echoMode: opt("ECHO_MODE", "packet"),
};
