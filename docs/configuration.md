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
| `ARI_APP` | `voice-office-hub` | Name der Stasis-App. |
| `EMBED_ASTERISK` | `true` | Asterisk im Container starten (Dev/Appliance) vs. externe PBX. |
| `TRUNK_ENABLED` | `false` | SIP-Trunk der Appliance aktivieren. Nur wirksam bei `EMBED_ASTERISK=true`. `false` → kein Trunk (Dev nutzt Softphone). Siehe [SIP-Trunk (Appliance)](#sip-trunk-appliance). |
| `TRUNK_SIP_ID` | — | SIP-Account-ID (Benutzername) des Trunk-Providers. |
| `TRUNK_SIP_PASSWORD` | — | SIP-Passwort des Trunk-Accounts. |
| `TRUNK_SERVER` | `sipconnect.sipgate.de` | SIP-Server/Registrar des Providers. |
| `TRUNK_CODECS` | `!all,g722,alaw,ulaw` | Erlaubte Codecs (PJSIP-`allow`-Syntax). |
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
| `ADMIN_PASSWORD` | — | Admin-UI/API-Login. **Leer → Admin-Server startet nicht.** |
| `UI_PORT` | `8080` | Port der Admin-UI + Management-API (Node/Fastify). |
| `ADMIN_API_KEY` | — | Optionaler API-Key für externen `/api`-Zugriff (Header `x-api-key`). Leer = nur UI-Session. |
| `ADMIN_SESSION_SECRET` | =`ADMIN_PASSWORD` | Secret zum Signieren des Session-Cookies (in Prod eigenes setzen). |
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

### DDI-Routing einrichten (Test & Produktion)

Die Zuordnung **Rufnummer → Agent** lebt allein in `agents.targetNumbers`; der Dialplan reicht
die echte gewählte Nummer als `${EXTEN}` an Stasis durch (Pattern `_X.` in
[extensions.conf](../docker/asterisk/extensions.conf)). Es ist **dieselbe Mechanik** in beiden Umgebungen,
nur der Wert der DDI unterscheidet sich:

- **Test (Dev):** gewählte **Durchwahlen** (z. B. `120`, `121`, `122`). Das anrufende Softphone
  wählt die Nummer; `_X.` routet sie nach Stasis. Diese „Service-Nummern" brauchen **keine** eigenen
  PJSIP-Endpoints — nur der Agent in der DB.
- **Produktion (Trunk):** der Provider (z. B. SIPGate) liefert die **volle öffentliche Rufnummer
  (E.164)** in der Request-URI → `${EXTEN}` = `+4930…`. Der Agent trägt dann genau diese E.164-Nummer
  in `targetNumbers`. → Künftige Admin-UI: beim Anbinden des Trunks die zugeteilten öffentlichen
  Nummern hinterlegen und je Nummer einen Agent zuordnen (feste DDI↔Agent-Bindung).

> **E.164-Normalisierung:** Das DDI-Routing ([phone.ts](../src/util/phone.ts) + agentResolver) ist
> gegenüber Schreibvarianten tolerant. Zuerst wird **exakt** verglichen; greift das nicht, werden
> eingehende DDI **und** `agents.targetNumbers` für einen **normalisierten Fallback-Vergleich**
> vereinheitlicht (Trennzeichen entfernt, führendes `00` → `+`). So matchen `+49…`, `0049…` und
> andere Schreibweisen derselben Nummer. Dev-Durchwahlen wie `120` bleiben unverändert und matchen
> weiter exakt. Ein konsistentes Format (E.164 mit `+`) in `targetNumbers` bleibt empfohlen, ist aber
> nicht mehr zwingend für ein Match.

**Demo-Agents anlegen** (idempotent, ohne Admin-UI) über das Seed-Skript
([src/scripts/seedAgents.ts](../src/scripts/seedAgents.ts)) — legt `120` (Vertrieb/KI), `121`
(Support/KI), `122` (Passthrough→101) an:

```bash
# im laufenden Container:
docker exec voh-appliance node /app/dist/scripts/seedAgents.js
# oder lokal mit gesetztem MONGO_URI (Dev-Port 27100):
MONGO_URI=mongodb://127.0.0.1:27100/voiceagent npm run seed
```

Unbekannte DDI (z. B. `100`) → **Default-Agent** aus den ENV-Variablen.

So überschreiben DB-Agents das ENV-Default pro Nummer. Das `agents`-Schema
([Agent.ts](../src/db/models/Agent.ts)) mappt 1:1 auf die Deepgram-`Settings`.

## SIP-Trunk (Appliance)

Für die Produktiv-Appliance wird der SIP-Trunk **vollständig über ENV-Variablen** gesteuert — kein
manuelles Editieren der Asterisk-Config nötig. Gilt nur bei `EMBED_ASTERISK=true` (eingebetteter
Asterisk).

**Funktionsweise (ENV → entrypoint → `#include`):**

1. Beim Container-Start liest [docker/entrypoint.sh](../docker/entrypoint.sh) die `TRUNK_*`-Variablen.
2. Bei `TRUNK_ENABLED=true` generiert der entrypoint daraus `/etc/asterisk/pjsip_trunk.conf`
   (Registration/Auth/Endpoint/AOR/Identify aus `TRUNK_SIP_ID`, `TRUNK_SIP_PASSWORD`, `TRUNK_SERVER`,
   `TRUNK_CODECS`). Bei `TRUNK_ENABLED!=true` wird eine **leere** Datei geschrieben (kein Trunk —
   Dev nutzt das lokale Softphone).
3. [pjsip.conf](../docker/asterisk/pjsip.conf) bindet diese Datei per `#include pjsip_trunk.conf` ein.
4. Der generierte Trunk-Endpoint nutzt `context = inbound` → eingehende Anrufe laufen in den Dialplan
   ([extensions.conf](../docker/asterisk/extensions.conf)) und damit in die Stasis-App / das
   DDI-Agent-Routing.

**Minimale `.env` für einen aktiven Trunk:**

```bash
EMBED_ASTERISK=true
TRUNK_ENABLED=true
TRUNK_SIP_ID=<SIP-ID des Providers>
TRUNK_SIP_PASSWORD=<SIP-Passwort>
TRUNK_SERVER=sipconnect.sipgate.de      # Default
TRUNK_CODECS=!all,g722,alaw,ulaw        # Default
```

> **Strategie (phasiert):** Aktuell **ein Trunk pro Appliance** über ENV — das deckt Single-Tenant-
> Deployments (MonaHilft, Kunden-Self-Host/RZ) ab. Eine **Verwaltung mehrerer Trunks über die
> Admin-UI** (Trunks in der DB → pjsip generieren + `pjsip reload`, verschlüsselte SIP-Credentials)
> und **Multi-Trunk** (Failover/Multi-Provider) sind als spätere Ausbaustufen vorgesehen; das
> Datenmodell ist bereits N-Trunk-fähig gedacht. Siehe [backlog.md](backlog.md#admin-ui-erweiterungen-zukunft).

Manuelle PJSIP-Trunk-Vorlagen (Fallback/Referenz, z. B. für externe PBX) stehen in
[docs/asterisk-sipgate.md](asterisk-sipgate.md).

## Sicherheit / Härtung

Leitlinien für den Produktivbetrieb der Appliance:

- **Netzwerk / Ports (extern minimal):** Nach außen werden **nur** `5060/udp` (SIP) und die
  **RTP-Portrange** (Default 10000–10100/udp) benötigt. **Intern bleiben:** ARI (`8088`) und der
  Media-/AudioSocket-Port (`8090`) — diese sind in der Standard-Containerkonfiguration **nicht** nach
  außen gemappt. Auch das Mongo-Mapping in [run.sh](../run.sh) (`127.0.0.1:27100:27017`) ist nur an
  `localhost` gebunden = **Dev-Komfort**; für eine Prod-Appliance dieses Port-Mapping **entfernen**.
- **ARI-Passwort:** `ARI_PASSWORD` setzen — der entrypoint **warnt** bei leerem oder Default-Wert
  (`changeme`). ARI niemals nach außen exponieren.
- **Admin-UI/-API:** läuft nur bei gesetztem `ADMIN_PASSWORD` (leer → Admin-Server startet nicht).
  In Produktion zusätzlich ein eigenes `ADMIN_SESSION_SECRET` setzen.
- **Externer API-Zugriff (Drittsysteme):** Über `ADMIN_API_KEY` (ENV) lässt sich die JSON-Management-
  API per Header `x-api-key: <ADMIN_API_KEY>` ohne UI-Session nutzen (z. B. für Mona11/Kunden-Systeme).
  Leerer Key = **nur** UI-Session, kein Header-Zugriff. Den Key wie ein Secret behandeln (nur über
  TLS/internes Netz übertragen).
- **DSGVO / Aufnahmen:** Gesprächsaufzeichnung erfordert i. d. R. eine Ansage/Einwilligung — siehe
  [Aufnahme & Transkription](#aufnahme--transkription-gridfs).

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

## Admin-UI & Management-API

Eigener **Node/Fastify**-Prozess (kein Python), startet nur bei gesetztem `ADMIN_PASSWORD`, auf
`UI_PORT` (Default 8080). API-First: das Frontend (Hybrids-SPA im GlassKit-Look, `webui/`, ohne Build)
ist nur ein Client der **JSON-API**. Details: [architecture.md](architecture.md#admin-ui--management-api).

- **API:** `/api/login` · `/api/logout` · `/api/me`; `/api/agents` (GET/POST/PATCH/DELETE);
  `/api/requests` (GET Liste/Detail) + `/api/requests/:id/recording` (WAV-Stream aus GridFS).
- **Auth:** UI-Login → signiertes Session-Cookie; extern alternativ `x-api-key: <ADMIN_API_KEY>`.
- **OpenAPI/Doku:** Spec `/openapi.json`, Swagger-UI `/docs`.
- **Agents pflegen:** über die UI **oder** das Seed-Skript ([seedAgents.ts](../src/scripts/seedAgents.ts),
  `npm run seed`) **oder** direkt per API.

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
