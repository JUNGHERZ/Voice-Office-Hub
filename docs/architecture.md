# Architektur

## Überblick

Ein telefonisch erreichbarer KI-Voice-Agent. Eingehende Anrufe laufen über **Asterisk** (per
**ARI**) in die **Node.js/TypeScript**-Komponente, die pro Anruf eine Session gegen die
**Deepgram Voice Agent API** (`wss://agent.deepgram.com/v1/agent/converse`) orchestriert. Deepgram
übernimmt die komplette Sprach-Pipeline (Listen → Think → Speak). Das LLM (Think) und die
Post-Call-Summary hängen an **Requesty.ai** (OpenAI-kompatibel); optional ist ein von Deepgram
integriert gehostetes Modell wählbar.

```
PSTN ──► Asterisk ──(Stasis: voice-office-hub)──► ARI (WebSocket) ──► Node-Kern
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

Alles läuft in **einem Docker-Container** (Asterisk + Node-Kern + MongoDB + Node-Admin-UI/API),
orchestriert von `supervisord`. Dasselbe Image dient lokal (OrbStack) wie in Produktion — der
Unterschied steckt allein in der `.env`. (Python wurde entfernt — die Admin-UI läuft jetzt auf Node.)

> **Trade-off (bewusst):** App + DB (+ optional Asterisk/UI) in einem Container ist untypisch
> (Backups/Scale/Updates gröber). Das ist eine bewusste Produkt-/Appliance-Entscheidung.
> Für sauberere Persistenz kann `MONGO_URI` auf ein externes (repliziertes) Set zeigen
> (`USE_LOCAL_MONGO=false`).

## Pro Anruf: drei gekoppelte Streams

1. **ARI-Control** — ein WebSocket vom Node-Kern zu Asterisk (Events `StasisStart`/`StasisEnd`,
   REST für answer/bridge/externalMedia/dial/record).
2. **Media-Bridge** — Audio Asterisk ↔ Node über einen `externalMedia`-Kanal
   ([src/ari/media.ts](../src/ari/media.ts)).
3. **Voice-Session** — provider-neutral über das Interface `VoiceAgentSession`
   ([src/voice/types.ts](../src/voice/types.ts)); die Factory
   ([src/voice/factory.ts](../src/voice/factory.ts)) wählt die Implementierung anhand von
   `agent.voiceProvider`. Aktuell implementiert: **Deepgram**
   ([src/deepgram/agentSession.ts](../src/deepgram/agentSession.ts)); geplant: ElevenLabs,
   OpenAI Realtime, xAI Grok sowie `NativeSession` (eigene STT→LLM→TTS-Kaskade, `src/native/`).

## Zwei Nähte (Erweiterungspunkte)

Der `callHandler` orchestriert zwischen zwei bewusst schmal gehaltenen Schnittstellen:

- **Provider-Naht rechts — `VoiceAgentSession`** (`src/voice/types.ts`): Konstruktion ist inert,
  `start()` verbindet; Events `audio`, `conversationText`, `functionCallRequest`,
  `userStartedSpeaking`, `error` …; Methoden `sendAudio`, `sendFunctionResponse`,
  `injectMessage`, `close`. Encoding, KeepAlive und Wire-Format sind Sache des Adapters.
  Hier docken weitere Voice-Plattformen an — der callHandler bleibt unverändert.
- **Transport-Naht links — `CallMedia`** (`src/ari/callHandler.ts`): `start()`,
  `on("audio")`, `sendAudio()`, `flush()`, `pendingMs?()`, `close()` — rohes PCM in
  20-ms-Frames. Erfüllt von `MediaSession` (AudioSocket) und `MediaBridge` (RTP); ein
  künftiger WebRTC-/Web-Ingress wäre eine dritte Implementierung dieser Schnittstelle.

Beide Nähte werden von den Call-Lifecycle-Tests ([test/callLifecycle.test.ts](../test/callLifecycle.test.ts))
mit Fakes belegt — der komplette Anruf-Pfad läuft dort ohne Asterisk, Cloud oder DB.

## Anruf-Lifecycle (Modus „agent")

Siehe [src/ari/callHandler.ts](../src/ari/callHandler.ts):

1. `StasisStart` (Args: DDI + CallerID) → Agent per DDI auflösen
   ([agentResolver.ts](../src/ari/agentResolver.ts)), `requests`-Dokument anlegen.
2. Kanal `answer()`, Mixing-Bridge erstellen, Kanal hinein.
3. `externalMedia`-Kanal erzeugen (AudioSocket/TCP, UUID-gebunden) → in die Bridge.
4. Voice-Session über die Factory erzeugen (`agent.voiceProvider`, Default Deepgram);
   der Deepgram-Adapter baut daraus die `Settings` ([settings.ts](../src/deepgram/settings.ts)).
   Verbunden wird erst per `session.start()` nach kompletter Event-Verdrahtung.
5. Audio-Bridging: Anrufer→Session und Session-TTS→Anrufer.
6. Events:
   - `ConversationText` → Turn `{ t, speaker, text }` an `requests.transcript` (`$push`).
   - `FunctionCallRequest` → Tool ausführen ([tools/](../src/tools/)) → `FunctionCallResponse`.
   - `UserStartedSpeaking` → Barge-in (TTS-Puffer verwerfen).
7. `StasisEnd`/Hangup → Aufnahme stoppen + in GridFS, Session schließen, Request finalisieren.
8. Falls `summary.enabled`: Post-Call-Summary via Requesty ([llm/summarize.ts](../src/llm/summarize.ts)).

## Betriebsmodi

- **agent** (Default) — KI beantwortet; Tools, Transfer-mit-Rückkehr, Live-Transkript, Aufnahme.
- **passthrough** — keine KI; Weiterleitung an feste Nummer (`PASSTHROUGH_TARGET`), beide Beine in
  einer Mixing-Bridge, gemeinsame Aufnahme; nach Auflegen Batch-Transkription (Diarization →
  `caller`/`callee`) + optionale Summary. Durchgeschaltete Beendigung in beide Richtungen.
  Siehe [src/ari/passthrough.ts](../src/ari/passthrough.ts). Aktivierbar per `DEFAULT_MODE=passthrough`
  (Default-Agent) oder pro DB-Agent (`mode`).

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

## Admin-UI & Management-API

API-First, **Node/TypeScript** (kein Python). Ein eigener **Fastify**-Prozess (`src/admin/`, via
supervisord, Port `UI_PORT`/Default 8080) stellt eine **JSON-API** bereit und liefert das statische
Frontend aus. Er teilt mit dem Telefonie-Kern nur die **Mongoose-Modelle** (eine Quelle der Wahrheit,
kein Schema-Drift) und ist von der Telefonie entkoppelt (startet nur bei gesetztem `ADMIN_PASSWORD`).

- **API:** Agents-CRUD (`/api/agents`), Anrufe/Requests read + Aufnahme-Stream (`/api/requests`,
  `/api/requests/:id/recording` aus GridFS), Login/Session (`/api/login|logout|me`).
- **Auth:** UI-Login per `ADMIN_PASSWORD` → signiertes Session-Cookie; zusätzlich API-Key
  (`x-api-key` = `ADMIN_API_KEY`) für externen Zugriff.
- **OpenAPI:** Spec unter `/openapi.json`, Swagger-UI unter `/docs` (`@fastify/swagger`).
- **Frontend** (`webui/`): **Hybrids.js**-SPA im **GlassKit**-Glas-Look (eigene `<glk-*>`-Web-Components),
  **ohne Build** (native ES-Module + Import-Map; GlassKit/Hybrids aus `node_modules` ausgeliefert).
  Zentrierte 640px-Spalte, Dark-Default, Floating-Tab-Bar, View-Transitions. Views: Login, Dashboard,
  Agents (Liste/CRUD), Anrufe (Liste/Detail mit Audio-Player, Transkript, Summary).

## Verzeichnisstruktur

```
src/
  index.ts            Bootstrap
  config.ts           ENV-Konfiguration
  types.ts            ResolvedAgent u.a.
  ari/                ARI-Anbindung (Client, callHandler, media, transfer, recording, passthrough, agentResolver)
  voice/              Provider-neutrale Session-Schnittstelle (types) + Factory (voiceProvider-Switch)
  deepgram/           Deepgram-Adapter der VoiceAgentSession (agentSession, settings, events) + Batch-Transkription
  tools/              Function-Calling (registry, handlers)
  llm/                Post-Call-Summary via Requesty
  db/                 Mongoose-Connection, Models, GridFS, Repository
  admin/              Admin-UI/API: Fastify-Server, Auth, Routen (agents, requests)
  scripts/            seedAgents.ts (Demo-Agents)
  util/               Logger, Audio-Helfer
webui/                Statisches Admin-Frontend (Hybrids-SPA + GlassKit, kein Build)
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
- **Passthrough (Modus B):** 100 → `PASSTHROUGH_TARGET` durchgeleitet, beide Beine aufgenommen,
  nach Auflegen GridFS-Upload + Batch-Transkription (nova-3, Diarization, feste Agent-Sprache) +
  Summary. End-to-End über echten Anruf verifiziert; offen: **Sprecher-Trennung `caller`/`callee`
  noch mit Zwei-Geräte-Setup zu prüfen** (Same-PC-Test = eine akustische Quelle → keine Trennung).
- **Multi-Agent / DDI-Routing:** Dialplan reicht die echte DDI als `${EXTEN}` durch (Pattern `_X.`;
  der frühere 100→`Goto(_X.)`-Spezialfall, der `${EXTEN}` als Literal `"_X."` lieferte, ist
  entfernt). `agentResolver` matcht `agents.targetNumbers`; Demo-Agents via `seedAgents.ts`
  (120/121/122). Test-DDIs = Durchwahlen, Prod-DDIs = E.164 vom Trunk — gleiche Mechanik.

## Offene/Verifikationspunkte

- **DSGVO:** Gesprächsaufzeichnung erfordert i.d.R. eine Ansage/Einwilligung.
- `requests.durationSec` (Anruflänge, billing-/statistikrelevant, immer gesetzt) + `recording.durationSec`
  (Medienlänge, nur bei Aufnahme) werden beim Finalisieren befüllt.
- Weitere offene/zukünftige Punkte gesammelt in [backlog.md](backlog.md).
