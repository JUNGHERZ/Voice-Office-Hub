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
    externalMediaHost: string;
    externalMediaPort: number;
  };
  defaultAgent: {
    prompt: string;
    greeting: string;
    listenModel: string;
    speakModel: string;
    summaryEnabled: boolean;
    summaryPrompt: string;
  };
  transfer: {
    passthroughTarget: string;
    timeoutSec: number;
  };
  recordingPath: string;
  /** Spike/Diagnose: Anrufer-Audio direkt zurückspielen (ohne Deepgram). */
  echoTest: boolean;
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
    app: opt("ARI_APP", "voice-agent"),
    embedAsterisk: bool("EMBED_ASTERISK", true),
  },
  audio: {
    encoding: opt("AUDIO_ENCODING", "linear16"),
    sampleRate: int("AUDIO_SAMPLE_RATE", 8000),
    externalMediaHost: opt("EXTERNAL_MEDIA_HOST", "127.0.0.1"),
    externalMediaPort: int("EXTERNAL_MEDIA_PORT", 8090),
  },
  defaultAgent: {
    prompt: opt(
      "DEFAULT_AGENT_PROMPT",
      "Du bist ein hilfreicher Telefon-Assistent. Antworte in der Sprache des Anrufers.",
    ),
    greeting: opt("DEFAULT_AGENT_GREETING", "Hallo! Wie kann ich Ihnen helfen?"),
    listenModel: opt("DEFAULT_LISTEN_MODEL", "nova-3"),
    speakModel: opt("DEFAULT_SPEAK_MODEL", "aura-2-thalia-en"),
    summaryEnabled: bool("SUMMARY_ENABLED", false),
    summaryPrompt: opt(
      "SUMMARY_PROMPT",
      "Fasse das folgende Telefongespräch in 3-5 Sätzen sachlich zusammen.",
    ),
  },
  transfer: {
    passthroughTarget: opt("PASSTHROUGH_TARGET", ""),
    timeoutSec: int("TRANSFER_TIMEOUT", 30),
  },
  recordingPath: opt("RECORDING_PATH", "/data/recordings"),
  echoTest: bool("ECHO_TEST", false),
};
