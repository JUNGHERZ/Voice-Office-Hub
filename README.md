# Voice-Office-Hub

**🇬🇧 English** · [🇩🇪 Deutsch](README.de.md)

[![Version](https://img.shields.io/badge/version-0.6.16-f5a623)](CHANGELOG.md)
![Node](https://img.shields.io/badge/node-%E2%89%A520-339933?logo=node.js&logoColor=white)
![TypeScript](https://img.shields.io/badge/TypeScript-5-3178C6?logo=typescript&logoColor=white)
![Docker](https://img.shields.io/badge/Docker-single--container-2496ED?logo=docker&logoColor=white)
![Status](https://img.shields.io/badge/status-active-success)
[![License](https://img.shields.io/badge/license-CC%20BY--NC%204.0-lightgrey)](LICENSE)
[![Changelog](https://img.shields.io/badge/changelog-0.6.16-blue)](CHANGELOG.md)

> **VOH-Appliance** — Voice-Office-Hub. Part of the **"*-Office-Hub"** product family
> (sister project: Message-Office-Hub for chat/email/WhatsApp/SMS).

**AI phone agents as a self-hostable appliance.** A call from landline/mobile is answered by an
AI agent, handled naturally, and handed off to a human when needed — **GDPR-compliant in your own
data center**, in a **single** Docker container.

## ✨ Features

- 📞 **Telephony AI agent** — call answering & natural voice dialogue (Deepgram Voice Agent)
- 🔌 **Provider-neutral engine** — voice platforms dock behind one interface: Deepgram Voice
  Agent or the **built-in native pipeline** per agent; ElevenLabs S2S, OpenAI Realtime and
  xAI Grok are prepared seams
- ⚡ **Native cascade (own orchestration)** — Flux STT → streaming LLM → streaming TTS with
  sentence overlap and two-layer barge-in cancellation; noticeably snappier turns and roughly
  a third of the bundled agent's media cost
- 🇩🇪 **Multilingual** — German-language conversation out of the box (nova-3/Flux + Aura-2,
  STT model selectable per agent)
- 🗣️ **TTS voices** — Deepgram Aura-2 or optionally **ElevenLabs** per agent (voice ID on the
  agent, API key stays in the server env)
- 🎧 **Background ambience** — optional per-agent room tone under and between agent speech
  (bundled license-free presets: office/room/rain)
- 🌐 **Embeddable web widget** — visitors call the agent right in the browser (one script
  tag; WebRTC via Asterisk, level-driven speaking animation, optional live transcript)
- 🔀 **Transfer & hang-up** — warm transfer to humans, autonomous call ending
- 🧩 **Tools / function calling** — per-agent HTTP endpoints for your business logic **plus
  MCP servers** as tool sources, both managed in the admin UI (`${ENV:}` secrets stay server-side)
- 📡 **Live view & metrics** — running calls with live transcript; per-call time-to-first-answer,
  barge-ins, and tool stats
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
against a **voice-agent provider behind a neutral interface** — today the **Deepgram Voice Agent
API** (Listen → Think → Speak); further platforms (ElevenLabs, OpenAI Realtime, xAI Grok) and an
own STT→LLM→TTS pipeline dock onto the same seam. The agent can call **tools** (per-agent HTTP
endpoints and **MCP servers**), **transfer**, **hang up**, and store the conversation as a
**transcript + audio** (MongoDB/GridFS) as well as a **post-call summary**.

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
PSTN → Asterisk (ARI + externalMedia/AudioSocket) → Node engine → Voice provider (Deepgram today;
                                                        │          ElevenLabs/OpenAI Realtime/Grok dockable)
                                                        │                → MongoDB/GridFS
                                Think via Requesty (e.g. Gemini 3.1 Flash Lite)
                                Summary via dedicated model (e.g. GPT-4.1 Mini)
                                Tools: per-agent HTTP endpoints + MCP servers
```

Details: [docs/architecture.md](docs/architecture.md) (incl. the two seams for future providers
and a WebRTC ingress).

## Quickstart (local, OrbStack)

```bash
cp .env.example .env        # fill in: DEEPGRAM_API_KEY, REQUESTY_API_KEY, ARI_PASSWORD, ...
./run.sh build
./run.sh up
./run.sh logs
```

Then create the demo agents once (`docker exec voh-appliance node /app/dist/scripts/seedAgents.js`),
register a **SIP softphone** (Zoiper/Linphone) with the container's Asterisk (`softphone`/`softphone`,
requires `DEV_SOFTPHONE_ENABLED=true`) and call `120` (sales demo) or `121` (support demo, Flux).
For transfer tests, register a second softphone as `101`/`101` (target of `transfer_call`); `199` is
a pure Asterisk echo test (mic check). Calls to numbers without an agent are rejected by default
(`UNKNOWN_NUMBER_BEHAVIOR=reject`).

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
- [docs/configuration.md](docs/configuration.md) — ENV, operating modes, agent fields, operations (in German)
- [docs/tools.md](docs/tools.md) — per-agent tools: HTTP endpoint contract & MCP servers (in German)
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
Hybrids/GlassKit, JSON API + OpenAPI, login, agents CRUD, call list/detail with audio player),
**voice-provider abstraction** (neutral `VoiceAgentSession` + factory; nova-3/Flux selectable per
agent), **per-agent tools** (HTTP endpoints + **MCP servers** with admin-UI editors), **live call
view** (running calls, auto-refreshing detail), **per-call metrics** (time-to-first-audio,
barge-ins, tool counts), **background ambience**, the **embeddable WebRTC web widget** and the
**native STT→LLM→TTS cascade** (`voiceProvider: "native"`: Flux + streaming LLM + Aura-2/
ElevenLabs TTS) — backed by 112 unit/integration tests (call lifecycle, toolset, MCP, widget
endpoints and all three native streaming clients against loopback servers).
Next stages: S2S voice providers (ElevenLabs, OpenAI Realtime, Grok), fully local pipeline
(Whisper/Ollama/Piper) for an on-prem tier, TURN support and widget theming.

## License

**Creative Commons Attribution-NonCommercial 4.0 (CC BY-NC 4.0)** — © 2026 Jungherz GmbH.
See [LICENSE](LICENSE): use/distribution/adaptation with attribution permitted, **no commercial
use** without a separate agreement.
