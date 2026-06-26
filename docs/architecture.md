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
            │   externalMedia (RTP/slin16)                          ├─► Deepgram Voice Agent (WS)
            │◄──────── Audio (bidirektional) ──────────────────────┤        │ Think → Requesty.ai
                                                                    ├─► MongoDB (requests, agents, customers)
                                                                    └─► GridFS (Audio-Aufnahmen)
```

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
3. `externalMedia`-Kanal erzeugen → RTP an unseren UDP-Media-Socket; in die Bridge.
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
  vollen Deepgram-Parameter (listen/think/speak/tools/summary/tags/mip_opt_out).
- **`customers`** ([models/Customer.ts](../src/db/models/Customer.ts)) — Demo-Daten für `lookup_customer`.

Audio-Blobs liegen in **GridFS** ([db/gridfs.ts](../src/db/gridfs.ts)); das Request-Dokument
referenziert nur die `gridFsId`.

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

## Offene/Verifikationspunkte

- **externalMedia-Transport** (RTP vs. AudioSocket), RTP-Packetisierung (Payload-Type, ptime) —
  im ersten Spike final zu verifizieren (siehe Kommentare in [media.ts](../src/ari/media.ts)).
- Aktuelle Deepgram-Modell-IDs (mehrsprachiges STT/TTS inkl. Deutsch).
- Requesty-Endpoint/Modell-IDs.
- **DSGVO:** Gesprächsaufzeichnung erfordert i.d.R. eine Ansage/Einwilligung.
