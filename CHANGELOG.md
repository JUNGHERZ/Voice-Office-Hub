# Changelog

Alle nennenswerten Änderungen an diesem Projekt werden hier dokumentiert.
Das Format orientiert sich an [Keep a Changelog](https://keepachangelog.com/de/1.1.0/),
die Versionierung folgt [Semantic Versioning](https://semver.org/lang/de/).

## [Unreleased]

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
