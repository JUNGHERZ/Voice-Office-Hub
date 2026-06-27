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
| `LLM_MODEL` | `openai/gpt-4o` | Konversations-Modell (Requesty-ID, z. B. `vertex/gemini-3.1-flash-lite@eu`); pro Agent überschreibbar. |
| `MONGO_URI` | `mongodb://127.0.0.1:27017/voiceagent` | Lokal **oder** externes (repliziertes) Set. |
| `USE_LOCAL_MONGO` | `true` | `false` → kein lokales `mongod` im Container. |
| `ARI_URL` / `ARI_USERNAME` / `ARI_PASSWORD` | `http://127.0.0.1:8088` / `voiceagent` / — | ARI-Zugang. |
| `ARI_APP` | `voice-agent` | Name der Stasis-App. |
| `EMBED_ASTERISK` | `true` | Asterisk im Container starten (Dev/Appliance) vs. externe PBX. |
| `MEDIA_TRANSPORT` | `audiosocket` | `audiosocket` (TCP, Default) oder `rtp` (UDP). |
| `AUDIO_ENCODING` / `AUDIO_SAMPLE_RATE` | `linear16` / `8000` | Audioformat Richtung Deepgram (kein Transcoding). |
| `EXTERNAL_MEDIA_FORMAT` | `slin` | Asterisk-Format des externalMedia-Kanals (`slin`=8 kHz signed linear). |
| `EXTERNAL_MEDIA_HOST` / `EXTERNAL_MEDIA_PORT` | `127.0.0.1` / `8090` | Adresse, zu der sich Asterisks AudioSocket verbindet (extern: erreichbare Host-Adresse). |
| `DEFAULT_MODE` | `agent` | Modus des Default-Agenten: `agent` (KI) oder `passthrough` (Durchleitung an `PASSTHROUGH_TARGET` + Aufnahme/Batch-Transkription). |
| `DEFAULT_LANGUAGE` | `multi` | STT-Sprache im listen-Provider (`multi`, `de`, `en` …; **nicht** das deprecatete `agent.language`). Wird auch der Batch-Transkription (Passthrough) als feste Sprache vorgegeben. |
| `DEFAULT_AGENT_PROMPT` / `DEFAULT_AGENT_GREETING` | s. Beispiel | Fallback-Agent: System-Prompt + Begrüßung. |
| `DEFAULT_LISTEN_MODEL` / `DEFAULT_SPEAK_MODEL` | `nova-3` / `aura-2-thalia-en` | STT-/TTS-Modell des Default-Agenten (für DE z. B. `aura-2-viktoria-de`). |
| `PASSTHROUGH_TARGET` | — | Standard-Durchwahl für `transfer_call` (ohne `target`) bzw. Passthrough-Ziel. |
| `TRANSFER_TIMEOUT` | `30` | Sekunden bis zur Auto-Rückkehr bei Weiterleitung. |
| `RECORDING_PATH` | `/data/recordings` | (Reserviert) Staging-Pfad; ARI schreibt Aufnahmen aktuell nach `/var/spool/asterisk/recording`. |
| `SUMMARY_ENABLED` | `false` | Post-Call-Summary aktiv. |
| `SUMMARY_MODEL` | `openai/gpt-4.1-mini` | Eigenes Summary-Modell (Requesty), unabhängig vom Konversations-LLM. |
| `SUMMARY_PROMPT` | … | Default-Summary-Prompt (pro Agent via `agents.summary.prompt` überschreibbar). |
| `ECHO_TEST` / `ECHO_MODE` | `false` / `packet` | Diagnose: Anrufer-Audio zurückspielen (ohne Deepgram). |
| `ADMIN_PASSWORD` / `UI_PORT` | — / `8080` | Admin-UI (startet nur bei gesetztem Passwort). |
| `LOG_LEVEL` | `info` | `debug`/`info`/`warn`/`error`. |

## Betriebsmodi & Agent-Routing

- **agent** (Default): KI beantwortet den Anruf.
- **passthrough**: Weiterleitung an feste Nummer (`PASSTHROUGH_TARGET`), beide Beine in einer
  Mixing-Bridge, gemeinsame Aufnahme; nach Auflegen Batch-Transkription (Diarization) und
  optionale Summary. Legt eine Seite auf, endet der ganze Anruf (durchgeschaltete Beendigung).

Der Modus und alle Parameter kommen aus dem **aufgelösten Agent**:

1. Bei `StasisStart` wird die gewählte **DDI** (`${EXTEN}`) in der `agents`-Collection gesucht.
2. Treffer → dieser Agent (Modus, Prompt, listen/think/speak, Tools, Summary …).
3. Kein Treffer → **Default-Agent** aus den `DEFAULT_AGENT_*`/`DEFAULT_MODE`-ENV-Variablen.

> Ohne DB-Agents (Admin-UI noch offen) lässt sich der Passthrough-Modus über `DEFAULT_MODE=passthrough`
> + `PASSTHROUGH_TARGET=<Durchwahl>` für den Default-Agenten aktivieren (z. B. zum Testen).

So überschreiben DB-Agents das ENV-Default pro Nummer. Das `agents`-Schema
([Agent.ts](../src/db/models/Agent.ts)) mappt 1:1 auf die Deepgram-`Settings`.

## LLM-Umschalter (Requesty ↔ Deepgram-managed)

Im Agent (`think.source`) bzw. global (`LLM_PROVIDER`):

- `requesty` → `think.provider.type: "open_ai"` + `think.endpoint` (Requesty-Router). Standard.
  Modell-IDs im Requesty-Format, z. B. `openai/gpt-4o-mini`, `vertex/gemini-3.1-flash-lite@eu`.
- `deepgram` → von Deepgram integriert gehostetes Modell (z.B. `claude-…`/`gpt-…`/`gemini-…`) ohne Endpoint.

> **Hinweis:** GPT-5-/o1-/o3-Modelle akzeptieren nur die Default-`temperature`; der Settings-Builder
> lässt `temperature` für diese Modelle daher weg (sonst „Failed to think"). Deepgrams managed-Google
> kann projektseitig gesperrt sein — dann Gemini über **Requesty** nutzen (eigene Google-Anbindung).

Die **Post-Call-Summary** nutzt immer die Requesty-Request-API
([summarize.ts](../src/llm/summarize.ts)) mit **eigenem Modell** (`SUMMARY_MODEL`) und eigenem Prompt
(`SUMMARY_PROMPT`), beides pro Agent überschreibbar.

## Tools (Function Calling)

Aktive Tools pro Agent in `agent.tools`. Implementiert ([src/tools/handlers/](../src/tools/handlers/)):

- `transfer_call` — Weiterleitung mit Auto-Rückkehr (Vorstufe Warm Transfer). Parameter `target`
  = Ziel-Durchwahl (nur bekannte verwenden; ohne Angabe `PASSTHROUGH_TARGET`). Während des Klingelns
  läuft die Ansage weiter, der Agent hört nicht mehr zu; nach Connect ist er stumm.
- `end_call` — Gespräch beenden/auflegen (nach dem gesprochenen Abschied).
- `get_weather` — Demo eines externen Calls.

Neue Tools: Handler unter `handlers/` anlegen und in [tools/index.ts](../src/tools/index.ts)
registrieren.

> **Engine-Abgrenzung:** Die Engine deckt **Kern-Telefonie** ab. Fachliche Tools kommen pro Agent
> dazu und rufen i.d.R. **externe APIs** (server-side Function-Endpoints per URL) auf — sie gehören
> nicht in die Engine. Das frühere Demo-Tool `lookup_customer` (+ `customers`-Collection) wurde entfernt.

## Aufnahme & Transkription (GridFS)

Beide Modi nehmen das Gespräch auf (ARI `bridge.record` → WAV im temp-Pfad → Streaming-Upload in
**GridFS**); das `requests`-Dokument referenziert nur `recording.gridFsId`. Transkript:

- agent-Modus: **live** aus `ConversationText` (`speaker` = `agent`/`caller`).
- passthrough: **Batch** via Deepgram Pre-recorded + Diarization (`speaker` = `caller`/`callee`),
  Sprache fest aus `agent.language` (statt `detect_language` — robuster bei leisem Audio).

Die **Post-Call-Summary** läuft in **beiden** Modi (sofern `summary.enabled`): im agent-Modus über
das Live-Transkript, im passthrough-Modus über das Batch-Transkript.

> **DSGVO:** Gesprächsaufzeichnung erfordert i.d.R. eine Ansage/Einwilligung — vor Produktivbetrieb
> rechtlich absichern.

## Betrieb / Troubleshooting

- **Start lokal:** `cp .env.example .env` → ausfüllen → `./run.sh build && ./run.sh up && ./run.sh logs`.
- **Logs:** strukturierte JSON-Zeilen auf stdout/stderr (`LOG_LEVEL=debug` für mehr Detail).
- **Latenz:** `AgentStartedSpeaking` liefert `total_latency`/`tts_latency`/`ttt_latency` (Ziel < ~1 s).
- **Keine Audio-Rückkehr:** `EXTERNAL_MEDIA_HOST/PORT` prüfen (Asterisk verbindet sich dorthin),
  `direct_media=no` am Endpoint; bei `MEDIA_TRANSPORT=rtp` zusätzlich die RTP-Portrange.
- **„Failed to think":** managed-LLM-Problem (z. B. GPT-5 + `temperature`, oder managed-Google gesperrt) →
  Modell/Provider wechseln (Requesty) — siehe LLM-Umschalter.
- **Aufnahme schlägt fehl (ARI 500):** Verzeichnis `/var/spool/asterisk/recording` muss existieren
  und dem `asterisk`-User gehören (wird im Image angelegt).
- **MongoDB von außen (Dev):** in [run.sh](../run.sh) ist `-p 127.0.0.1:27100:27017` gemappt →
  GUI-Client (z. B. NoSQL Booster) auf `127.0.0.1:27100`, DB `voiceagent`.
- **Kein Agent gefunden:** DDI-Format (E.164) in `agents.targetNumbers` prüfen; sonst Default-Agent.
- **Externe DB:** `MONGO_URI` setzen + `USE_LOCAL_MONGO=false` → kein lokales `mongod`.
