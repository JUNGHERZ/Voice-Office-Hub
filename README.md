# Voice-Office-Hub

Telefonisch erreichbarer KI-Voice-Agent: ein Anrufer aus dem öffentlichen Telefonnetz landet
über **Asterisk** (ARI) in unserer **Node.js/TypeScript**-Engine, die pro Anruf eine Session
gegen die **Deepgram Voice Agent API** orchestriert (Listen → Think → Speak). Der Agent kann
**Tools** aufrufen, **weiterleiten**, **auflegen** und das Gespräch als **Transkript + Audio**
(MongoDB/GridFS) sowie eine **Post-Call-Zusammenfassung** ablegen.

Alles läuft in **einem Docker-Container** (Asterisk + Node-Kern + MongoDB + Node-Admin-UI/API),
lokal wie in Produktion — Unterschied nur über die `.env`.

Die **Admin-UI** ist eine API-First-App: ein Node/**Fastify**-Service stellt eine **JSON-API**
(Agents-CRUD, Anrufe/Requests, OpenAPI) bereit; das Frontend ist eine **Hybrids.js**-SPA im
**GlassKit**-Glas-Look (Web Components, ohne Build). Erreichbar auf `UI_PORT` (Default `8080`),
sobald `ADMIN_PASSWORD` gesetzt ist; OpenAPI unter `/openapi.json`, Swagger-UI unter `/docs`.

## Architektur (Kurzfassung)

```
PSTN → Asterisk (ARI + externalMedia/AudioSocket) → Node-Engine → Deepgram Voice Agent → MongoDB/GridFS
                                                        │
                                Think via Requesty (z. B. Gemini 3.1 Flash Lite)
                                Summary via eigenes Modell (z. B. GPT-4.1 Mini)
```

Details: [docs/architecture.md](docs/architecture.md).

## Quickstart (lokal, OrbStack)

```bash
cp .env.example .env        # ausfüllen: DEEPGRAM_API_KEY, REQUESTY_API_KEY, ARI_PASSWORD, ...
./run.sh build
./run.sh up
./run.sh logs
```

Dann ein **SIP-Softphone** (Zoiper/Linphone) am Container-Asterisk registrieren
(`softphone`/`softphone`) und die Test-Durchwahl `100` anrufen. Für Transfer-Tests ein zweites
Softphone als `101`/`101` registrieren (Ziel von `transfer_call`).

MongoDB lässt sich im Dev per GUI-Client (z. B. NoSQL Booster) auf `127.0.0.1:27100` (DB `voiceagent`)
inspizieren.

## Entwicklung ohne Container

```bash
npm install
npm run dev        # benötigt erreichbares Asterisk (ARI) + MongoDB
```

## Dokumentation

- [docs/architecture.md](docs/architecture.md) — Komponenten, Datenfluss, Datenmodell, Implementierungsstand
- [docs/asterisk-sipgate.md](docs/asterisk-sipgate.md) — Asterisk + SIPGate-Trunk
- [docs/configuration.md](docs/configuration.md) — ENV, Betriebsmodi, Tools, Betrieb
- [docs/backlog.md](docs/backlog.md) — offene Punkte & Ideen (Web/WebRTC, Admin-UI, Denoising, Flux …)

## Status

Funktionsfähig (über echte Anrufe verifiziert): Kern (ARI ↔ Deepgram über AudioSocket),
deutsche Konversation, **Persistenz** (Transkript/functionCalls), **Tools** (`transfer_call`,
`end_call`), **Transfer** mit Auto-Rückkehr + durchgeschalteter Beendigung, **Aufnahme** in GridFS,
**Post-Call-Summary** (eigenes Modell, agent + passthrough), **Passthrough-Modus** (Durchleitung +
Aufnahme + Batch-Transkription, `DEFAULT_MODE=passthrough`; Diarization-Sprecher-Trennung noch mit
Zwei-Geräte-Setup zu verifizieren), **Multi-Agent/DDI-Routing** (`agents.targetNumbers`, Dialplan
reicht echte DDI durch; Demo-Agents via `npm run seed`), **Admin-UI + Management-API**
(Node/Fastify + Hybrids/GlassKit, JSON-API + OpenAPI, Login, Agents-CRUD, Anrufliste/Detail mit
Audio-Player). Nächste Ausbaustufen: PWA-Feinschliff, Appliance-Härtung (SIPGate-Trunk).
