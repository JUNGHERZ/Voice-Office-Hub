# Deepgram Voice Agent

Telefonisch erreichbarer KI-Voice-Agent: ein Anrufer aus dem öffentlichen Telefonnetz landet
über **Asterisk** (ARI) in unserer **Node.js/TypeScript**-Komponente, die pro Anruf eine Session
gegen die **Deepgram Voice Agent API** orchestriert (Listen → Think → Speak). Der Agent kann
**Tools** aufrufen, **weiterleiten** und das Gespräch als **Transkript + Audio** (MongoDB/GridFS)
ablegen.

Alles läuft in **einem Docker-Container** (Asterisk + Node-Kern + MongoDB + Python-Admin-UI),
lokal wie in Produktion — Unterschied nur über die `.env`.

## Architektur (Kurzfassung)

```
PSTN → Asterisk (ARI) → Node-Kern → Deepgram Voice Agent → MongoDB/GridFS
                                       │
                                Think/Summary via Requesty.ai
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
(`softphone`/`softphone`) und die Test-Durchwahl `100` anrufen.

## Entwicklung ohne Container

```bash
npm install
npm run dev        # benötigt erreichbares Asterisk (ARI) + MongoDB
```

## Dokumentation

- [docs/architecture.md](docs/architecture.md) — Komponenten, Datenfluss, Datenmodell
- [docs/asterisk-sipgate.md](docs/asterisk-sipgate.md) — Asterisk + SIPGate-Trunk
- [docs/configuration.md](docs/configuration.md) — ENV, Betriebsmodi, Tools, Betrieb

## Status

Greenfield-Aufbau entlang des genehmigten Plans. Erste Implementierung: Kern (ARI ↔ Deepgram),
Persistenz, Tools, Transfer, Aufnahme, Summary. Spätere Ausbaustufen: Passthrough-Modus,
Multi-Agent/DDI-Routing, Admin-UI, Appliance-Härtung.
