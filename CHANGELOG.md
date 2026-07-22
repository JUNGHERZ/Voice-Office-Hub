# Changelog

Alle nennenswerten Änderungen an diesem Projekt werden hier dokumentiert.
Das Format orientiert sich an [Keep a Changelog](https://keepachangelog.com/de/1.1.0/),
die Versionierung folgt [Semantic Versioning](https://semver.org/lang/de/).

## [Unreleased]

## [0.6.18] – 2026-07-22

### Fixed
- **`NATIVE_EAGER_EOT` griff ohne Threshold nicht:** Flux deaktiviert den Eager-Modus
  komplett, wenn keine `eager_eot_threshold` mitgesendet wird (im Live-Test 0.6.17
  entdeckt: Latenzen unverändert, keine EagerEndOfTurn-Events). Bei aktivem Flag
  sendet die Engine jetzt immer eine Schwelle — `NATIVE_EAGER_EOT_THRESHOLD` oder
  Default 0.5 (Mitte des gültigen Bereichs 0.3–0.9; Fehlspekulationen sind dank
  Gate unhörbar und kosten nur LLM-Input-Tokens).

## [0.6.17] – 2026-07-22

### Added
- **EagerEndOfTurn-Spekulation (native, `NATIVE_EAGER_EOT`):** Der LLM-Turn startet
  bereits auf das vorläufige Flux-Turn-Ende (EagerEndOfTurn) statt erst auf das
  bestätigte — typischer Gewinn 200–500 ms Antwortzeit. Sicherheitsmodell: Sätze,
  Historie, Transkript-Events und Tool-Calls warten hinter einem Gate, bis das
  EndOfTurn den Wortlaut bestätigt; TurnResumed oder ein abweichendes Final-Transkript
  brechen die Spekulation ab (LLM-Abort + Generationszähler) — für den Anrufer
  unhörbar, Kosten nur LLM-Input-Tokens. `NATIVE_EAGER_EOT_THRESHOLD` übersteuert
  optional die Flux-Schwelle. Default aus (opt-in pro Deployment).

## [0.6.16] – 2026-07-22

### Added
- **TTS-Verbrauchsmetrik pro Anruf (native):** Die Engine zählt zeichengenau, was
  tatsächlich an den TTS-Anbieter gesendet wurde (= Abrechnungsbasis; per Barge-in
  verworfene, nie gesendete Sätze zählen nicht) und persistiert `metrics.ttsProvider/
  ttsModel/ttsCharacters` — bei ElevenLabs zusätzlich `ttsCredits` (Flash/Turbo:
  0,5 Credits/Zeichen, sonst 1,0). Damit ist der ElevenLabs-Credit-Verbrauch pro
  Gespräch exakt zuordenbar, auch wenn das Konto von mehreren Diensten geteilt wird.
  Anzeige als Badge im Anruf-Detail („TTS 4.714 Zeichen ≈ 2.357 Credits").
  Der gebündelte Deepgram-Agent spricht intern → dort weiterhin keine Verbrauchsdaten.

## [0.6.15] – 2026-07-22

### Added
- **Anrufbeschriftung mit Agenten-Auflösung:** Anrufliste, Dashboard („Letzte Anrufe"),
  Live-Ansicht und Anruf-Detail zeigen den Agenten-Namen in Klammern hinter der
  gewählten Nummer — z. B. „Web → 123 (Weiterleitungs Fred)". Die Requests-API
  liefert dafür den referenzierten Agenten-Namen mit (`populate` auf `agentId`);
  besonders nützlich bei Web-Anrufen, wo die interne Pseudo-Durchwahl statt der
  vollwertigen DDI erscheint.

## [0.6.14] – 2026-07-22

### Fixed
- **Web-Widget hinter Docker-NAT (EasyPanel/Swarm): kein Audio in beide Richtungen.**
  Signalisierung und Engine-Seite liefen (Transkript/Begrüßung in der Aufnahme), aber
  Asterisk annoncierte dem Browser nur container-interne ICE-Host-Kandidaten
  (172.18.x/10.x) — unerreichbar, alle Kandidaten-Paare scheiterten. Der entrypoint
  schreibt jetzt bei **explizit gesetzter `PUBLIC_IP`** einen `[ice_host_candidates]`-
  Block in die rtp.conf (alle Container-IPs → öffentliche IP; RTP-Ports sind
  host-publiziert). Auto-erkannte PUBLIC_IP schreibt bewusst NICHT um — lokales
  Direktrouting (OrbStack) behält seine funktionierenden lokalen Kandidaten.
- **Widget-Exten-Auto-Vergabe übernahm eine kollidierende Nummer:** Eine früher (bei
  deaktiviertem Widget, daher unvalidiert) gespeicherte `widget.exten`, die inzwischen
  als DDI eines ANDEREN Agenten existiert, wurde beim Aktivieren respektiert → der
  Web-Anruf landete beim falschen Agenten. Kandidaten, die andere Agents belegen,
  werden jetzt übersprungen und neu vergeben.

## [0.6.13] – 2026-07-22

### Added
- **ElevenLabs-Stimm-Feinschliff pro Agent** (`speak.stability`, `speak.similarityBoost`,
  `speak.speed`): wird in der nativen Kaskade als `voice_settings` mit jeder
  (Re-)Verbindung an ElevenLabs übergeben — überlebt damit auch die harten
  Barge-in-Disconnects. `stability`/`similarityBoost` 0–1 (Schema-validiert), `speed`
  wird auf den erlaubten Bereich 0.7–1.2 geklemmt. Unset = Voice-Default aus dem
  ElevenLabs-Dashboard. Im Deepgram-Agent-Modus (Dritt-TTS-Durchreiche) sind
  `voice_settings` nicht übertragbar — dort gelten weiterhin die Dashboard-Defaults
  der Stimme (dokumentiert).
- **Admin-UI:** Modal „Erweiterte Stimm-Einstellungen" im Agent-Formular (sichtbar bei
  TTS-Provider ElevenLabs), inkl. Zusammenfassungszeile und „Zurücksetzen"; Komma als
  Dezimaltrenner wird akzeptiert.

### Fixed
- **Agents-Liste:** zeigt bei ElevenLabs-Agents nicht mehr irreführend das (dort
  bedeutungslose) gespeicherte Aura-Modell, sondern das ElevenLabs-Modell bzw.
  „ElevenLabs". Zeilen tragen außerdem wieder die Leading-Icons aus dem ursprünglichen
  Mockup (Headset = Agent, Transfer-Pfeile = Passthrough) — der leere Platz vor dem
  Text entfällt.
- **Anrufliste, Dashboard („Letzte Anrufe") und Live-Ansicht** haben jetzt dieselben
  Leading-Icons, dort nach Herkunft des Anrufs: Telefonhörer (Trunk/Softphone) bzw.
  Globus (Web-Widget) — der Modus steht weiterhin im Badge/Filter. Gemeinsames Modul
  `webui/js/icons.js`; GlassKit-Eigenheit dokumentiert (Shadow-CSS erreicht geslottete
  SVGs nicht — Größe muss in der View gesetzt werden, sonst 0×0).

## [0.6.12] – 2026-07-22

### Changed
- **Web-Widget: Pseudo-Durchwahl (`widget.exten`) ist jetzt server-verwaltet.** Beim
  Aktivieren des Widgets vergibt der Server automatisch eine freie 3-stellige Nummer
  (bzw. nutzt eine vorhandene 3-stellige DDI des Agenten mit) und ergänzt sie in
  `targetNumbers` — das manuelle Feld samt „muss auch unter Zielrufnummern
  stehen"-Stolperfalle entfällt im Formular (Anzeige nur noch informativ). API-Clients
  können `widget.exten` weiterhin explizit setzen; der Schema-Validator bleibt als
  Sicherheitsnetz bestehen. Behebt den Fehlversuch, das Widget an einem Agenten mit
  reiner E.164-Nummer zu aktivieren („Widget: exten muss gesetzt sein und in
  targetNumbers stehen" trotz korrekt wirkender Eingaben).

## [0.6.11] – 2026-07-22

### Fixed
- **Dev-Setup: `transfer_call` → 101 schlug direkt nach einem Container-Neustart fehl**
  („Could not create dialog to invalid URI '101' … Is endpoint registered?"). Ursache war
  KEIN Code-/NAT-Problem, sondern ein Registrierungs-Zeitfenster: Ein Neustart verwirft
  alle SIP-Registrierungen; bis das Softphone von sich aus neu registriert (Minuten),
  fehlt der 101-Contact — eingehende Anrufe funktionieren derweil normal (Digest-Auth
  ohne Registrierung), weshalb scheinbar „nur der Transfer" klemmte. Die Dev-AORs
  begrenzen die Registrierungs-Gültigkeit jetzt auf ≤ 90 s (Clients registrieren im
  Minutentakt neu) → das Fenster ist praktisch weg. Prod/Trunk war nie betroffen.

## [0.6.10] – 2026-07-21

**NativeSession**: eigene STT→LLM→TTS-Kaskade als dritter Voice-Provider
(`voiceProvider: "native"`) — die Engine orchestriert das Gespräch selbst, callHandler/
MediaSession/Toolset bleiben unverändert hinter der `VoiceAgentSession`-Naht. Erster
Live-Test: spürbar schnellere Turns als der gebündelte Agent, sauberes Barge-in;
Medienkosten grob ⅓ des Voice-Agent-Preises (Flux $0.0078/min + Aura $0.03/1k Zeichen
vs. $0.059/min BYO-LLM — Listenpreise 2026-07).

### Added
- **`src/native/` — die Kaskade:** `FluxSttStream` (v2-Listen-WS, 8 kHz verifiziert;
  Turn-Events StartOfTurn/EndOfTurn/Eager/Resumed; einmaliger Auto-Reconnect bei Drop),
  `streamChatCompletion` (Requesty-SSE mit index-basierter Tool-Call-Akkumulation,
  AbortError-Normalisierung für Barge-in; Wire-Format live verifiziert), `AuraTtsStream`
  (Speak-WS @ 8 kHz, `Clear`/`Cleared`-Quarantäne live verifiziert, Lazy-Reconnect gegen
  Idle-Drops), Satz-Chunker (Abkürzungs-/Zahlen-Heuristik) und `ConversationHistory`
  (Zeichenbudget-Trimming, hält tool_calls-Gruppen zusammen).
- **`NativeSession`-Orchestrator:** Turn-Loop mit **Satz-Overlap** (Sprechen beginnt,
  während das LLM streamt), Tool-Runden inkl. paralleler Calls und end_call-Sonderfall,
  `injectMessage` (Transfer-Fehlschlag) mit Stale-Response-Schutz, **zweischichtige
  Barge-in-Quarantäne** (Server-Clear + Turn-Generationszähler) und per-Turn-Latenzlog
  (`total`/`ttt`/`tts`) für A/B-Vergleiche.
- **TTS-Provider-Matrix in native:** `speak.provider` wählt Aura-2 **oder ElevenLabs**
  (`stream-input`-WS, `pcm_8000`, Voice-ID am Agent, Key aus `ELEVENLABS_API_KEY`;
  Barge-in dort per hartem Disconnect + Lazy-Reconnect, da das Protokoll kein Clear kennt).
  Unvollständige Konfiguration fällt mit Warnung auf Aura zurück.
- **Freischaltung:** `voiceProvider`-Enum + Factory-Case + Formular-Option
  „Native (STT→LLM→TTS-Kaskade)"; `config.native`-Block (`NATIVE_*`-ENV).

### Notes
- Flux erfordert den native-Modus mit `flux-*`-listen-Modell (nova-3 → Warnung + Fallback
  flux-general-multi). Größter Latenz-Hebel laut Messung ist das think-Modell
  (LLM-First-Token ≈ 2,2–2,4 s mit dem Prod-Default); EagerEndOfTurn-Spekulation ist als
  Ausbaustufe vorbereitet (`NATIVE_EAGER_EOT`, v1 nur Beobachtung).

## [0.6.9] – 2026-07-21

WebRTC-Web-Widget: ein **einbettbares Browser-Softphone** — Website-Besucher rufen den
Agenten direkt im Browser an (SIP over WebSocket → Asterisk chan_pjsip). Der bestehende
Telefonie-Pfad (Stasis → Engine → Voice-Session, Live-Ansicht/Transkript/Aufnahme/Summary/
Metriken) läuft unverändert. Doku: `docs/webrtc.md`.

### Added
- **Asterisk (ENV-gesteuert, `WEBRTC_ENABLED`):** `transport-ws` + Endpoint `webwidget`
  (`webrtc=yes`, DTLS-Auto-Cert, Codecs `opus,ulaw,alaw` — Opus-Modul im Ubuntu-Paket
  verifiziert) und dedizierter Dialplan-Context `[webrtc-inbound]`: nur 3-stellige
  Pseudo-DDIs wählbar, eindeutige Caller-ID `web-<uniqueid>` (kein Dedup-Konflikt,
  „Web" in der Anrufliste). PUBLIC_IP-Auflösung im entrypoint vorgezogen (Trunk **und**
  WebRTC), `icesupport` + `websocket_write_timeout` werden gesetzt.
- **`agent.widget`** (Schema-validiert): `enabled`, `exten` (3-stellig, muss in
  `targetNumbers` stehen), `allowedOrigins` (CSP frame-ancestors), `showTranscript`;
  Embed-`key` server-verwaltet inkl. Rotations-Endpoint (`POST /api/agents/:id/widget/key`)
  und Formular-Sektion (Snippet kopieren, Demo-Link).
- **Öffentliche Widget-Endpoints** (key-/token-gebunden, ohne Login): `POST /api/widget/session`
  (liefert WS-URL + SIP-Creds erst nach Kill-Switch-, Key-, Origin-, Rate-Limit- und
  Concurrent-Prüfung), `GET /widget/:key` (iframe-Seite mit per-Agent-frame-ancestors),
  `GET /api/widget/call/:token` (Live-Transkript, 120 s Nachlauf). Eigener
  Sliding-Window-Limiter ohne neue Dependency; Fastify jetzt mit `trustProxy`.
- **Widget-Frontend:** Loader `webui/widget.js` (ein `<script>`-Tag, Floating-Button +
  iframe mit Mikrofon-Permission), iframe-Seite `widget-app/index.html` (sip.js 0.21 als
  Vendor-ESM, registerloses INVITE, deutsche UI, Mute/Auflegen, **pegelgesteuerter Orb**
  über AnalyserNode am Agent-Audio + Mikro-Indikator, optionales Live-Transkript-Panel
  mit 2-s-Polling, Zustands-postMessage für den Button-Puls, prefers-reduced-motion),
  Demo-/Testseite `webui/widget-demo.html`.
- **Engine (minimal):** drittes Stasis-Argument (`X-Widget-Token` aus dem INVITE) wird als
  `requests.widgetToken` gespeichert (sparse Index) — Grundlage des Widget-Transkripts.

### Notes
- **Single-Port-Design:** Der Admin-Server proxyt `/ws` loopback-intern an Asterisk
  (`@fastify/http-proxy`, websocket) — EIN öffentlicher Port (8080) trägt UI, API, Widget
  und SIP-WS. Jeder simple TLS-Proxy davor funktioniert ohne Pfad-Sonderrouten (EasyPanel-
  Domain, OrbStack-`*.orb.local`); Asterisks HTTP-Server (trägt auch ARI) bleibt auf
  127.0.0.1 gehärtet. Medien laufen über die bestehende host-mode RTP-Range; `PUBLIC_IP`
  bleibt Pflicht (ICE). TURN ist eine dokumentierte Ausbaustufe (~5–10 % der Besucher
  hinter symmetrischem NAT). Threat-Model in `docs/webrtc.md` (Worst Case bei geleaktem
  SIP-Passwort = Gespräche mit dem Agenten; kein Trunk-Zugriff).

## [0.6.8] – 2026-07-20

Hintergrundatmosphäre im Anruf + ElevenLabs als optionale Ausgabestimme.

### Added
- **Ambience pro Agent** (`agent.ambience { enabled, preset, volume }`): eine leise Dauerschleife
  (z. B. Büroatmosphäre), die der Anrufer das ganze Gespräch über hört — auch in Sprechpausen
  und während das LLM denkt. Der AudioSocket-Playout-Takt läuft dazu bei aktiver Ambience
  durchgehend (statt nach ~1 s Stille zu pausieren) und mischt den Loop in jedes 20-ms-Frame
  (int16-Clamp; `pendingMs()` zählt weiterhin nur TTS → `end_call`-Drain und Barge-in-Metrik
  unverändert). Barge-in (`flush()`) verwirft nur TTS — die Atmosphäre läuft nahtlos weiter.
- **Eingebaute, lizenzfreie Presets** `office` / `room` / `rain` — prozedural generiert
  (deterministisches Seed-Rauschen + Filter, 16-s-Loop mit Crossfade, ≈ −27 dBFS), keine
  Binär-Assets im Repo/Image, unabhängig von `AUDIO_SAMPLE_RATE`. Eigene Loops via
  `AMBIENCE_DIR` (`<preset>.raw`, slin 16-bit LE mono) übersteuern den Generator.
- **`GET /api/ambience`**: Preset-Manifest für die UI; Agent-Formular mit Toggle, Preset-Select
  und Lautstärke-Regler (0–100 %); Seed-Agent „Vertrieb Demo" (DDI 120) mit aktiver Ambience.
- **ElevenLabs-TTS optional** (`speak.provider: "eleven_labs"`, Voice-ID in `speak.voice`):
  Durchreiche über die Dritt-TTS-Unterstützung der Deepgram Voice Agent API (`model_id` +
  Endpoint mit `xi-api-key`-Header). Der API-Key kommt ausschließlich aus dem Server-Env
  (`ELEVENLABS_API_KEY`) — nie in der DB. Fehlt Key oder Voice-ID, fällt der Anruf mit
  Warn-Log auf die Deepgram-Stimme zurück (ein Anruf scheitert nie an der TTS-Auswahl).

### Notes
- Ambience wird nur beim AudioSocket-Transport unterstützt (`MEDIA_TRANSPORT=rtp` → einmalige
  Warnung, Anruf ohne Atmosphäre); sie landet mit in der Aufnahme (Bridge-Mix) und pausiert,
  sobald ein Mensch den Anruf übernimmt (Transfer connected). Passthrough-Modus: ohne Ambience.

## [0.6.7] – 2026-07-20

### Fixed
- **Verwaiste „laufende" Anrufe nach Engine-Neustart.** Stürzt die Engine mitten im Gespräch ab
  oder wird redeployt, blieb der Request dauerhaft auf `in_progress` — und erschien seit 0.6.3
  für immer in der Live-Ansicht (auf dem Dev-Server standen so 3 Wochen alte Scanner-Anrufe als
  „Läuft"). Beim Engine-Start werden solche Waisen jetzt als `failed` markiert (`endedAt` bleibt
  leer — die echte Endezeit ist unbekannt, die UI zeigt „—").

## [0.6.6] – 2026-07-20

### Fixed
- **Anruf-Detail: Summary blieb auf „pending" stehen.** Das Auto-Refresh (0.6.3) endete mit
  dem Statuswechsel auf completed — Post-Call-Summary (Agent-Modus) und Batch-Transkription
  (Passthrough) starten aber erst danach. Das Polling läuft jetzt weiter, solange etwas auf
  „pending" steht (Nachlauf-Deckel ~3 min gegen dauerhaft hängende Zustände).

## [0.6.5] – 2026-07-20

MCP-Anbindung: ein Agent kann komplette MCP-Server (Model Context Protocol) als Tool-Quelle
einbinden — Tools erscheinen dem LLM präfixiert als `<server>_<tool>`. Doku in `docs/tools.md`.

### Added
- **`agent.mcpServers[]`** (Schema-validiert): `name` (= Tool-Präfix), `url` (Streamable
  HTTP), `headers` (statisch, `${ENV:NAME}`-Platzhalter), `toolFilter` (Whitelist),
  `timeoutMs`, `enabled`. Editor im Agent-Formular (Liste + Modal analog Custom-Tools).
- **`src/tools/mcp.ts`**: Tool-Listen-Cache pro Server-URL (TTL ~5 min — Call-Aufbau wartet
  nie auf `tools/list`), Client-Aufbau via `@modelcontextprotocol/sdk` (gepinnt 1.29.0),
  Ergebnis-Normalisierung (structuredContent bzw. konkatenierte Text-Teile).
- **Toolset-Integration:** MCP-Tools präfixiert im per-Call-Toolset; Verbindung **lazy** beim
  ersten Dispatch, lebt für die Call-Dauer, `toolset.close()` (Hook aus 0.6.1) schließt sie.
  Unerreichbarer Server → Anruf startet ohne dessen Tools (Warn-Log), Greeting blockiert nie.
- **Tests** (`test/mcpToolset.test.ts`): Mini-MCP-Server mit demselben SDK (stateless
  Streamable HTTP) — list+call übers Toolset, isError→ok:false, toolFilter, Cache-Nachweis
  (keine HTTP-Anfragen beim zweiten Toolset), unerreichbarer Server.

## [0.6.4] – 2026-07-20

Per-Call-Metriken: Antwortlatenz und Interaktionszähler werden pro Anruf persistiert und im
Admin-UI angezeigt — „fühlt sich langsam an" wird damit zur Zahl.

### Added
- **`requests.metrics`** (Subdokument, ein Write beim Finalisieren): `timeToFirstAudioMs`
  (Answer → erstes Begrüßungs-Audio), `bargeIns` (gezählt nur, wenn der Agent gerade hörbar
  war — Puffer spielt noch oder Audio < 1,5 s her), `toolCalls`/`toolErrors`,
  `voiceProvider`/`sttModel` (für A/B-Vergleiche nova-3 vs. flux pro Anruf).
- **Anruf-Detail:** Badge-Zeile „Erste Antwort 1,2 s", „2 Barge-ins", „3 Tools (1 Fehler)".
- `finalizeRequest(id, status, metrics?)` — abwärtskompatibel erweitert; Lifecycle-Test für
  Messpunkte inkl. Barge-in-Guard (kein Zähler beim regulären Nutzer-Turn).

## [0.6.3] – 2026-07-20

Live-Call-Ansicht im Admin-UI: laufende Anrufe auf einen Blick, wachsendes Transkript ohne
manuelles Neuladen.

### Added
- **Tab „Live"** (`#/live`, `webui/js/views/live-view.js`): laufende Anrufe
  (`status=in_progress`) mit tickender Dauer (1-s-Ticker) und Läuft-Badge; 3-s-Polling,
  Klick öffnet das Anruf-Detail. Empty-State, stiller Retry bei Netzfehlern.
- **Anruf-Detail:** bei laufendem Anruf alle 2 s stiller Reload (kein Lade-Flackern) —
  Transkript und Funktionsaufrufe wachsen live mit; Polling endet mit dem Terminal-Status.
- **Partial-Index** auf `requests.status` (nur `in_progress`) — die Live-Abfrage bleibt
  billig, egal wie groß die Anruf-Historie wird.

### Changed
- Polling statt Push (bewusst): Admin-Prozess und Engine teilen nur die Standalone-MongoDB
  (keine Change Streams). Ausbaustufe Replica-Set → Change Streams → SSE steht im Backlog.
- Service-Worker-Shell-Cache auf v2 (neue View precached).

## [0.6.2] – 2026-07-20

Tool-Verwaltung im Admin-UI: eingebaute Tools als Schalter, eigene HTTP-Tools als Liste mit
Modal-Editor — die Custom-Tools aus 0.6.1 sind damit ohne API-Handarbeit pflegbar.

### Added
- **Agent-Formular: Built-in-Tools als Toggle-Liste** (statt Komma-Text), gespeist aus dem
  neuen **`GET /api/tools`** (Registry-Namen + Beschreibungen, requireAuth).
- **Agent-Formular: Custom-Tool-Editor** (`glk-modal`): Name (Muster-, Built-in-Kollisions-
  und Duplikat-Prüfung), Beschreibung, Methode (POST/GET), Endpoint-URL, Timeout, dynamische
  Header-Zeilen mit `${ENV:NAME}`-Hinweis, Parameters als JSON-Schema-Textarea mit
  JSON-Validierung, Aktiv-Toggle, Entfernen. Persistiert über den normalen Agent-PATCH.

### Changed
- OpenAPI-`info.version` kommt aus package.json statt hartkodiert (neuer Export
  `appVersion()` in util/banner).

## [0.6.1] – 2026-07-20

Per-Agent-HTTP-Tool-Endpoints: fachliche Tools (CRM-Lookup, Terminbuchung, …) laufen als
externe HTTP-Endpoints und werden pro Agent in der DB hinterlegt — die Engine bleibt
Kern-Telefonie. Vollständiger Kontrakt in `docs/tools.md`.

### Added
- **`agent.customTools[]`** (Mongoose-Subschema mit Validierung): `name` (klein_mit_unterstrichen,
  eindeutig, Built-in-Kollisionen abgewiesen), `description`, `parameters` (JSON-Schema),
  `endpoint` (`url` http(s), `method` GET/POST, `headers`, `timeoutMs` 500–30000), `enabled`.
- **Per-Call-Toolset** (`src/tools/toolset.ts`): führt eingebaute Tools (`agent.tools`) und
  Custom-HTTP-Tools zusammen; `dispatch()` wirft nie (Fehler → sprechbares `{error}`-Ergebnis,
  Ergebnis-Kappung ~4 kB), `close()`-Hook für call-gebundene Ressourcen (MCP-Vorbereitung).
- **HTTP-Executor**: POST-Envelope `{arguments, call:{callId, callerNumber?, agentId?,
  targetNumber?}}` bzw. GET-Query; `${ENV:NAME}`-Platzhalter in URL/Headern (Secrets bleiben
  in der Umgebung, nicht in der DB); hartes Timeout via `AbortSignal.timeout`
  (`src/util/http.ts`).
- **`ToolContext`** um `agentId`/`targetNumber` erweitert (transportneutral, keine ARI-Objekte).
- **Tests** (`test/toolset.test.ts`, 10 Fälle gegen lokalen HTTP-Server): Envelope, GET-Query,
  `${ENV:}`-Auflösung, Text-Antwort, 5xx, Timeout, Ergebnis-Kappung, Merge/Kollision/disabled,
  werfender Handler, unbekanntes Tool/kaputtes JSON. Plus Lifecycle-Test: `toolset.close()`
  läuft im Teardown.
- `docs/tools.md`: Endpoint-Kontrakt, Secrets, Dead-Air-Hinweis, Beispiel-Endpoint.

### Changed
- **callHandler** nutzt das per-Call-Toolset statt der globalen Registry-Dispatch-Funktionen
  (`buildFunctionDefinitions`/`dispatchTool` entfallen); Registry enthält nur noch die
  Built-ins (`registerTool`/`getTool`/`listTools`).

### Fixed
- **Function-Call-Status**: fehlgeschlagene Tool-Aufrufe werden jetzt mit `status: "error"`
  protokolliert (vorher immer `"ok"`); das Anruf-Detail im Admin-UI zeigt Fehler damit korrekt an.

## [0.6.0] – 2026-07-20

Voice-Provider-Abstraktion als Fundament für weitere Agent-Plattformen (ElevenLabs, OpenAI
Realtime, xAI Grok, eigene `NativeSession`-Kaskade) + Flux-Auswahl in der Admin-UI +
Call-Lifecycle-Tests.

### Added
- **Provider-Abstraktion `VoiceAgentSession`** (`src/voice/types.ts`) + Factory
  (`src/voice/factory.ts`): der `callHandler` spricht nur noch gegen das neutrale Interface;
  die Deepgram-`AgentSession` ist der erste Adapter. Neue Provider = neuer Adapter + ein
  case in der Factory — ohne Änderung am Call-Pfad.
- **Agent-Feld `voiceProvider`** (Enum, Default `deepgram`; Nichtimplementiertes wird schon
  beim Speichern abgewiesen) end-to-end: Mongoose-Schema, `ResolvedAgent`, Resolver,
  Formular-Select in der Admin-UI.
- **Admin-UI: STT-Modell-Auswahl** `nova-3` / `flux-general-multi` / `flux-general-en` als
  Select im Agent-Formular; bei Flux erscheinen die Felder `eot_threshold` /
  `eot_timeout_ms` (modellintegrierte End-of-Turn-Erkennung). Flux ist damit ohne
  Code-Änderung pro Agent aktivierbar (A/B gegen nova-3 pro DDI).
- **Call-Lifecycle-Tests** (`test/callLifecycle.test.ts`, 14 Fälle): Doppel-INVITE-Dedup
  (sipgate-Regression), Unknown-DDI-Reject, Audio-Bridging, Barge-in, Transkript-Reihenfolge,
  FunctionCall-Korrelation, end_call-Drain (Mock-Timer), Transfer connected/failed/Klingelphase,
  Cleanup-Idempotenz, Session-Fehlerpfade — komplett gegen Fakes (`test/helpers/`), ohne
  Asterisk/Cloud/DB. Dazu ein WS-Loopback-Test des Deepgram-Adapters und Factory-Tests.
- **DI-Naht im callHandler** (`CallHandlerDeps`, optionaler 4. Parameter von
  `handleStasisStart`) + transportneutrales `CallMedia`-Interface — zugleich die dokumentierte
  Andockstelle für einen künftigen WebRTC-Ingress (siehe docs/architecture.md „Zwei Nähte").

### Changed
- **Session-Lifecycle:** WS-Connect aus dem `AgentSession`-Konstruktor in ein explizites
  `await session.start()` **nach** der Event-Verdrahtung verschoben. Schlägt der Connect fehl,
  endet der Anruf jetzt sauber mit `cleanup("failed")` + Hangup (vorher: stummes Hängen).
- `eot_threshold`/`eot_timeout_ms` werden nur noch bei `flux-*`-Modellen an Deepgram gesendet
  (nova-3 lehnt die Felder ab — schützt per API befüllte Altdaten).
- `FunctionDefinition` ist provider-neutral nach `src/voice/types.ts` umgezogen
  (`deepgram/events.ts` re-exportiert).

### Fixed
- **Flux-Settings an die aktuelle API-Spec angepasst** (empirisch gegen die Live-API
  verifiziert): Flux verlangt `version: "v2"` im listen-Provider und lehnt `language`/
  `smart_format` mit „Error parsing client message" ab; `language_hints` nur beim
  multilingualen Modell. `eot_threshold`/`eot_timeout_ms` werden akzeptiert. Ohne den Fix
  wäre jeder über die neue GUI-Auswahl aktivierte Flux-Agent beim Anruf gescheitert.
- **Admin-UI verlor beim Speichern Subdokument-Felder:** PATCH ersetzt `listen`/`speak`
  komplett; das Formular schrieb bisher nur `speak.model` zurück → `speak.provider`,
  `speak.voice`, `listen.keyterms` u. a. fielen bei jedem UI-Save auf Defaults zurück.
  Jetzt werden beide Subdokumente vollständig gemergt zurückgeschrieben.

## [0.5.8] – 2026-06-29

Sicherheits-Härtung gegen SIP-Scanner + sauberes Verhalten bei unbekannter Rufnummer.

### Security
- **Kein anonymer SIP-Zutritt mehr.** SIP-Scanner (sipvicious & Co.) klopfen den öffentlichen
  `5060/udp` permanent ab; bisher waren die **fest ins Image gebackenen Dev-Softphones**
  (`softphone`/`softphone`, `101`/`101`) immer aktiv und über erratbare Logins brute-force-bar →
  eingeschleuste Anrufe lösten KI-Sessions aus (Kosten + volllaufendes Anruflog). Jetzt:
  - Dev-Softphones werden nur noch bei **`DEV_SOFTPHONE_ENABLED=true`** (Default **aus**) vom
    entrypoint als `pjsip_local.conf` erzeugt (Passwörter via `DEV_SOFTPHONE_PASSWORD` /
    `DEV_SOFTPHONE_101_PASSWORD`). Auf einer öffentlichen Appliance existiert **kein** ratbarer
    Endpoint mehr; Inbound läuft ausschließlich über den IP-gebundenen Trunk (`identify`).
  - `[global]`-Härtung in der pjsip.conf; **kein** `anonymous`-Endpoint → unidentifizierte INVITEs
    werden mit `401` abgewiesen.

### Added
- **`UNKNOWN_NUMBER_BEHAVIOR`** (Default `reject`): Verhalten, wenn eine DDI **keinem** Agent
  zugeordnet ist — `reject` (vor dem Answer mit `404 unallocated` ablehnen → Anrufer-Netz spielt
  „kein Anschluss"; **0 Kosten, kein Logeintrag**), `announce` (Ansage `UNKNOWN_NUMBER_ANNOUNCEMENT`
  abspielen + auflegen, kein LLM) oder `agent` (Default-Agent — nur Dev). Der Default-Agent ist damit
  **kein** stiller Catch-all mehr.

### Changed
- Dialplan `[inbound]`: **kein `Answer()`** mehr — der Anruf wird erst in der Stasis-App angenommen,
  sobald ein Agent passt (ermöglicht das Pre-Answer-`reject`). `agentResolver` liefert bei Miss `null`;
  der callHandler entscheidet anhand von `UNKNOWN_NUMBER_BEHAVIOR`.
- `docs/configuration.md` + `.env.example`: neue ENV-Parameter, Abschnitt „Unbekannte Rufnummer",
  erweiterte „Sicherheit / Härtung".

## [0.5.7] – 2026-06-28

Freie Trunk-Provider-Wahl (ein Trunk pro Appliance) + Doku.

### Added
- **Trunk-Anbindungsmodus** `TRUNK_AUTH_MODE` = `register` (SIP-Registrierung) **oder** `ip`
  (statische IP-Auth, keine Registrierung) — deckt sipgate/easybell/Placetel ebenso ab wie
  Telekom CompanyFlex/Twilio/Telnyx. Neu: `TRUNK_MATCH` (identify-IPs), `TRUNK_FROM_USER`,
  `TRUNK_CLIP_HEADER` (`ppi`/`pai`). Defaults erhalten das bestehende sipgate-Verhalten.
- **[docs/trunks.md](docs/trunks.md)**: Anbieter-Übersicht (DACH) mit Modus/CLIP/ENV je Provider
  und Beispiel-Konstellationen; in README verlinkt.

### Changed
- README (EN/DE): Telefonie als **provider-agnostisch** beschrieben (nicht nur sipgate) + Verweis
  auf docs/trunks.md. Markenschreibweise durchgängig **sipgate** (klein).

### Ops (nicht im Image)
- Auf dem Live-Host ein systemd-Watcher (`voh-ports.service`), der die Host-Mode-SIP/RTP-Ports nach
  jedem EasyPanel-Redeploy automatisch neu publiziert (kein manuelles `voh-ports.sh` mehr).

## [0.5.6] – 2026-06-28

### Fixed
- **Agent ohne Tools leitete nie weiter:** Über die Admin-UI angelegte Agents hatten `tools: []`,
  womit das LLM weder `transfer_call` noch `end_call` kannte (Agent „redete" über Weiterleiten,
  löste es aber nie aus). Jetzt: (a) der Resolver behandelt leere/fehlende `tools` als Default
  `["transfer_call","end_call"]`, (b) das Agent-Formular hat ein **Tools-Feld** (Komma-getrennt,
  Default `transfer_call, end_call`).

## [0.5.5] – 2026-06-28

### Fixed
- **DDI-Matching vereinheitlicht:** `normalizePhone` entfernt jetzt den internationalen Präfix
  (`+` **oder** `00`), sodass `+49236298381975`, `0049236298381975` und `49236298381975` (so liefert
  der Trunk die DDI) auf dieselbe Form matchen. Vorher matchte ein gespeichertes `+49…` nicht gegen
  die vom Trunk gelieferte `49…`. Ausgehende Wahl nutzt weiterhin garantiertes E.164 mit `+`.

## [0.5.4] – 2026-06-28

Ausgehende Anrufe / externer Transfer über den Trunk.

### Added
- **Externer Transfer über den SIP-Trunk:** `transfer_call` erkennt externe Ziele (PSTN/Mobil) und
  wählt über `PJSIP/<e164>@TRUNK_OUTBOUND_ENDPOINT` raus; interne Durchwahlen bleiben wie bisher.
- **Absender-Rufnummer (CLIP) steuerbar:** SIP-Header `P-Preferred-Identity` (sipgate-Format `49…`).
  Installations-ENV **`TRUNK_CLIP_NO_SCREENING`** + Agent-Feld **`useTransferCallerId`** (Admin-UI-Toggle):
  an + erlaubt ⇒ Original-Anrufernummer (transparente Weiterleitung), sonst eigene Agent-Nummer
  (`targetNumbers[0]`, Fallback **`OUTBOUND_CALLER_ID`**). Neuer ENV `TRUNK_OUTBOUND_ENDPOINT`.
- `util/phone.ts`: `looksExternal()` + `toSipgateCli()` (analog sipgate-`dialhook`), mit Tests.

### Changed
- `docs/configuration.md`: Abschnitt „Ausgehende Anrufe / externer Transfer" + neue ENV-Parameter.

## [0.5.3] – 2026-06-28

Live-Trunk-Härtung (erster echter sipgate-Anruf auf der Appliance).

### Added
- **NAT hinter Docker:** `PUBLIC_IP` (+ `LOCAL_NETS`) — der entrypoint annonciert die öffentliche
  IP via `external_media_address`/`external_signaling_address` und setzt `rtp_symmetric`/`force_rport`/
  `rewrite_contact` am Trunk-Endpoint. Verhindert einseitiges/stummes RTP hinter Container-NAT.
  Best-effort-Auto-Erkennung, wenn leer und Trunk aktiv.
- **`CALL_DEDUP_WINDOW_MS`** (Default 4000): verwirft Doppel-INVITEs mancher Trunks (sipgate stellt
  einen Anruf als zwei parallele Dialoge zu) → keine doppelten Sessions/Requests/Summaries mehr.

### Changed
- `docs/configuration.md`: neue ENV-Parameter, Abschnitt „NAT hinter Docker" (inkl. Host-Modus-Ports
  bei Swarm/EasyPanel) und Hinweis auf die `#`-Falle in ENV-Editoren beim Admin-Passwort.

## [0.5.2] – 2026-06-28

### Changed
- README: Feature-Liste (Emojis), Admin-UI-Screenshots (4-spaltig), **B2B-Positionierung**
  (Anwendungsfälle, Self-hosted-vs-SaaS-Vergleich, Kontakt → Jungherz GmbH), **MonaHilft** verlinkt.
- README **zweisprachig**: englische `README.md` als Default (international) + deutsche
  `README.de.md`, mit gegenseitigem 🇬🇧/🇩🇪-Sprach-Umschalter.
- GitHub-Repo-Beschreibung + Topics gesetzt (Auffindbarkeit/SEO).

## [0.5.1] – 2026-06-28

Appliance-Härtung.

### Added
- ENV-gesteuerter **SIP-Trunk** (`TRUNK_ENABLED`/`TRUNK_SIP_ID`/`TRUNK_SIP_PASSWORD`/`TRUNK_SERVER`/
  `TRUNK_CODECS`); der entrypoint generiert `pjsip_trunk.conf`, das pjsip.conf via `#include` lädt.
  Einzel-Trunk je Appliance; Multi-Trunk/Admin-UI-Verwaltung als spätere Ausbaustufe vorgesehen.
- **E.164-Normalisierung** im DDI-Routing (`util/phone.ts`): `+49…`/`0049…`/Schreibvarianten matchen,
  Dev-Durchwahlen (z. B. `120`) bleiben unberührt.
- Management-API-Zugriff für Drittsysteme via **`ADMIN_API_KEY`** (Header `x-api-key`).
- **Start-Banner** in der Konsole: „VOH"-Blockschrift (mehrfarbig) + Kernmerkmale der aktiven
  Konfiguration (Asterisk, MongoDB, Admin-UI, SIP-Trunk, Summary, Transport, LLM).

### Security
- Warnung bei leerem/Default-`ARI_PASSWORD`. Nach außen nur SIP (5060/udp) + RTP-Range; ARI (8088),
  Media (8090) und MongoDB bleiben intern (Mongo-Port-Mapping nur Dev-Komfort, lokal gebunden).

## [0.5.0] – 2026-06-28

Erste dokumentierte Version, zugleich Rebranding auf **Voice-Office-Hub / VOH-Appliance**.

### Added
- **Kern-Telefonie:** Asterisk (ARI) ↔ Deepgram Voice Agent API über **AudioSocket**; getakteter
  Playout (Jitter-Puffer, Greeting-Lead-in). Deutsche Konversation (nova-3 multilingual,
  Aura-2-Stimme), Think via **Requesty** (umschaltbar auf Deepgram-managed).
- **Persistenz:** `requests`-Collection mit Live-Transkript + `functionCalls`; Anruflänge
  (`durationSec`) und Aufnahmelänge erfasst.
- **Tools:** `transfer_call` (Weiterleitung mit Auto-Rückkehr + durchgeschalteter Beendigung),
  `end_call`, `get_weather` (Demo).
- **Aufnahme:** Bridge-Recording → **GridFS** (Bucket `recordings`).
- **Post-Call-Summary** mit eigenem Modell/Prompt (pro Agent überschreibbar), in Agent- und
  Passthrough-Modus.
- **Passthrough-Modus:** Durchleitung an feste Nummer, gemeinsame Aufnahme, Batch-Transkription
  (Diarization → `caller`/`callee`).
- **Multi-Agent / DDI-Routing:** `agents`-Collection (Routing je Zielrufnummer), Dialplan-Fix,
  Seed-Skript (`npm run seed`).
- **Admin-UI + Management-API:** Node/**Fastify** (JSON-API + **OpenAPI/Swagger**), **Hybrids.js**-SPA
  im **GlassKit**-Glas-Look (ohne Build), Login, Agents-CRUD, Anrufliste/Detail mit Audio-Player,
  Transkript & Summary, Hash-Routing/Deep-Links, **PWA** (Manifest, Service Worker, Icons).
- **Single-Container-Appliance** (Asterisk + Node + MongoDB + Admin) via `supervisord`; eingebetteter
  Asterisk (`EMBED_ASTERISK`).

### Changed
- **Rebranding** von `exius-voice-hub`/`voice-agent` → **Voice-Office-Hub** (npm `voice-office-hub`,
  Docker `voh-appliance`, ARI-App `voice-office-hub`); neues HUB-Familien-Icon.
- Admin-UI von Python/FastAPI auf **Node/Fastify** umgestellt (API-First, Mongoose-Modelle
  wiederverwendet).

### Removed
- Python-Admin-UI samt Python-Runtime aus dem Container.
- `customers`-Collection und das `lookup_customer`-Demo-Tool.
