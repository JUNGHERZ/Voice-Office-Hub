# Changelog

Alle nennenswerten Änderungen an diesem Projekt werden hier dokumentiert.
Das Format orientiert sich an [Keep a Changelog](https://keepachangelog.com/de/1.1.0/),
die Versionierung folgt [Semantic Versioning](https://semver.org/lang/de/).

## [Unreleased]

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
