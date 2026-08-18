/**
 * Management-API: TTS-Provider-Katalog (read-only) — Datenquelle für die
 * Provider-, Modell- und Stimmauswahl im Agent-Formular sowie für die
 * DSGVO-Badges.
 *
 * `configured` meldet nur, OB der zugehörige Server-Env-Key gesetzt ist. Der
 * WERT verlässt den Server nie (gleiche Regel wie überall: Keys gehören nicht
 * in die DB und nicht ins Frontend).
 */
import type { FastifyInstance } from "fastify";

import { config } from "../../config.js";
import { TTS_PROVIDERS, type TtsProviderEntry } from "../../tts/catalog.js";
import { requireAuth } from "../auth.js";

/** Env-Keys je Provider — bewusst explizit statt dynamisch über process.env. */
function isConfigured(entry: TtsProviderEntry): boolean {
  switch (entry.envKey) {
    case "DEEPGRAM_API_KEY":
      return Boolean(config.deepgram.apiKey);
    case "ELEVENLABS_API_KEY":
      return Boolean(config.elevenlabs.apiKey);
    case "MISTRAL_API_KEY":
      return Boolean(config.mistral.apiKey);
    default:
      return false; // Provider ohne Adapter (Phase 2/3)
  }
}

const voiceSchema = {
  type: "object",
  properties: {
    id: { type: "string" },
    label: { type: "string" },
    languages: { type: "array", items: { type: "string" } },
    models: { type: "array", items: { type: "string" } },
  },
} as const;

const modelSchema = {
  type: "object",
  properties: {
    id: { type: "string" },
    label: { type: "string" },
    languages: { type: "array", items: { type: "string" } },
  },
} as const;

/**
 * Dünner Proxy auf Mistrals Voice-API. Zweck ist die Migration bestehender
 * Stimmen: Voxtral klont zero-shot aus ~3 s Referenzaudio.
 *
 * WICHTIG für die Herkunft des Referenzmaterials: Eine bei ElevenLabs erzeugte
 * Aufnahme darf dafür NICHT verwendet werden — deren Nutzungsbedingungen
 * verbieten, Output als Eingabe für Modelltraining oder konkurrierende Dienste
 * zu nutzen. Sauber ist, aus derselben ORIGINALAUFNAHME neu zu klonen, aus der
 * die ElevenLabs-Stimme entstanden ist. Und: die geklonte Stimme einer
 * identifizierbaren Person ist ein personenbezogenes Datum — Einwilligung und
 * Löschfrist gehören dokumentiert (retention_notice, Default 30 Tage).
 */
async function mistralVoices(
  path: string,
  init: { method: string; body?: unknown },
): Promise<{ status: number; body: unknown }> {
  const key = config.mistral.apiKey;
  if (!key) return { status: 503, body: { error: "MISTRAL_API_KEY ist auf dem Server nicht gesetzt" } };
  const url = `${config.native.mistralUrl.replace(/\/$/, "")}/audio/voices${path}`;
  const res = await fetch(url, {
    method: init.method,
    headers: {
      Authorization: `Bearer ${key}`,
      ...(init.body ? { "Content-Type": "application/json" } : {}),
    },
    ...(init.body ? { body: JSON.stringify(init.body) } : {}),
  });
  const text = await res.text();
  let parsed: unknown = text;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    /* Fehlertexte kommen gelegentlich als plain text */
  }
  return { status: res.status, body: parsed };
}

interface CreateVoiceBody {
  name: string;
  /** Base64-kodierte Referenzaufnahme (~3 s genügen). */
  sampleAudio: string;
  sampleFilename?: string;
  description?: string;
  /** Aufbewahrungshinweis in Tagen (DSGVO-Löschfrist); Mistral-Default 30. */
  retentionNotice?: number;
}

export async function ttsRoutes(app: FastifyInstance): Promise<void> {
  app.addHook("preHandler", requireAuth);

  app.get(
    "/providers",
    {
      schema: {
        tags: ["tts"],
        summary: "TTS-Provider mit Modellen, Stimmen und DSGVO-Einstufung auflisten",
        response: {
          200: {
            type: "object",
            properties: {
              providers: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    id: { type: "string" },
                    label: { type: "string" },
                    paths: { type: "array", items: { type: "string" } },
                    models: { type: "array", items: modelSchema },
                    defaultModel: { type: "string" },
                    modelFreeText: { type: "boolean" },
                    voices: { type: "array", items: voiceSchema },
                    voiceFreeText: { type: "boolean" },
                    knobs: { type: "array", items: { type: "string" } },
                    residency: { type: "string" },
                    residencyNote: { type: "string" },
                    costPer1kChars: { type: "number" },
                    costNote: { type: "string" },
                    envKey: { type: "string" },
                    configured: { type: "boolean" },
                  },
                },
              },
            },
          },
        },
      },
    },
    async () => ({
      // Nur implementierte Provider — das Panel soll nichts anbieten, was im
      // Anruf auf Aura zurückfiele.
      providers: TTS_PROVIDERS.filter((p) => p.implemented).map((p) => ({
        id: p.id,
        label: p.label,
        paths: p.paths,
        models: p.models,
        defaultModel: p.defaultModel,
        modelFreeText: p.modelFreeText,
        voices: p.voices,
        voiceFreeText: p.voiceFreeText,
        knobs: p.knobs,
        residency: p.residency,
        residencyNote: p.residencyNote,
        costPer1kChars: p.costPer1kChars,
        ...(p.costNote ? { costNote: p.costNote } : {}),
        envKey: p.envKey,
        configured: isConfigured(p),
      })),
    }),
  );

  app.get(
    "/voices",
    {
      schema: {
        tags: ["tts"],
        summary: "Voxtral-Stimmen auflisten (Presets und eigene Klone)",
        querystring: { type: "object", properties: { type: { type: "string" } } },
      },
    },
    async (req, reply) => {
      const q = (req.query as { type?: string }).type;
      const r = await mistralVoices(q ? `?type=${encodeURIComponent(q)}` : "", { method: "GET" });
      return reply.code(r.status).send(r.body);
    },
  );

  app.post(
    "/voices",
    {
      // Referenzaufnahmen sind base64 — der Fastify-Default (1 MB) wäre zu knapp.
      bodyLimit: 12 * 1024 * 1024,
      schema: {
        tags: ["tts"],
        summary: "Stimme aus einer Referenzaufnahme klonen (Voxtral, zero-shot)",
        body: {
          type: "object",
          required: ["name", "sampleAudio"],
          properties: {
            name: { type: "string" },
            sampleAudio: { type: "string" },
            sampleFilename: { type: "string" },
            description: { type: "string" },
            retentionNotice: { type: "number" },
          },
        },
      },
    },
    async (req, reply) => {
      const b = req.body as CreateVoiceBody;
      const r = await mistralVoices("", {
        method: "POST",
        body: {
          name: b.name,
          sample_audio: b.sampleAudio,
          ...(b.sampleFilename ? { sample_filename: b.sampleFilename } : {}),
          ...(b.description ? { description: b.description } : {}),
          // Löschfrist immer mitgeben: eine geklonte Stimme ist personenbezogen.
          retention_notice: b.retentionNotice ?? 30,
        },
      });
      return reply.code(r.status).send(r.body);
    },
  );

  app.delete(
    "/voices/:id",
    { schema: { tags: ["tts"], summary: "Geklonte Stimme löschen" } },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      const r = await mistralVoices(`/${encodeURIComponent(id)}`, { method: "DELETE" });
      return reply.code(r.status).send(r.body);
    },
  );
}
