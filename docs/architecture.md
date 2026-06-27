# Architektur

## Überblick

Ein telefonisch erreichbarer KI-Voice-Agent. Eingehende Anrufe laufen über **Asterisk** (per
**ARI**) in die **Node.js/TypeScript**-Komponente, die pro Anruf eine Session gegen die
**Deepgram Voice Agent API** (`wss://agent.deepgram.com/v1/agent/converse`) orchestriert. Deepgram
übernimmt die komplette Sprach-Pipeline (Listen → Think → Speak). Das LLM (Think) und die
Post-Call-Summary hängen an **Requesty.ai** (OpenAI-kompatibel); optional ist ein von Deepgram
integriert gehostetes Modell wählbar.

```
PSTN ──► Asterisk ──(Stasis: voice-agent)──► ARI (WebSocket) ──► Node-Kern
            │                                                       │
            │   externalMedia (AudioSocket/TCP, slin 8 kHz)         ├─► Deepgram Voice Agent (WS)
            │◄──────── Audio (bidirektional) ──────────────────────┤        │ Think → Requesty.ai
                                                                    ├─► MongoDB (requests, agents)
                                                                    └─► GridFS (Audio-Aufnahmen)
```

> **Media-Transport (entschieden):** `externalMedia` läuft über **AudioSocket** (TCP) statt RTP —
> ein simpler Frame-Header (`[Typ][Länge][payload]`), keine RTP-/Payload-Type-Fallen, zuverlässig.
> Ein persistenter TCP-Server ordnet Verbindungen per **UUID** dem Anruf zu
> ([src/ari/audiosocketServer.ts](../src/ari/audiosocketServer.ts)). Der RTP-Pfad
> ([media.ts](../src/ari/media.ts)) bleibt als Alternative über `MEDIA_TRANSPORT=rtp` bestehen.

Alles läuft in **einem Docker-Container** (Asterisk + Node-Kern + MongoDB + Python-Admin-UI),
orchestriert von `supervisord`. Dasselbe Image dient lokal (OrbStack) wie in Produktion — der
Unterschied steckt allein in der `.env`.

> **Trade-off (bewusst):** App + DB (+ optional Asterisk/UI) in einem Container ist untypisch
> (Backups/Scale/Updates gröber). Das ist eine bewusste Produkt-/Appliance-Entscheidung.
> Für sauberere Persistenz kann `MONGO_URI` auf ein externes (repliziertes) Set zeigen
> (`USE_LOCAL_MONGO=false`).

## Pro Anruf: drei gekoppelte Streams

1. **ARI-Control** — ein WebSocket vom Node-Kern zu Asterisk (Events `StasisStart`/`StasisEnd`,
   REST für answer/bridge/externalMedia/dial/record).
2. **Media-Bridge** — Audio Asterisk ↔ Node über einen `externalMedia`-Kanal
   ([src/ari/media.ts](../src/ari/media.ts)).
3. **Deepgram-Session** — ein WebSocket Node ↔ Deepgram
   ([src/deepgram/agentSession.ts](../src/deepgram/agentSession.ts)).

## Anruf-Lifecycle (Modus „agent")

Siehe [src/ari/callHandler.ts](../src/ari/callHandler.ts):

1. `StasisStart` (Args: DDI + CallerID) → Agent per DDI auflösen
   ([agentResolver.ts](../src/ari/agentResolver.ts)), `requests`-Dokument anlegen.
2. Kanal `answer()`, Mixing-Bridge erstellen, Kanal hinein.
3. `externalMedia`-Kanal erzeugen (AudioSocket/TCP, UUID-gebunden) → in die Bridge.
4. Deepgram-Session öffnen, `Settings` aus dem Agent bauen
   ([settings.ts](../src/deepgram/settings.ts)), senden.
5. Audio-Bridging: Anrufer→Deepgram und Deepgram-TTS→Anrufer.
6. Events:
   - `ConversationText` → Turn `{ t, speaker, text }` an `requests.transcript` (`$push`).
   - `FunctionCallRequest` → Tool ausführen ([tools/](../src/tools/)) → `FunctionCallResponse`.
   - `UserStartedSpeaking` → Barge-in (TTS-Puffer verwerfen).
7. `StasisEnd`/Hangup → Aufnahme stoppen + in GridFS, Session schließen, Request finalisieren.
8. Falls `summary.enabled`: Post-Call-Summary via Requesty ([llm/summarize.ts](../src/llm/summarize.ts)).

## Betriebsmodi

- **agent** (Default) — KI beantwortet; Tools, Transfer-mit-Rückkehr, Live-Transkript, Aufnahme.
- **passthrough** — keine KI; Weiterleitung an feste Nummer, nur Aufnahme beider Kanäle, nach
  Auflegen Batch-Transkription (Diarization → `caller`/`callee`).
  Siehe [src/ari/passthrough.ts](../src/ari/passthrough.ts). (Spätere Ausbaustufe; Grundgerüst vorhanden.)

## Datenmodell (MongoDB, Mongoose)

- **`requests`** ([models/Request.ts](../src/db/models/Request.ts)) — ein Dokument pro Anruf:
  Metadaten, `transcript[]` (`{t,end,speaker,text}`), `recording.gridFsId`, `functionCalls[]`,
  `transfer`, `summary`.
- **`agents`** ([models/Agent.ts](../src/db/models/Agent.ts)) — pro DDI ein Agent; bündelt die
  vollen Deepgram-Parameter (listen/think/speak/tools/summary inkl. eigenem Modell/tags/mip_opt_out).

Audio-Blobs liegen in **GridFS** ([db/gridfs.ts](../src/db/gridfs.ts)); das Request-Dokument
referenziert nur die `gridFsId`.

> **Engine-Abgrenzung:** Die Engine kümmert sich um **Kern-Telefonie** (Annahme, Routing,
> Transfer, Aufnahme, Transkript/Persistenz). **Fachliche** Tools kommen pro Agent dazu und gehen
> i.d.R. **nach außen** (server-side Function-Endpoints per URL). Das frühere Demo-Tool
> `lookup_customer` samt `customers`-Collection wurde daher entfernt.

## Verzeichnisstruktur

```
src/
  index.ts            Bootstrap
  config.ts           ENV-Konfiguration
  types.ts            ResolvedAgent u.a.
  ari/                ARI-Anbindung (Client, callHandler, media, transfer, recording, passthrough, agentResolver)
  deepgram/           Voice-Agent-WS (agentSession, settings, events) + Batch-Transkription
  tools/              Function-Calling (registry, handlers)
  llm/                Post-Call-Summary via Requesty
  db/                 Mongoose-Connection, Models, GridFS, Repository
  util/               Logger, Audio-Helfer
admin/                Python-Admin-UI (FastAPI, spätere Ausbaustufe)
docker/               Dockerfile-Assets (supervisord, entrypoint, Asterisk-Beispielconfig)
```

## Implementierungsstand (Stufen A–D + Aufnahme)

Verifiziert über echte Anrufe (Softphone → Container-Asterisk):

- **A — Audio-Pfad:** AudioSocket-Transport; getakteter Playout (driftfreier Takt, 80 ms Jitter-
  Puffer, ~240 ms Greeting-Lead-in gegen abgeschnittene erste Worte).
- **B — Konversation (DE):** STT `nova-3` (multilingual; `language` im listen-Provider, nicht im
  deprecateten `agent.language`), TTS `aura-2-…-de`. **Think via Requesty** (`LLM_MODEL`,
  aktuell `vertex/gemini-3.1-flash-lite@eu`); umschaltbar auf Deepgram-managed
  (`LLM_PROVIDER=deepgram`). Für GPT-5/o1/o3 wird `temperature` weggelassen (sonst „Failed to think").
- **C — Persistenz:** `requests` mit Live-`transcript[]` + `functionCalls[]`. MongoDB lokal im
  Container (Dev: Host-Zugriff via `-p 127.0.0.1:27100:27017`).
- **D — Summary & Transfer:** Post-Call-Summary mit **eigenem Modell** (`SUMMARY_MODEL`,
  Default `openai/gpt-4.1-mini`) + eigenem Prompt (per-Agent überschreibbar). `transfer_call`
  (Ansage → paralleles Klingeln → Connect/Auto-Rückkehr nach `TRANSFER_TIMEOUT`; Agent stumm
  während Connect; durchgeschaltete Beendigung). `end_call` (datengetriebenes Auflegen nach dem
  Abschied, ohne FunctionCallResponse → kein doppelter Abschied).
- **Aufnahme (KI-Modus):** ARI `bridge.record` → WAV unter `/var/spool/asterisk/recording` →
  Upload in **GridFS** (Bucket `recordings`) → temp-Datei gelöscht; `requests.recording.gridFsId`.

## Offene/Verifikationspunkte

- **DSGVO:** Gesprächsaufzeichnung erfordert i.d.R. eine Ansage/Einwilligung.
- `requests.recording.durationSec` wird noch nicht befüllt (kosmetisch).
- Weitere offene/zukünftige Punkte gesammelt in [backlog.md](backlog.md).
