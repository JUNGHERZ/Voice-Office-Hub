# Konfiguration & Betrieb

Die gesamte Komponente wird über **ENV-Variablen** gesteuert (siehe [.env.example](../.env.example)).
Dasselbe Image läuft lokal wie in Produktion — Unterschied nur über die `.env`.

## ENV-Variablen

| Variable | Default | Zweck |
|---|---|---|
| `DEEPGRAM_API_KEY` | — | API-Key für Voice Agent + Pre-recorded. |
| `LLM_PROVIDER` | `requesty` | `requesty` (BYO-Router) oder `deepgram` (managed) für den live `think`-Schritt. |
| `REQUESTY_API_KEY` | — | Auth für den Requesty-Router (Think + Summary). |
| `REQUESTY_BASE_URL` | `https://router.requesty.ai/v1` | OpenAI-kompatibler Endpunkt. |
| `LLM_MODEL` | `openai/gpt-4o` | Default-Modell (pro Agent überschreibbar). |
| `MONGO_URI` | `mongodb://127.0.0.1:27017/voiceagent` | Lokal **oder** externes (repliziertes) Set. |
| `USE_LOCAL_MONGO` | `true` | `false` → kein lokales `mongod` im Container. |
| `ARI_URL` / `ARI_USERNAME` / `ARI_PASSWORD` | `http://127.0.0.1:8088` / `voiceagent` / — | ARI-Zugang. |
| `ARI_APP` | `voice-agent` | Name der Stasis-App. |
| `EMBED_ASTERISK` | `true` | Asterisk im Container starten (Dev/Appliance) vs. externe PBX. |
| `AUDIO_ENCODING` / `AUDIO_SAMPLE_RATE` | `linear16` / `8000` | Telefonie-Audioformat (kein Transcoding). |
| `EXTERNAL_MEDIA_HOST` / `EXTERNAL_MEDIA_PORT` | `127.0.0.1` / `8090` | Ziel des externalMedia-RTP-Streams. |
| `DEFAULT_AGENT_*` | s. Beispiel | Fallback-Agent (Prompt, Greeting, listen/speak-Modell, Summary). |
| `PASSTHROUGH_TARGET` | — | Zielnummer für Passthrough/Fallback-Transfer. |
| `TRANSFER_TIMEOUT` | `30` | Sekunden bis zur Auto-Rückkehr bei Weiterleitung. |
| `RECORDING_PATH` | `/data/recordings` | Temp-Staging der Aufnahmen (Blob landet in GridFS). |
| `SUMMARY_ENABLED` / `SUMMARY_PROMPT` | `false` / … | Post-Call-Summary für den Default-Agent. |
| `ADMIN_PASSWORD` / `UI_PORT` | — / `8080` | Admin-UI (startet nur bei gesetztem Passwort). |
| `LOG_LEVEL` | `info` | `debug`/`info`/`warn`/`error`. |

## Betriebsmodi & Agent-Routing

- **agent** (Default): KI beantwortet den Anruf.
- **passthrough**: Weiterleitung an feste Nummer, nur Aufnahme + Batch-Transkription.

Der Modus und alle Parameter kommen aus dem **aufgelösten Agent**:

1. Bei `StasisStart` wird die gewählte **DDI** (`${EXTEN}`) in der `agents`-Collection gesucht.
2. Treffer → dieser Agent (Modus, Prompt, listen/think/speak, Tools, Summary …).
3. Kein Treffer → **Default-Agent** aus den `DEFAULT_AGENT_*`-ENV-Variablen.

So überschreiben DB-Agents das ENV-Default pro Nummer. Das `agents`-Schema
([Agent.ts](../src/db/models/Agent.ts)) mappt 1:1 auf die Deepgram-`Settings`.

## LLM-Umschalter (Requesty ↔ Deepgram-managed)

Im Agent (`think.source`) bzw. global (`LLM_PROVIDER`):

- `requesty` → `think.provider.type: "open_ai"` + `think.endpoint` (Requesty-Router). Standard.
- `deepgram` → von Deepgram integriert gehostetes Modell (z.B. `claude-…`/`gpt-…`) ohne Endpoint.

Die **Post-Call-Summary** nutzt immer die Requesty-Request-API
([summarize.ts](../src/llm/summarize.ts)).

## Tools (Function Calling)

Aktive Tools pro Agent in `agent.tools`. Implementiert ([src/tools/handlers/](../src/tools/handlers/)):

- `lookup_customer` — Kunde aus MongoDB.
- `transfer_call` — Weiterleitung mit Auto-Rückkehr (Vorstufe Warm Transfer).
- `get_weather` — Demo eines externen Calls.

Neue Tools: Handler unter `handlers/` anlegen und in [tools/index.ts](../src/tools/index.ts)
registrieren.

## Aufnahme & Transkription (GridFS)

Beide Modi nehmen das Gespräch auf (ARI `bridge.record` → WAV im temp-Pfad → Streaming-Upload in
**GridFS**); das `requests`-Dokument referenziert nur `recording.gridFsId`. Transkript:

- agent-Modus: **live** aus `ConversationText` (`speaker` = `agent`/`caller`).
- passthrough: **Batch** via Deepgram Pre-recorded + Diarization (`speaker` = `caller`/`callee`).

> **DSGVO:** Gesprächsaufzeichnung erfordert i.d.R. eine Ansage/Einwilligung — vor Produktivbetrieb
> rechtlich absichern.

## Betrieb / Troubleshooting

- **Start lokal:** `cp .env.example .env` → ausfüllen → `./run.sh build && ./run.sh up && ./run.sh logs`.
- **Logs:** strukturierte JSON-Zeilen auf stdout/stderr (`LOG_LEVEL=debug` für mehr Detail).
- **Latenz:** `AgentStartedSpeaking` liefert `total_latency`/`tts_latency`/`ttt_latency` (Ziel < ~1 s).
- **Keine Audio-Rückkehr:** externalMedia-Port/RTP-Range prüfen, `direct_media=no` am Endpoint.
- **Kein Agent gefunden:** DDI-Format (E.164) in `agents.targetNumbers` prüfen; sonst Default-Agent.
- **Externe DB:** `MONGO_URI` setzen + `USE_LOCAL_MONGO=false` → kein lokales `mongod`.
