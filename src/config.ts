/**
 * Zentrale Konfiguration aus ENV. Eine einzige Quelle der Wahrheit, die das
 * Verhalten des Containers steuert (lokal wie Prod — nur die .env unterscheidet sich).
 *
 * Der Default-Agent hier ist der Fallback, wenn keine DDI in der `agents`-Collection
 * passt (siehe agentResolver). Pro-Nummer-Agents überschreiben diese Werte.
 */
import "dotenv/config";

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
    agentUrl: string;
  };
  llm: {
    provider: LlmProvider;
    requestyApiKey: string;
    requestyBaseUrl: string;
    model: string;
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
  };
  defaultAgent: {
    /** Betriebsmodus des Default-Agenten: "agent" (KI) oder "passthrough" (Durchleitung+Aufnahme). */
    mode: string;
    prompt: string;
    greeting: string;
    language: string;
    listenModel: string;
    speakModel: string;
  };
  /** Post-Call-Summary: eigenes Modell + Prompt, unabhängig vom Konversations-LLM. */
  summary: {
    enabled: boolean;
    prompt: string;
    model: string;
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
  };
  recordingPath: string;
  /**
   * Zeitfenster (ms), in dem ein zweiter eingehender Anruf mit gleicher
   * Anrufer-/Zielnummer als Duplikat verworfen wird. SIP-Trunks (z. B. SIPGate)
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
  /** Spike/Diagnose: Anrufer-Audio direkt zurückspielen (ohne Deepgram). */
  echoTest: boolean;
  /** Echo-Variante: "packet" = re-paketisiert (eigene seq/ts), "raw" = 1:1 zurück. */
  echoMode: string;
}

export const config: Config = {
  deepgram: {
    // Optional beim Start (z.B. Echo-Test braucht ihn nicht); beim Anruf erforderlich.
    apiKey: opt("DEEPGRAM_API_KEY"),
    agentUrl: opt("DEEPGRAM_AGENT_URL", "wss://agent.deepgram.com/v1/agent/converse"),
  },
  llm: {
    provider: (opt("LLM_PROVIDER", "requesty") as LlmProvider),
    requestyApiKey: opt("REQUESTY_API_KEY"),
    requestyBaseUrl: opt("REQUESTY_BASE_URL", "https://router.requesty.ai/v1"),
    model: opt("LLM_MODEL", "openai/gpt-4o"),
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
    model: opt("SUMMARY_MODEL", "openai/gpt-4.1-mini"),
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
  },
  recordingPath: opt("RECORDING_PATH", "/data/recordings"),
  callDedupWindowMs: int("CALL_DEDUP_WINDOW_MS", 4000),
  admin: {
    password: opt("ADMIN_PASSWORD"),
    apiKey: opt("ADMIN_API_KEY"),
    sessionSecret: opt("ADMIN_SESSION_SECRET") || opt("ADMIN_PASSWORD"),
    port: int("UI_PORT", 8080),
  },
  echoTest: bool("ECHO_TEST", false),
  echoMode: opt("ECHO_MODE", "packet"),
};
