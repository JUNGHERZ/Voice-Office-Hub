# Voice-Office-Hub

[🇬🇧 English](README.md) · **🇩🇪 Deutsch**

[![Version](https://img.shields.io/badge/version-0.5.6-f5a623)](CHANGELOG.md)
![Node](https://img.shields.io/badge/node-%E2%89%A520-339933?logo=node.js&logoColor=white)
![TypeScript](https://img.shields.io/badge/TypeScript-5-3178C6?logo=typescript&logoColor=white)
![Docker](https://img.shields.io/badge/Docker-single--container-2496ED?logo=docker&logoColor=white)
![Status](https://img.shields.io/badge/status-active-success)
[![License](https://img.shields.io/badge/license-CC%20BY--NC%204.0-lightgrey)](LICENSE)
[![Changelog](https://img.shields.io/badge/changelog-0.5.6-blue)](CHANGELOG.md)

> **VOH-Appliance** — Voice-Office-Hub. Teil der **„*-Office-Hub"**-Produktfamilie
> (Schwesterprojekt: Message-Office-Hub für Chat/E-Mail/WhatsApp/SMS).

**Telefonische KI-Agenten als selbst-hostbare Appliance.** Ein Anruf aus Festnetz/Mobilfunk wird
von einem KI-Agenten angenommen, natürlich geführt und bei Bedarf an Menschen weitergeleitet —
**DSGVO-konform im eigenen Rechenzentrum**, in **einem** Docker-Container.

## ✨ Features

- 📞 **Telefonie-KI-Agent** — Anrufannahme & natürliche Sprachdialoge (Deepgram Voice Agent)
- 🇩🇪 **Mehrsprachig** — deutschsprachige Konversation ab Werk (nova-3 + Aura-2)
- 🔀 **Transfer & Auflegen** — Warm-Transfer an Menschen, selbsttätiges Beenden
- 🧩 **Tools / Function-Calling** — eigene Fachlogik per externer API anbinden
- 🗂️ **Transkript & Aufnahme** — Volltext + Audio (MongoDB/GridFS) + Post-Call-Zusammenfassung
- ☎️ **Passthrough-Modus** — reine Durchleitung + Mitschnitt + Batch-Transkription
- 🎯 **Multi-Agent / DDI-Routing** — pro Rufnummer ein eigener Agent
- 🖥️ **Admin-UI + API** — Glas-Look-Oberfläche + JSON-API (OpenAPI) zur Verwaltung & Integration
- 📦 **Single-Container-Appliance** — Asterisk + Engine + DB + UI; ein Image, lokal wie Produktion
- 🔒 **Self-hosted & DSGVO** — Anrufe, Aufnahmen, Transkripte bleiben in deiner Infrastruktur

## 📸 Einblicke (Admin-UI)

| Dashboard | Agents | Agent bearbeiten | Anruf-Detail |
|:--:|:--:|:--:|:--:|
| <img src="docs/screenshots/voh_admin_ui_intro1.png" alt="Dashboard" width="210"> | <img src="docs/screenshots/voh_admin_ui_intro3.png" alt="Agents-Liste" width="210"> | <img src="docs/screenshots/voh_admin_ui_intro4.png" alt="Agent bearbeiten" width="210"> | <img src="docs/screenshots/voh_admin_ui_intro2.png" alt="Anruf-Detail mit Audio-Player und Transkript" width="210"> |

## Wie es funktioniert

Telefonisch erreichbarer KI-Voice-Agent: ein Anrufer aus dem öffentlichen Telefonnetz landet
über **Asterisk** (ARI) in unserer **Node.js/TypeScript**-Engine, die pro Anruf eine Session
gegen die **Deepgram Voice Agent API** orchestriert (Listen → Think → Speak). Der Agent kann
**Tools** aufrufen, **weiterleiten**, **auflegen** und das Gespräch als **Transkript + Audio**
(MongoDB/GridFS) sowie eine **Post-Call-Zusammenfassung** ablegen.

Alles läuft in **einem Docker-Container** (Asterisk + Node-Kern + MongoDB + Node-Admin-UI/API),
lokal wie in Produktion — Unterschied nur über die `.env`.

Die **Admin-UI** ist eine API-First-App: ein Node/**Fastify**-Service stellt eine **JSON-API**
(Agents-CRUD, Anrufe/Requests, OpenAPI) bereit; das Frontend ist eine **[Hybrids.js](https://hybrids.js.org/)**-SPA
im **[GlassKit](https://glasskit.jungherz.com/)**-Glas-Look (Web Components, ohne Build). Erreichbar auf `UI_PORT` (Default `8080`),
sobald `ADMIN_PASSWORD` gesetzt ist; OpenAPI unter `/openapi.json`, Swagger-UI unter `/docs`.

## Eingesetzt bei

Voice-Office-Hub entsteht im Rahmen des Produkts **[MonaHilft](https://monahilft.de)** und wird dort
**produktiv** eingesetzt.

Setzt deine Organisation VOH ebenfalls ein? Wir führen hier gern weitere Nutzer auf — einfach per PR/Issue melden:

- **[MonaHilft](https://monahilft.de)** — produktiver Einsatz (telefonische KI-Agenten)
- _… dein Unternehmen?_

## 🏢 Für Unternehmen (B2B)

Voice-Office-Hub ist als **Appliance für den Unternehmenseinsatz** konzipiert — für Organisationen,
die telefonische KI-Agenten **in der eigenen Infrastruktur** betreiben wollen, statt Gespräche an
eine fremde Cloud-Plattform zu geben.

- 🔒 **Datenhoheit & DSGVO** — self-hosted im eigenen RZ; Anrufe/Aufnahmen/Transkripte bleiben bei dir.
- 🧩 **Integrierbar** — JSON-API (OpenAPI) + Function-Calling binden CRM, Ticketing oder Fachsysteme an.
- 📦 **Schnell ausgerollt** — ein Container, Konfiguration per `.env`; vom Softphone-Test bis zum
  SIP-Trunk dasselbe Image.
- 🎛️ **Anpassbar** — Agenten, Prompts, Stimmen und Routing pro Rufnummer; Branding/Funktionen erweiterbar.
- 🧠 **Modell-flexibel** — STT/TTS/LLM wählbar (Deepgram, eigene Modelle via Requesty).

### 🎯 Typische Anwendungsfälle

- **Hotline-Entlastung** — Standardanfragen automatisch beantworten, Lastspitzen abfangen.
- **Terminvereinbarung & -verschiebung** — direkt im Gespräch, Anbindung an Kalender-/Praxissystem.
- **After-Hours / 24-7-Annahme** — auch außerhalb der Geschäftszeiten erreichbar bleiben.
- **Vorqualifizieren & weiterleiten** — Anliegen erfassen und per Warm-Transfer an die richtige Stelle.
- **Rückruf- & Nachrichtenerfassung** — strukturiert inkl. Transkript und Zusammenfassung.
- **Telefonische Auskunft** — FAQ, Status, Öffnungszeiten in natürlicher Sprache.

### ⚖️ Self-hosted statt SaaS

| | Voice-Office-Hub (self-hosted) | Cloud-SaaS |
|---|---|---|
| **Datenhoheit** | ✅ Daten im eigenen RZ | ❌ Gespräche bei Drittanbieter |
| **DSGVO** | ✅ volle Kontrolle | ⚠️ AVV/Drittland-Themen |
| **Kostenmodell** | Lizenz/Appliance, planbar | meist pro Minute |
| **Anpassbarkeit** | ✅ offen (API, Tools, Prompts) | begrenzt |
| **Vendor-Lock-in** | gering (eigener Betrieb) | hoch |

**Beratung & Umsetzung:** Die **Jungherz GmbH** unterstützt bei Konzeption, Customizing und Betrieb —
von der Trunk-Anbindung über maßgeschneiderte Agenten/Tools bis zum Deployment im eigenen
Rechenzentrum. 👉 Kontakt & Referenz: **[Jungherz GmbH](https://www.jungherz.com/)** oder ein Issue in diesem Repo.

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
- [CHANGELOG.md](CHANGELOG.md) — Versionsverlauf

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

## Lizenz

**Creative Commons Attribution-NonCommercial 4.0 (CC BY-NC 4.0)** — © 2026 Jungherz GmbH.
Siehe [LICENSE](LICENSE): Nutzung/Weitergabe/Bearbeitung mit Namensnennung erlaubt, **keine
kommerzielle Nutzung** ohne gesonderte Vereinbarung.
