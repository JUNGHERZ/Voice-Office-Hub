# Backlog & Ideen (noch nicht umgesetzt)

Gesammelte Ideen/Erkenntnisse aus den Testgesprächen. Reihenfolge = grobe Priorität, nicht final.

## Audio / Conversation Experience

### 1. Hintergrundgeräusche (Ambience) optional pro Agent
**Idee:** Leises Büro-/Tippgeräusch als Dauerschleife in den Ausgabe-Mix legen, optional pro Agent
schaltbar. Überbrückt die Stille — besonders während die KI „nachdenkt" (kurze LLM-Latenz) —
und wirkt natürlicher.
- **Umsetzung (machbar, moderat):** Ambience-WAV (8 kHz slin, loopbar) beim Anruf laden und in der
  `MediaSession` dem ausgehenden Audio beimischen (PCM-Addition mit niedrigem Pegel, Clipping
  vermeiden). Lautstärke + Datei pro Agent konfigurierbar (`agents.ambience = { enabled, file, gain }`).
  Während der Sprechpausen (Underrun) statt reiner Stille die Ambience senden.
- **Quelle:** Es gibt Seiten mit frei herunterladbaren Office-/Keyboard-Loops (Nutzer hat eine im Blick).
- **Aufwand:** ~0,5–1 Tag. Kein externer Dienst nötig.

### 2. Background Speech Denoising (Umgebungsgeräusche aus dem Anrufer-Audio filtern)
**Frage des Nutzers:** VAPI bietet das (siehe
https://docs.vapi.ai/documentation/assistants/conversation-behavior/background-speech-denoising).
Wie bei uns?
- **Befund:** **Deepgram hat KEINE eingebaute Rauschunterdrückung** in den Voice-Agent-Settings.
  Deepgram empfiehlt dafür ausdrücklich einen externen Denoiser (Krisp). VAPI/LiveKit binden genau
  das ein (Krisp bzw. ai-coustics).
- **Optionen für uns:**
  1. Auf die inhärente Robustheit von nova-3 vertrauen (echte Telefonate sind bandbegrenzt; Mobil-/
     Festnetz-Hardware entrauscht bereits etwas).
  2. Eigenen Denoiser in die Eingangs-Pipeline (Anrufer→Deepgram) setzen: **RNNoise** (frei) oder
     **Krisp SDK** (kommerziell) vor dem `sendAudio` an Deepgram.
  3. Hinweis Deepgram („Noise-Reduction-Paradox"): zu starke Entrauschung kann die STT-Genauigkeit
     senken — konservativ einstellen.
- **Aufwand:** RNNoise-Integration ~1–2 Tage; Krisp je nach Lizenz mehr.

## STT / Modelle

### 3. Flux als listen-Modell evaluieren (Turn-Detection)
**Frage des Nutzers:** Lohnt sich Flux jetzt schon?
- **Klarstellung:** Wir nutzen für STT aktuell **nova-3** (nicht „Aura 3"). Aura‑2 ist die TTS‑Stimme.
- **Flux:** Deepgrams neues STT-Modell speziell für Voice Agents, mit **modell-integrierter
  End-of-Turn-Erkennung** (`StartOfTurn`, `EagerEndOfTurn`, `TurnResumed`, `EndOfTurn`), „Nova‑3-
  Level-Genauigkeit", geringere Turn-Latenz/weniger Talk-over. Modelle: `flux-general-en`,
  `flux-general-multi` (mehrsprachig). Parameter: `eot_threshold`, `eager_eot_threshold`,
  `eot_timeout_ms` — sind in unserem Code/Resolver bereits vorgesehen.
- **Bewertung:** Verbessert vor allem das Turn-Taking-Gefühl (Stille→Antwort, Barge-in). Integration
  ist bei uns gering-invasiv (nur listen-Modell + eot-Parameter; der `language_hints`-Zweig ist
  schon Flux-spezifisch). **Offen:** Reifegrad/Qualität für **Deutsch** über `flux-general-multi`
  (in der Doc nicht explizit bestätigt).
- **Empfehlung:** **Erst die funktionalen Stufen (Persistenz, Tools/Transfer, Summary) finalisieren**,
  dann Flux als gezielten A/B-Test gegen nova-3 — sofern sich Turn-Taking als Schwachpunkt zeigt.
  Aktuell antwortet der Agent zuverlässig, also kein Blocker. (Eigene `.env`-Schalter `LISTEN_MODEL`
  + eot-Werte machen den A/B-Test billig.)
- **Status 2026-07-20 (0.6.0): weitgehend beantwortet.** Flux ist pro Agent über die Admin-UI
  schaltbar (STT-Modell-Select + eot-Felder); Settings-Format an die aktuelle v2-Spec angepasst
  (Fix `eed7cac` — Flux verlangt `version: "v2"`, lehnt `language`/`smart_format` ab).
  **Deutsch über `flux-general-multi` funktioniert** — vom Nutzer im Live-Test bestätigt
  (Agent 121), inkl. sauberer Mehrsprachigkeit. Gemessene Antwortlatenz lokal: Flux ≈ 2,6 s
  vs. nova-3 ≈ 3,5 s ab Sprechende. **Offen nur noch:** Qualitäts-/Langzeitvergleich am echten
  Trunk (A/B pro DDI). Achtung fürs Testen: loopendes Einspiel-Audio cancelt Flux-Antworten
  (Barge-in) — Test-Audio mit einer Äußerung + Stille verwenden.

## Architektur / Engine-Weiterentwicklung (Architektur-Review 2026-07-18)

### 4. ✅ Umgesetzt in 0.6.0 (2026-07-20): Voice-Provider-Abstraktion (`VoiceAgentSession`)
Interface + Factory in `src/voice/`, Deepgram als erster Adapter (`start()` statt
Konstruktor-Connect), Agent-Feld `voiceProvider` end-to-end (Schema/Resolver/Formular),
DI-Naht `CallHandlerDeps` + transportneutraler `CallMedia`-Kontrakt (WebRTC-Andockpunkt).
Details: [architecture.md → „Zwei Nähte"](architecture.md) + CHANGELOG 0.6.0.

### 5. Externe Tool-Endpoints pro Agent fertigbauen
**Befund:** Größte Lücke zwischen Konzept („fachliche Tools laufen extern, Engine bleibt
Kern-Telefonie") und Implementierung: `tools/registry.ts` hat `endpoint {url, method, headers}`
vorbereitet, aber kein Handler nutzt es; Agents referenzieren nur Namen global registrierter
Tools (`transfer_call`, `end_call`, `get_weather`), keine eigenen Definitionen/URLs.
- **Umsetzung:** Per-Agent-Tool-Definitionen im Schema (`name`, `description`,
  JSON-Schema-`parameters`, `endpoint`-URL, Auth-Header) + Admin-UI-Formular;
  `dispatchTool` → HTTP-Aufruf mit Timeout und Fehlertext als `FunctionCallResponse`
  (Call darf bei Tool-Fehlern nie hängen). Auth-Secrets nicht im Klartext in die DB.
- **Aufwand:** ~2–3 Tage inkl. UI.

### 6. Audio-Pipeline auf 16 kHz (`slin16`) umstellen
**Idee:** Durchgängig 16 kHz statt 8 kHz: bessere STT-Genauigkeit, Voraussetzung für
ElevenLabs `pcm_16000`. Geht rein über ENV (`EXTERNAL_MEDIA_FORMAT=slin16`,
`AUDIO_SAMPLE_RATE=16000`) — Frame-Größen werden im Code bereits aus der Rate berechnet,
Resampling existiert bewusst nicht.
- **Zu prüfen:** Trunk bleibt G.711/8 kHz → Asterisk transcodiert (CPU minimal); Bandbreite zur
  Voice-API verdoppelt sich; Ambience-Dateien (→ 1) müssten dann 16 kHz sein; Regressionstest
  Playout/Barge-in am echten Trunk.
- **Aufwand:** ~0,5–1 Tag inkl. Test.

### 7. Observability: Live-Call-Ansicht + Latenz-Metriken
**Idee:** Admin-UI zeigt laufende Anrufe live (SSE/WebSocket aus der Engine): Zustand
(Greeting/Listening/Speaking/Transfer), Live-Transkript, Dauer. Dazu Metriken: Zeit bis erste
Agent-Antwort, Barge-in-Häufigkeit, Playout-Underruns, Provider-Fehler/Reconnects.
- **Nutzen:** Fehlersuche im Live-Betrieb (arm2/EasyPanel — Stichwort sipgate-Doppel-INVITE)
  ohne Log-Grepping; Latenz-Zahlen sind auch Verkaufsargument.
- **Aufwand:** ~2–3 Tage.

### 8. ✅ Umgesetzt in 0.6.0 (2026-07-20): Call-Lifecycle-Tests gegen FakeSession
14 Fälle in `test/callLifecycle.test.ts` (Dedup/Doppel-INVITE, Unknown-DDI-Reject,
Audio-Bridging, Barge-in, Transkript-Reihenfolge, FunctionCall-Korrelation, `end_call`-Drain
mit Mock-Timern, Transfer connected/failed/Klingelphase, Cleanup-Idempotenz, Fehlerpfade)
+ WS-Loopback-Test des Deepgram-Adapters; Fakes in `test/helpers/`.

### 9. ElevenLabs Conversational AI als zweites Voice-Backend (Voraussetzung 4 ✅; + 6 oder µ-law)
**Idee:** ElevenLabs-Agents-Plattform als alternatives Komplett-Backend (STT + Turn-Taking +
LLM + TTS) neben Deepgram — nicht zu verwechseln mit `speak.provider: eleven_labs` (nur
TTS-Stimme innerhalb der Deepgram-Pipeline, heute schon möglich).
- **Umsetzung:** `src/elevenlabs/agentSession.ts` als zweiter Adapter
  (`wss://api.elevenlabs.io/v1/convai/conversation`): Audio als base64-JSON statt binär,
  Mapping `interruption`→Barge-in, `client_tool_call`→`dispatchTool`,
  `conversation_initiation_client_data` statt `Settings`. Audio: `ulaw_8000` oder
  `pcm_16000` (→ 6). Design-Entscheidung: ElevenLabs-Agents per API provisionieren
  (`agent_id` am Mongo-Agent speichern) vs. generischer Agent mit per-Call-Overrides
  (passt besser zum DB-zentrierten Modell, hat aber Override-Einschränkungen).
- **Aufwand:** ~2–4 Tage inkl. Telefontests.

### 10. Kaskaden-Modus „NativeSession": STT + LLM + TTS direkt, ohne Voice-Agent-Layer (Voraussetzung 4 ✅)
**Namensentscheidung (Nutzer, 2026-07-20):** heißt bei uns `NativeSession` —
Modulplatz `src/native/`, `voiceProvider: "native"` (Enum wird erst bei Implementierung
freigeschaltet).
**Frage des Nutzers (2026-07-19):** Geht es auch ganz ohne externe Agentschicht — nur STT, LLM,
TTS — wie [AVA](https://github.com/hkjarral/AVA-AI-Voice-Agent-for-Asterisk) und
[Agent Voice Response](https://github.com/agentvoiceresponse)?
- **Befund:** Ja — in unserer Architektur ist das schlicht ein weiterer
  `VoiceAgentSession`-Adapter (`CascadeSession`), der intern Streaming-STT → LLM (Requesty,
  vorhanden) → Streaming-TTS verkettet; `callHandler`/`MediaSession` bleiben unberührt.
  Beide Referenzprojekte belegen die Machbarkeit. Bemerkenswert: **beide** bieten neben der
  Kaskade weiterhin integrierte Agent-Provider an (OpenAI Realtime, Deepgram VA, Gemini Live,
  ElevenLabs) — die Kaskade ersetzt die Agentschicht in der Praxis nicht, sie ergänzt sie.
- **Selbst zu lösen (der eigentliche Preis):** (a) Turn-Taking/Endpointing — wann ist der
  Anrufer fertig?; (b) Barge-in-Abbruchketten — laufende LLM-/TTS-Streams canceln, verspätete
  Chunks verwerfen (AVA: „late LLM/TTS work is quarantined"); (c) Latenz-Engineering —
  LLM-Token an Satzgrenzen in Streaming-TTS überlappen, Filler/Ringback zur Überbrückung
  (AVA erreicht damit „sub-2s perceived"). Tools/Transkripte werden dagegen *einfacher*
  (natives LLM-Tool-Calling, Transkript fällt ohnehin an).
- **Pragmatischer Mittelweg:** **Flux als Standalone-STT** (→ 3) liefert
  `EndOfTurn`/`EagerEndOfTurn`/`TurnResumed` → das schwerste Teilproblem (Endpointing) ist
  ausgelagert, bleibt aber Kaskade; `EagerEndOfTurn` erlaubt spekulativen LLM-Start
  (Abbruch bei `TurnResumed`).
- **Strategischer Nutzen:** Voll-lokale Appliance möglich (Vosk/Whisper/Sherpa + Ollama +
  Piper/Kokoro wie bei AVA) → DSGVO-/On-Prem-Tier ohne Cloud; Kostenkontrolle pro Baustein;
  Unabhängigkeit von Deepgram-Ausfällen. Passt zum Single-Container-Appliance-Konzept —
  AVRs Microservice-Zoo (Docker-Compose je Provider) wäre dagegen ein Architekturbruch.
- **Aufwand:** ~1–2 Wochen bis produktionsreifes Turn-Taking/Barge-in — deutlich mehr als ein
  S2S-Adapter (→ 9). Reihenfolge: erst 4, dann als dritte Session-Implementierung.

## Produkt / Schnittstellen (Zukunft)

### Multi-Channel-Plattform: Telefonie + Web (WebRTC)
Größeres Bild für das Gesamtprodukt:
- **Deepgram Agent SDK** als Basis der Sprach-Pipeline.
- **Telefonie-Anbindung** (das, was diese Engine aktuell umsetzt: Asterisk/ARI + AudioSocket).
- **Web-Anbindung** voraussichtlich über **WebRTC** (Agent direkt auf einer Webseite).
- Die **Engine** (dieser Docker-Container) stellt **gesonderte Schnittstellen** bereit, über die
  sich „Agents" auch **auf Webseiten platzieren** lassen — mit **Animation** und **Steuerung**
  (z. B. ein einbettbares Widget, das gegen die Engine spricht). Telefonie und Web teilen sich
  Agent-Definitionen/Tools, aber unterschiedliche Transport-Frontends.

## Summary über den weitergeleiteten Gesprächsteil (Konzept)

**Idee des Nutzers:** Heute fasst die Post-Call-Summary nur den **Agent-Teil** des Gesprächs
zusammen (Live-Transkript aus `ConversationText`). Optional sollte sich auch der Teil
zusammenfassen lassen, der **nach der Weiterleitung** mit einem Menschen (oder einer anderen KI)
geführt wird — entweder ergänzend oder als zweite, getrennte Summary.

- **Befund:** Den weitergeleiteten Teil haben wir aktuell **nicht** als Transkript. Nach
  `transfer_call` ist der Agent stumm; Anrufer ↔ Ziel laufen über eine **neue** Bridge, ohne
  laufendes Deepgram-STT. Um ihn zusammenzufassen, muss dieser Teil **aufgenommen** und danach
  **batch-transkribiert** werden (Deepgram Pre-recorded + Diarization) — also exakt die
  **Passthrough-Maschinerie**. Deshalb sinnvoll **nach** dem Passthrough-Modul (wiederverwendbar).
- **Technischer Knackpunkt:** Die `bridge.record`-Aufnahme hängt an der **Agent-Bridge**. Nach
  dem Transfer wandert der Anrufer in eine andere Bridge → die laufende Aufnahme erfasst den
  weitergeleiteten Teil vermutlich **nicht** mehr. Zu verifizieren; ggf. **Transfer-Bridge
  separat aufnehmen**. Das ist der eigentliche Aufwand, nicht das Zusammenfassen.
- **Recht/DSGVO (größer als beim Agent-Teil):** Am anderen Ende sitzt ein **Mensch/fremde KI,
  oft extern**, dessen Nummer/Einwilligung wir nicht kontrollieren. Aufzeichnung + Transkription
  dieses Teils braucht eine sauberere Einwilligungslogik (z. B. Ansage vor dem Verbinden).
- **Konzept-Vorschlag:** per-Agent-Flag (z. B. `summary.includeTransferredSegment`) → Transfer-
  Bridge aufnehmen, nach Hangup batch-transkribieren, dann **kombinierte Summary** über
  *Agent-Transkript + weitergeleitetes Transkript* (optional zwei getrennte Summaries
  „KI-Teil" / „Beratungs-Teil").
- **Reihenfolge:** nach Passthrough-Modul; Einwilligungs-Logik vor Produktivbetrieb.

## Sizing / Lasttest (Schätzung, ungemessen)

**Frage des Nutzers:** Wie viele parallele Anrufe schafft ein All-in-One-Container (Asterisk +
Node-Engine + MongoDB + Admin-UI) auf z. B. einem 10-Kern-ARM-Server, bevor man horizontal
skalieren muss?

- **Kerneinsicht:** STT/LLM/TTS laufen **in der Cloud** (Deepgram/Requesty), **nicht** lokal.
  Der Container ist im Kern ein **Audio-Relay + Control-Plane** → **CPU ist selten der Engpass**.
  Pro Anruf: ~256 kbit/s Audio (slin 8 kHz, kein Transcoding), leichte Buffer-Kopien je 20-ms-
  Frame, ein Jitter-Timer, inkrementelle Mongo-`$push`-Writes, wenige MB RAM.
- **Realistische Engpässe (in dieser Reihenfolge):**
  1. **Deepgram-Concurrency & Kosten** — die eigentliche, kommerzielle Decke (nicht Hardware).
  2. **Node.js Single-Thread-Event-Loop** — Playout-Tick alle 20 ms je Anruf; bei 100 Anrufen
     ~5.000 Timer-Wakeups/s in *einem* Thread. Der erste spürbare Effekt unter Last ist
     **Playout-Jitter (Knacken/Verzögerung)**, nicht CPU-Sättigung. Gegenmittel: mehrere
     Node-Worker pro Container, bevor man horizontal skaliert.
  3. **SIP-Trunk-Kanäle** (extern, z. B. sipgate 2/10/50) — limitiert oft früher als die Engine.
- **Hausnummer (geschätzt, nicht gemessen):** ~**50–150** gleichzeitige Anrufe pro Container auf
  einem dedizierten 10-Kern-ARM; limitierend eher Node-Event-Loop + Deepgram-Limits als CPU/RAM.
- **Belastbar nur per Lasttest:** z. B. **SIPp** erzeugt N parallele Anrufe gegen den Container;
  dabei Event-Loop-Lag, Playout-Underruns und Deepgram-Fehlerquote messen. Erst dann sind
  Kundenzusagen seriös. (Bewusst (noch) nicht in der Doku.)

## Admin-UI (Erweiterungen, Zukunft)

> **Basis umgesetzt:** Node/Fastify **API-First** (JSON-Management-API + OpenAPI/Swagger,
> Auth via UI-Session **oder** Header `x-api-key`), Hybrids/GlassKit-SPA mit Login,
> **Agents-CRUD**, Anrufliste/Detail (Transkript, Summary, Transfer-Status, **Aufnahme-Player**
> via GridFS), PWA. Damit ist auch die früher separat geplante externe Management-API abgedeckt
> (die UI ist nur ein Client). Offen sind nur noch folgende Erweiterungen:

- **Trunk-/Telefonie-Anbindung — entschiedene Strategie (phasiert):**
  - **Phase 1 — umgesetzt:** **ENV-gesteuerter Einzel-Trunk** pro Appliance (`TRUNK_*` →
    [entrypoint](../docker/entrypoint.sh) generiert `pjsip_trunk.conf` via `#include`). Siehe
    [configuration.md → SIP-Trunk (Appliance)](configuration.md#sip-trunk-appliance). Deckt
    Single-Tenant-Deployments ab — **MonaHilft** sowie **Kunden-Self-Host/RZ**.
  - **Phase 2 — offen/später:** **Trunk-Verwaltung über die Admin-UI** — Trunks in der DB pflegen
    (Provider auswählen, SIP-ID/Passwort hinterlegen, aktivieren), daraus pjsip generieren +
    `pjsip reload` auslösen; **SIP-Credentials verschlüsselt** ablegen.
  - **Phase 3 — offen/später:** **Multi-Trunk** (mehrere Provider/Failover, Multi-Tenant). Nur nötig
    für **Failover / Multi-Provider / Multi-Tenant** — für den Standard-Einzelkunden nicht erforderlich.
    Das Datenmodell ist bereits N-Trunk-fähig gedacht.

## Bekannte offene Punkte (separat)

- **Passthrough-Diarization mit Zwei-Geräte-Setup verifizieren.** Der Passthrough-Pfad
  (Routing → Aufnahme → Batch-Transkription → Summary) ist end-to-end verifiziert, aber die
  **Sprecher-Trennung `caller`/`callee`** noch nicht: Im Test liefen beide Softphones auf
  **einem PC** (Headset-Echo) → Deepgram hört **eine** akustische Quelle und labelt alles als
  `caller`. Mit zwei getrennten Geräten (z. B. 101 vom Handy/zweiten Rechner) oder einem echten
  Trunk-Anruf erneut prüfen, dass die Diarization sauber auf zwei Sprecher aufteilt.
  (Der Live-sipgate-Trunk steht dafür inzwischen bereit — ein Passthrough-Agent auf eine echte DDI
  legen und gegenprüfen.)

- **Akustisches Echo** ohne Headset (Selbsthören): Capture-seitig (Headset/Softphone-AEC/echtes
  Telefon). Optional serverseitiges Halbduplex (schwächt Barge-in). Vom Nutzer vorerst zurückgestellt.
- **Leichtes Knacken** in der Ausgabe (selten): wahrscheinlich Playout-Grenzübergänge (Übergang
  Audio↔Stille bei Underrun/Ende). Jitter-Puffer erhöht (80 ms); falls es bleibt → kurze Fade-In/Out
  an den Frame-Grenzen.
- **end_call: Hangup-Nachlauf feinjustieren.** Aktuell wird datengetrieben aufgelegt (Puffer leer
  + >800 ms kein Audio mehr). Idee: nach dem Ende des Audio-Streams noch eine kleine, konfigurierbare
  Pause (~0,5–1 s) abwarten, bevor wirklich aufgelegt wird — wirkt natürlicher (kein „Schnitt" direkt
  nach dem letzten Wort). Wert experimentell testen (`HANGUP_GRACE_MS`).
- **GPT‑5 + integriertes LLM:** wir senden `temperature: 0.5`; GPT‑5-Modelle (managed) erlauben nur
  die Default-Temperatur → „Failed to think". Code-Fix: Temperatur bei GPT‑5 weglassen, dann läuft
  `gpt-5-mini` auch integriert. Aktuell läuft `think` über Requesty (`openai/gpt-4o-mini`).
- **Deepgram managed-Google/Gemini:** zeitweise 403 (Billing-Sperre in Deepgrams Google-Projekt) →
  nicht nutzbar bis Deepgram das behebt.
