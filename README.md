# Voice-Office-Hub

**🇬🇧 English** · [🇩🇪 Deutsch](README.de.md)

[![Version](https://img.shields.io/badge/version-0.5.8-f5a623)](CHANGELOG.md)
![Node](https://img.shields.io/badge/node-%E2%89%A520-339933?logo=node.js&logoColor=white)
![TypeScript](https://img.shields.io/badge/TypeScript-5-3178C6?logo=typescript&logoColor=white)
![Docker](https://img.shields.io/badge/Docker-single--container-2496ED?logo=docker&logoColor=white)
![Status](https://img.shields.io/badge/status-active-success)
[![License](https://img.shields.io/badge/license-CC%20BY--NC%204.0-lightgrey)](LICENSE)
[![Changelog](https://img.shields.io/badge/changelog-0.5.8-blue)](CHANGELOG.md)

> **VOH-Appliance** — Voice-Office-Hub. Part of the **"*-Office-Hub"** product family
> (sister project: Message-Office-Hub for chat/email/WhatsApp/SMS).

**AI phone agents as a self-hostable appliance.** A call from landline/mobile is answered by an
AI agent, handled naturally, and handed off to a human when needed — **GDPR-compliant in your own
data center**, in a **single** Docker container.

## ✨ Features

- 📞 **Telephony AI agent** — call answering & natural voice dialogue (Deepgram Voice Agent)
- 🇩🇪 **Multilingual** — German-language conversation out of the box (nova-3 + Aura-2)
- 🔀 **Transfer & hang-up** — warm transfer to humans, autonomous call ending
- 🧩 **Tools / function calling** — connect your own business logic via external APIs
- 🗂️ **Transcript & recording** — full text + audio (MongoDB/GridFS) + post-call summary
- ☎️ **Passthrough mode** — pure forwarding + recording + batch transcription
- 🎯 **Multi-agent / DDI routing** — a dedicated agent per phone number
- 🖥️ **Admin UI + API** — glass-look interface + JSON API (OpenAPI) for management & integration
- 📦 **Single-container appliance** — Asterisk + engine + DB + UI; one image, local as in production
- 🔒 **Self-hosted & GDPR** — calls, recordings, transcripts stay in your infrastructure

## 📸 Glimpses (Admin UI)

| Dashboard | Agents | Edit agent | Call detail |
|:--:|:--:|:--:|:--:|
| <img src="docs/screenshots/voh_admin_ui_intro1.png" alt="Dashboard" width="210"> | <img src="docs/screenshots/voh_admin_ui_intro3.png" alt="Agents list" width="210"> | <img src="docs/screenshots/voh_admin_ui_intro4.png" alt="Edit agent" width="210"> | <img src="docs/screenshots/voh_admin_ui_intro2.png" alt="Call detail with audio player and transcript" width="210"> |

## How it works

A phone-reachable AI voice agent: a caller from the public telephone network arrives via
**Asterisk** (ARI) in our **Node.js/TypeScript** engine, which orchestrates one session per call
against the **Deepgram Voice Agent API** (Listen → Think → Speak). The agent can call **tools**,
**transfer**, **hang up**, and store the conversation as a **transcript + audio** (MongoDB/GridFS)
as well as a **post-call summary**.

Everything runs in a **single Docker container** (Asterisk + Node core + MongoDB + Node admin
UI/API), local as in production — the only difference is the `.env`.

The telephony side connects to a **freely selectable SIP trunk provider** — **sipgate** (tested in
production), easybell, Placetel, fonial, Telekom CompanyFlex, Twilio/Telnyx, and more — configured
via `.env` (one trunk per appliance, registration **or** static-IP auth). See the provider overview
in **[docs/trunks.md](docs/trunks.md)**.

The **admin UI** is an API-first app: a Node/**Fastify** service exposes a **JSON API**
(agents CRUD, calls/requests, OpenAPI); the frontend is a **[Hybrids.js](https://hybrids.js.org/)** SPA
in the **[GlassKit](https://glasskit.jungherz.com/)** glass look (Web Components, no build step). Available on `UI_PORT` (default `8080`)
once `ADMIN_PASSWORD` is set; OpenAPI at `/openapi.json`, Swagger UI at `/docs`.

## Used by

Voice-Office-Hub is being built as part of the **[MonaHilft](https://monahilft.de)** product and is
used there **in production**.

Is your organization using VOH too? We're happy to list additional users here — just let us know via PR/issue:

- **[MonaHilft](https://monahilft.de)** — production use (AI phone agents)
- _… your company?_

## 🏢 For companies (B2B)

Voice-Office-Hub is designed as an **appliance for enterprise use** — for organizations that want to
run AI phone agents **in their own infrastructure** instead of handing conversations to a third-party
cloud platform.

- 🔒 **Data sovereignty & GDPR** — self-hosted in your own data center; calls/recordings/transcripts stay with you.
- 🧩 **Integratable** — JSON API (OpenAPI) + function calling connect CRM, ticketing, or business systems.
- 📦 **Quick to roll out** — one container, configuration via `.env`; from softphone test to
  SIP trunk, the same image.
- 🎛️ **Customizable** — agents, prompts, voices, and routing per phone number; branding/features extensible.
- 🧠 **Model-flexible** — STT/TTS/LLM selectable (Deepgram, your own models via Requesty).

### 🎯 Typical use cases

- **Hotline relief** — answer standard inquiries automatically, absorb load spikes.
- **Appointment scheduling & rescheduling** — right within the call, connected to calendar/practice systems.
- **After-hours / 24-7 answering** — stay reachable outside business hours.
- **Pre-qualify & route** — capture the request and warm-transfer it to the right place.
- **Callback & message capture** — structured, including transcript and summary.
- **Phone information** — FAQ, status, opening hours in natural language.

### ⚖️ Self-hosted instead of SaaS

| | Voice-Office-Hub (self-hosted) | Cloud SaaS |
|---|---|---|
| **Data sovereignty** | ✅ data in your own data center | ❌ conversations at a third party |
| **GDPR** | ✅ full control | ⚠️ DPA/third-country concerns |
| **Cost model** | license/appliance, predictable | mostly per minute |
| **Customizability** | ✅ open (API, tools, prompts) | limited |
| **Vendor lock-in** | low (self-operated) | high |

**Consulting & implementation:** **Jungherz GmbH** supports with conception, customizing, and
operations — from trunk integration through tailored agents/tools to deployment in your own data
center. 👉 Contact & reference: **[Jungherz GmbH](https://www.jungherz.com/)** or open an issue in this repo.

## Architecture (short version)

```
PSTN → Asterisk (ARI + externalMedia/AudioSocket) → Node engine → Deepgram Voice Agent → MongoDB/GridFS
                                                        │
                                Think via Requesty (e.g. Gemini 3.1 Flash Lite)
                                Summary via dedicated model (e.g. GPT-4.1 Mini)
```

Details: [docs/architecture.md](docs/architecture.md).

## Quickstart (local, OrbStack)

```bash
cp .env.example .env        # fill in: DEEPGRAM_API_KEY, REQUESTY_API_KEY, ARI_PASSWORD, ...
./run.sh build
./run.sh up
./run.sh logs
```

Then register a **SIP softphone** (Zoiper/Linphone) with the container's Asterisk
(`softphone`/`softphone`) and call the test extension `100`. For transfer tests, register a second
softphone as `101`/`101` (target of `transfer_call`).

In dev, MongoDB can be inspected via a GUI client (e.g. NoSQL Booster) at `127.0.0.1:27100` (DB `voiceagent`).

## Development without a container

```bash
npm install
npm run dev        # requires a reachable Asterisk (ARI) + MongoDB
```

## Documentation

- [docs/architecture.md](docs/architecture.md) — components, data flow, data model, implementation status (in German)
- [docs/trunks.md](docs/trunks.md) — supported SIP trunk providers (sipgate, easybell, Placetel, Telekom, Twilio …) & how to configure them (in German)
- [docs/asterisk-sipgate.md](docs/asterisk-sipgate.md) — Asterisk + sipgate trunk, worked example (in German)
- [docs/configuration.md](docs/configuration.md) — ENV, operating modes, tools, operations (in German)
- [docs/backlog.md](docs/backlog.md) — open items & ideas (Web/WebRTC, admin UI, denoising, Flux …) (in German)
- [CHANGELOG.md](CHANGELOG.md) — version history
- [README.de.md](README.de.md) — full German version of this README

## Status

Functional (verified via real calls): core (ARI ↔ Deepgram over AudioSocket), German conversation,
**persistence** (transcript/functionCalls), **tools** (`transfer_call`, `end_call`), **transfer**
with auto-return + pass-through termination, **recording** in GridFS, **post-call summary**
(dedicated model, agent + passthrough), **passthrough mode** (forwarding + recording + batch
transcription, `DEFAULT_MODE=passthrough`; diarization speaker separation still to be verified with
a two-device setup), **multi-agent/DDI routing** (`agents.targetNumbers`, the dialplan passes the
real DDI through; demo agents via `npm run seed`), **admin UI + management API** (Node/Fastify +
Hybrids/GlassKit, JSON API + OpenAPI, login, agents CRUD, call list/detail with audio player).
Next stages: PWA polish, appliance hardening (sipgate trunk).

## License

**Creative Commons Attribution-NonCommercial 4.0 (CC BY-NC 4.0)** — © 2026 Jungherz GmbH.
See [LICENSE](LICENSE): use/distribution/adaptation with attribution permitted, **no commercial
use** without a separate agreement.
