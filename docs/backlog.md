# Backlog & Ideen (noch nicht umgesetzt)

Gesammelte Ideen/Erkenntnisse aus den Testgesprächen. Reihenfolge = grobe Priorität, nicht final.

## Audio / Conversation Experience

### 1. Hintergrundgeräusche (Ambience) optional pro Agent
**✅ Umgesetzt in 0.6.8.** `agent.ambience { enabled, preset, volume }`; der AudioSocket-Playout-Takt läuft bei aktiver Ambience durchgehend und mischt einen Loop in jedes Frame (Sprechpausen = reine Atmosphäre statt Stille; `pendingMs()`/Barge-in-Semantik unverändert). Presets `office`/`room`/`rain` werden **prozedural generiert** (lizenzfrei per Konstruktion, keine Binär-Assets, sampleRate-neutral); eigene Loops via `AMBIENCE_DIR` (`<preset>.raw`). Pausiert bei Mensch-Übernahme; nur AudioSocket-Transport; Teil der Aufnahme. **Ausbaustufe:** eigene Uploads pro Agent (GridFS) + weitere kuratierte Presets.

### 2. Background Speech Denoising (Umgebungsgeräusche aus dem Anrufer-Audio filtern)
**Frage des Nutzers:** VAPI bietet das (siehe https://docs.vapi.ai/documentation/assistants/conversation-behavior/background-speech-denoising). Wie bei uns?
- **Befund:** **Deepgram hat KEINE eingebaute Rauschunterdrückung** in den Voice-Agent-Settings. Deepgram empfiehlt dafür ausdrücklich einen externen Denoiser (Krisp). VAPI/LiveKit binden genau das ein (Krisp bzw. ai-coustics).
- **Optionen für uns:**
  1. Auf die inhärente Robustheit von nova-3 vertrauen (echte Telefonate sind bandbegrenzt; Mobil-/ Festnetz-Hardware entrauscht bereits etwas).
  2. Eigenen Denoiser in die Eingangs-Pipeline (Anrufer→Deepgram) setzen: **RNNoise** (frei) oder **Krisp SDK** (kommerziell) vor dem `sendAudio` an Deepgram.
  3. Hinweis Deepgram („Noise-Reduction-Paradox"): zu starke Entrauschung kann die STT-Genauigkeit senken — konservativ einstellen.
- **Aufwand:** RNNoise-Integration ~1–2 Tage; Krisp je nach Lizenz mehr.

### 2b. Kontextuelle Stille-Nachfrage (LLM statt fester Phrasen)
**Nutzer-Wunsch (2026-07-26): „definitiv in einer späteren Version".** Ergänzung zum in 0.6.27 gebauten Stille-Reengagement (`agent.idlePrompts`, fester Phrasen-Pool je Eskalationsstufe).

- **Idee:** Statt einer hinterlegten Zeile bekommt das Modell bei Stille einen System-Nudge („Der Anrufer schweigt seit 8 s — frag kurz nach") und formuliert die Nachfrage selbst, bezogen auf die zuletzt gestellte Frage: „Ich hatte gefragt, ob Dienstag passt — passt der?" Deutlich natürlicher als eine generische Ansage.
- **Kosten der Natürlichkeit:** LLM-Latenz genau im ungünstigsten Moment (die Stille wird erst noch länger), Kosten pro Vorfall, nicht vorab übersetzbar (der Pool geht heute gratis durch den Lokalisierungs-One-Shot mit) und unvorhersagbar — ein Betreiber kann nicht mehr garantieren, was der Agent sagt.
- **Umsetzung:** additiv als `idlePrompts.mode: "phrases" | "llm"` neben dem Pool; der `IdleWatcher` ([src/ari/idleWatcher.ts](../src/ari/idleWatcher.ts)) bliebe unverändert, nur der `speak`-Hook im callHandler würde im LLM-Modus statt `injectMessage` einen Turn anstoßen. Sinnvoll erst mit Messwerten aus `metrics.idlePrompts` (wie oft greift das überhaupt?).

### 2c. Nicht-übersetzen-Liste (Eigennamen, Produktbegriffe)
Ergänzung zur Vorübersetzung aus 0.7.0 ([translationStore.ts](../src/llm/translationStore.ts)).

- **Problem:** „Rufen Sie unsere Apfel-Hotline an" — Produkt-, Firmen- und Eigennamen sollen in jeder Zielsprache stehen bleiben. Der Übersetzungs-Prompt weist das heute allgemein an („Eigennamen bleiben unverändert"), kennt aber die konkreten Begriffe nicht.
- **Idee:** Feld `doNotTranslate: string[]` am Agenten, das in jeden Übersetzungs-Prompt geht. Wirkt für **alle** Sprachen gleichzeitig — im Gegensatz zu einer Handkorrektur pro Sprache.
- **Bewusst statt eines Editors:** Ein editierbares Übersetzungsfeld pro Sprache wurde 0.7.0 verworfen. Wer eine Übersetzung korrigiert, korrigiert meist ein Symptom (die Ursache liegt im Original oder im Prompt), und wer im Admin sitzt, spricht selten alle Zielsprachen. Dazu käme ein dauerhafter Sonderfall im Lebenszyklus (handkorrigierte Einträge vor der Regeneration schützen), der bei jeder Änderung mitgedacht werden müsste.
- **Aufwand:** klein — ein Agent-Feld, eine Prompt-Zeile, ein Formularfeld.

### 2d. Sprachspezifische Stimme
Der Tauschpunkt existiert seit 0.7.0 bereits: Der Sprach-Prior greift **vor** dem Session-Aufbau, im callHandler wird dort schon `agent.greeting` ersetzt.

- **Idee:** Im selben Schritt `speak.voice`/`speak.model` je Zielsprache wählen. Weil die Wahl vor der ersten Silbe fällt, ist der Wechsel unhörbar — anders als eine Umschaltung mitten im Gespräch, die irritieren würde.
- **Warum es fehlt:** Eine einsprachige Stimme (z. B. `aura-2-aurelia-de`) spricht korrektes Englisch mit deutschem Akzent. Solange das so konfiguriert ist, klingt eine fremdsprachige Begrüßung schlechter, als sie formuliert ist.
- **Aufwand:** klein (Feld `speak.byLanguage`), sobald geklärt ist, ob pro Sprache eine Voice-ID gepflegt oder aus einer Matrix abgeleitet wird.

### 2e. Ambience-Ducking während der Agentensprache
**Befund aus der Anrufanalyse vom 18.08.2026.** `AmbienceMixer.mix()` addiert den Loop mit konstantem Gain auf jedes Frame — auch auf die Sprachframes. Bei `volume: 0.25` liegt das Bett bei **−38,9 dBFS RMS**, praktisch auf dem Pegel des Median-Sprachsignals; der Boden in Sprechpausen bei **−48,4 dBFS**. Zum Vergleich: das Komfortrauschen ohne Ambience liegt bei −73 dBFS, also 25 dB darunter.

- **Symptom:** Der Anrufer beschreibt „Rauschen und Klacken" und hält es für einen Fehler der TTS-Strecke. Gemessen ist es die Ambience selbst — das Raumbett plus die Tipp-Schübe des `office`-Presets (einer alle 4,0 s, je 3–4 Anschläge im Abstand von 180 ms, exakt wie entworfen). Auf einer Freisprecheinrichtung hebt die automatische Verstärkungsregelung das Bett in Sprechpausen zusätzlich an.
- **Warum Ducking und nicht einfach leiser:** Ein niedrigerer `volume` löst beides zugleich — aber die Ambience soll in Pausen ja hörbar sein, sonst trägt sie nichts bei. Genau dafür ist Ducking da: unter der Sprache absenken (typisch −12 bis −18 dB, Attack ~20 ms, Release ~300 ms), in Pausen auf vollen Pegel. Der eingestellte `volume` bliebe dann der Pausenpegel und wäre bei 0.25 unproblematisch.
- **Ansatz:** `MediaSession.tick()` weiß bereits, ob gerade ein TTS-Frame läuft (`frame` vs. `null`) — das ist das Steuersignal, ohne neue Verkabelung. Die Hüllkurve gehört in den `AmbienceMixer` (Zustand über Frames hinweg, wie der Loop-Offset), damit `tick()` schlank bleibt. Attack/Release müssen über Frame-Grenzen laufen, sonst klickt die Absenkung selbst.
- **Aufwand:** klein bis mittel — eine Hüllkurve in `AmbienceMixer`, ein Parameter in `agent.ambience` (z. B. `duckDb`, Default an), Tests analog `test/ambience.test.ts`.
- **Sofortmaßnahme bis dahin:** `volume` auf 0.10–0.12, oder Preset `room` (gleiches Bett ohne Tippen).

## STT / Modelle

### 3. Flux als listen-Modell evaluieren (Turn-Detection)
**Frage des Nutzers:** Lohnt sich Flux jetzt schon?
- **Klarstellung:** Wir nutzen für STT aktuell **nova-3** (nicht „Aura 3"). Aura‑2 ist die TTS‑Stimme.
- **Flux:** Deepgrams neues STT-Modell speziell für Voice Agents, mit **modell-integrierter End-of-Turn-Erkennung** (`StartOfTurn`, `EagerEndOfTurn`, `TurnResumed`, `EndOfTurn`), „Nova‑3-Level-Genauigkeit", geringere Turn-Latenz/weniger Talk-over. Modelle: `flux-general-en`, `flux-general-multi` (mehrsprachig). Parameter: `eot_threshold`, `eager_eot_threshold`, `eot_timeout_ms` — sind in unserem Code/Resolver bereits vorgesehen.
- **Bewertung:** Verbessert vor allem das Turn-Taking-Gefühl (Stille→Antwort, Barge-in). Integration ist bei uns gering-invasiv (nur listen-Modell + eot-Parameter; der `language_hints`-Zweig ist schon Flux-spezifisch). **Offen:** Reifegrad/Qualität für **Deutsch** über `flux-general-multi` (in der Doc nicht explizit bestätigt).
- **Empfehlung:** **Erst die funktionalen Stufen (Persistenz, Tools/Transfer, Summary) finalisieren**, dann Flux als gezielten A/B-Test gegen nova-3 — sofern sich Turn-Taking als Schwachpunkt zeigt. Aktuell antwortet der Agent zuverlässig, also kein Blocker. (Eigene `.env`-Schalter `LISTEN_MODEL`
  + eot-Werte machen den A/B-Test billig.)
- **Status 2026-07-20 (0.6.0): weitgehend beantwortet.** Flux ist pro Agent über die Admin-UI schaltbar (STT-Modell-Select + eot-Felder); Settings-Format an die aktuelle v2-Spec angepasst (Fix `eed7cac` — Flux verlangt `version: "v2"`, lehnt `language`/`smart_format` ab). **Deutsch über `flux-general-multi` funktioniert** — vom Nutzer im Live-Test bestätigt (Agent 121), inkl. sauberer Mehrsprachigkeit. Gemessene Antwortlatenz lokal: Flux ≈ 2,6 s vs. nova-3 ≈ 3,5 s ab Sprechende. **Offen nur noch:** Qualitäts-/Langzeitvergleich am echten Trunk (A/B pro DDI). Achtung fürs Testen: loopendes Einspiel-Audio cancelt Flux-Antworten (Barge-in) — Test-Audio mit einer Äußerung + Stille verwenden.

### 3a. Erkannte Gesprächssprache an die STT zurückgeben

**Beobachtet am 26.08.2026 (Anruf `1787759851.0`, `flux-general-multi` mit `language_hints: ["de"]`):** 6 von 14 Anrufer-Beiträgen kamen als reines Englisch zurück, ein weiterer gemischt — und ausschliesslich bei **kurzen** Äusserungen. Lange deutsche Sätze wurden sauber erkannt, kurze wurden zu `"Yep. Yep."`, `"Nine nine is my discounts."`, `"You all good customer?"`, `"because..."`.

Der Schaden ist nicht kosmetisch. Auf `"You all good customer?"` antwortete der Agent mit *„Ja, mir geht's gut"* — die Fehlerkennung hat den Gesprächsverlauf umgelenkt. Sie verfälscht ausserdem die Gesprächsführung des Duplex-Pfads: `"Yep. Yep."` trägt ein Satzendzeichen und gilt damit als vollständiger Beitrag, obwohl der Anrufer „Ja, ja" gesagt hat.

**Idee:** Sobald im Gespräch feststeht, dass Deutsch gesprochen wird, die Spracherkennung darauf festlegen, statt weiter mehrsprachig zu raten. Die Erkennung dafür existiert bereits: `detectContentLanguage()` in `src/llm/languageScorer.ts`, gefüttert über `localizer.observeTurn()` aus dem `conversationText`-Ereignis (`callHandler.ts`). Es fehlt nur der Rückweg zur STT.

**Vor der Umsetzung zu klären:**
- Gibt es ein einsprachiges Flux-Modell für Deutsch (analog `flux-general-en`)? Falls nein: Reicht es, `language_hints` zur Laufzeit zu verschärfen?
- Der Modellwechsel bedeutet einen Neuaufbau der Flux-Verbindung. Wie lange ist der Anrufer dabei taub, und lässt sich das in eine Agentensprechphase legen?
- Ab wann gilt die Sprache als sicher? Zwei lange Turns dürften reichen; genau die kurzen, unsicheren Beiträge sollen ja gerade nicht mitentscheiden.
- Rückfallweg für echte Sprachwechsel mitten im Gespräch — die Anlage kann heute bewusst umschalten (Laufzeit-Übersetzung der Ansagen), und das darf eine Festlegung nicht zunichtemachen.

**Nutzen:** Vermutlich grösser als jede weitere Feinjustierung am Duplex-Pfad. Eine falsch erkannte Äusserung kostet einen ganzen Gesprächszug; ein zu früh beantworteter Satzfetzen kostet eine Wiederholung.

## Architektur / Engine-Weiterentwicklung (Architektur-Review 2026-07-18)

### 4. ✅ Umgesetzt in 0.6.0 (2026-07-20): Voice-Provider-Abstraktion (`VoiceAgentSession`)
Interface + Factory in `src/voice/`, Deepgram als erster Adapter (`start()` statt Konstruktor-Connect), Agent-Feld `voiceProvider` end-to-end (Schema/Resolver/Formular), DI-Naht `CallHandlerDeps` + transportneutraler `CallMedia`-Kontrakt (WebRTC-Andockpunkt). Details: [architecture.md → „Zwei Nähte"](architecture.md) + CHANGELOG 0.6.0.

### 5. ✅ Umgesetzt in 0.6.1/0.6.2 (2026-07-20): Externe Tool-Endpoints pro Agent
`agent.customTools[]` (Schema-validiert) + per-Call-Toolset (`src/tools/toolset.ts`): POST-Envelope/GET-Query, `${ENV:NAME}`-Secrets (bleiben in der Server-Umgebung, nicht in der DB), hartes Timeout, Fehler → sprechbares `{error}`-Ergebnis + `status:"error"` im Log (Call hängt nie). Editor im Agent-Formular (0.6.2), Kontrakt in `docs/tools.md`. Offen (Phase 2): verschlüsselter Secret-Store zusammen mit Trunk-Credentials.

### 6. Audio-Pipeline auf 16 kHz (`slin16`) umstellen — BLOCKIERT durch Asterisk-AudioSocket
**Stand 2026-07-23 (0.6.24/0.6.25):** Engine-Seite ist FERTIG — die komplette Kette (Framing, Flux, Aura, ElevenLabs `pcm_16000`, Deepgram-VA, Ambience, Rampen/DC-Blocker, `wav16`-Aufnahmen) leitet sich aus `AUDIO_SAMPLE_RATE` ab; Tests gegen lokale `.env` abgeschirmt. **Blocker:** Der AudioSocket-Treiber von Asterisk ≤ 22.6 (Appliance: 20.6) überträgt IMMER slin@8k — `format=slin16` setzt nur NativeFormats, 16-kHz-Audio läuft halb so schnell („Murmelstimmen", live erlebt). Boot-Guard warnt seit 0.6.25.
- **Weg A (empfohlener Spike, 1–2 h):** RTP-Transport — `chan_rtp` kann `slin16` schon in 20.6. Danach Playout-Engine (Takt/Rampen/DC/Noise/pendingMs/Ambience) zwischen AudioSocket- und RTP-Pfad teilen (~1 Tag). Risiko zu prüfen: Opus↔slin16-Transcode im Widget (Community-Berichte über Probleme in anderer Konstellation).
- **Weg B:** Asterisk ≥ 22.7 selbst bauen (Multi-Format-AudioSocket, Message-Typen 0x11–0x18 → auch unser Server braucht die neuen Typen). Falle: Opus-Codec ist im Vanilla-Source NICHT enthalten (Ubuntu patcht `codec_opus_open_source` ein) — ohne Opus-Patch wäre das Widget auf G.711/8k gezwungen und der 16k-Gewinn dahin. 1–2 Tage.
- **Weg C (passiv):** Distro abwarten — Ubuntu 25.10/26.04 liefern erst 22.5.2, keine planbare Option.
- **Nutzen unverändert:** primär Web-Widget (Breitband Ende-zu-Ende); Trunk bleibt 8 kHz.

### 7. ✅ Umgesetzt in 0.6.3/0.6.4 (2026-07-20): Live-Call-Ansicht + Latenz-Metriken (v1)
Tab „Live" (laufende Anrufe, tickende Dauer, 3-s-Polling; Partial-Index auf `in_progress`), Anruf-Detail lädt bei laufendem Anruf alle 2 s still nach (Live-Transkript). Metriken pro Anruf in `requests.metrics`: `timeToFirstAudioMs` (Answer→Begrüßungs-Audio), `bargeIns` (nur bei hörbarem Agent gezählt), `toolCalls`/`toolErrors`, Provider/STT-Modell — als Badges im Detail.
- **Ausbaustufe (offen):** Standalone-Mongo → Single-Node-Replica-Set, dann Change Streams → SSE statt Polling (EventSource mit Cookie-Auth funktioniert Same-Origin); zusätzliche Messpunkte Playout-Underruns + Provider-Fehler/Reconnects; Metriken-Aggregation (Durchschnitt pro Agent) im Dashboard.

### 8. ✅ Umgesetzt in 0.6.0 (2026-07-20): Call-Lifecycle-Tests gegen FakeSession
14 Fälle in `test/callLifecycle.test.ts` (Dedup/Doppel-INVITE, Unknown-DDI-Reject, Audio-Bridging, Barge-in, Transkript-Reihenfolge, FunctionCall-Korrelation, `end_call`-Drain mit Mock-Timern, Transfer connected/failed/Klingelphase, Cleanup-Idempotenz, Fehlerpfade)
+ WS-Loopback-Test des Deepgram-Adapters; Fakes in `test/helpers/`.

### 9. ElevenLabs Conversational AI als zweites Voice-Backend (Voraussetzung 4 ✅; + 6 oder µ-law)
**Idee:** ElevenLabs-Agents-Plattform als alternatives Komplett-Backend (STT + Turn-Taking + LLM + TTS) neben Deepgram — nicht zu verwechseln mit `speak.provider: eleven_labs` (nur TTS-Stimme innerhalb der Deepgram-Pipeline, heute schon möglich).
- **Umsetzung:** `src/elevenlabs/agentSession.ts` als zweiter Adapter (`wss://api.elevenlabs.io/v1/convai/conversation`): Audio als base64-JSON statt binär, Mapping `interruption`→Barge-in, `client_tool_call`→`dispatchTool`, `conversation_initiation_client_data` statt `Settings`. Audio: `ulaw_8000` oder `pcm_16000` (→ 6). Design-Entscheidung: ElevenLabs-Agents per API provisionieren (`agent_id` am Mongo-Agent speichern) vs. generischer Agent mit per-Call-Overrides (passt besser zum DB-zentrierten Modell, hat aber Override-Einschränkungen).
- **Aufwand:** ~2–4 Tage inkl. Telefontests.

### 10. Kaskaden-Modus „NativeSession": STT + LLM + TTS direkt, ohne Voice-Agent-Layer (Voraussetzung 4 ✅)
**✅ Umgesetzt in 0.6.10** — exakt entlang des unten skizzierten Mittelwegs: Flux-Standalone-STT (EndOfTurn/EagerEndOfTurn), Requesty-SSE-LLM mit Tool-Calling, Streaming-TTS-Matrix (Aura-2 oder ElevenLabs), Satz-Overlap, Generationszähler-Quarantäne („late work is quarantined"), einmaliger STT-Reconnect. Erster Live-Test 2026-07-21: gefühlt schneller als der Deepgram-Agent, Barge-in sauber; gemessene Turn-Latenz ~2,5–2,8 s (davon ~2,2–2,4 s LLM-First-Token → Tuning-Hebel: schnelleres think-Modell, später EagerEndOfTurn-Spekulation — Flag `NATIVE_EAGER_EOT` existiert). **Ausbaustufen:** voll-lokale Bausteine (Whisper/Ollama/Piper) für das On-Prem-Tier, Filler-Sätze, 16-kHz-Pfad (→ 6). **Frage des Nutzers (2026-07-19):** Geht es auch ganz ohne externe Agentschicht — nur STT, LLM, TTS — wie [AVA](https://github.com/hkjarral/AVA-AI-Voice-Agent-for-Asterisk) und [Agent Voice Response](https://github.com/agentvoiceresponse)?
- **Befund:** Ja — in unserer Architektur ist das schlicht ein weiterer `VoiceAgentSession`-Adapter (`CascadeSession`), der intern Streaming-STT → LLM (Requesty, vorhanden) → Streaming-TTS verkettet; `callHandler`/`MediaSession` bleiben unberührt. Beide Referenzprojekte belegen die Machbarkeit. Bemerkenswert: **beide** bieten neben der Kaskade weiterhin integrierte Agent-Provider an (OpenAI Realtime, Deepgram VA, Gemini Live, ElevenLabs) — die Kaskade ersetzt die Agentschicht in der Praxis nicht, sie ergänzt sie.
- **Selbst zu lösen (der eigentliche Preis):** (a) Turn-Taking/Endpointing — wann ist der Anrufer fertig?; (b) Barge-in-Abbruchketten — laufende LLM-/TTS-Streams canceln, verspätete Chunks verwerfen (AVA: „late LLM/TTS work is quarantined"); (c) Latenz-Engineering — LLM-Token an Satzgrenzen in Streaming-TTS überlappen, Filler/Ringback zur Überbrückung (AVA erreicht damit „sub-2s perceived"). Tools/Transkripte werden dagegen *einfacher* (natives LLM-Tool-Calling, Transkript fällt ohnehin an).
- **Pragmatischer Mittelweg:** **Flux als Standalone-STT** (→ 3) liefert `EndOfTurn`/`EagerEndOfTurn`/`TurnResumed` → das schwerste Teilproblem (Endpointing) ist ausgelagert, bleibt aber Kaskade; `EagerEndOfTurn` erlaubt spekulativen LLM-Start (Abbruch bei `TurnResumed`).
- **Strategischer Nutzen:** Voll-lokale Appliance möglich (Vosk/Whisper/Sherpa + Ollama + Piper/Kokoro wie bei AVA) → DSGVO-/On-Prem-Tier ohne Cloud; Kostenkontrolle pro Baustein; Unabhängigkeit von Deepgram-Ausfällen. Passt zum Single-Container-Appliance-Konzept — AVRs Microservice-Zoo (Docker-Compose je Provider) wäre dagegen ein Architekturbruch.
- **Aufwand:** ~1–2 Wochen bis produktionsreifes Turn-Taking/Barge-in — deutlich mehr als ein S2S-Adapter (→ 9). Reihenfolge: erst 4, dann als dritte Session-Implementierung.

## Produkt / Schnittstellen (Zukunft)

### Multi-Channel-Plattform: Telefonie + Web (WebRTC)
**✅ V1 umgesetzt in 0.6.9** — einbettbares Web-Widget über Route (a): Browser-Softphone (sip.js) per SIP-over-WebSocket an Asterisk (`transport-ws`, Context `[webrtc-inbound]`, Pseudo-DDI), dahinter der unveränderte Stasis/Engine-Pfad. Pegelgesteuerte Sprech-Animation (AnalyserNode-Orb) + optionales Live-Transkript (token-gebunden). Telefonie und Web teilen sich Agent-Definitionen/Tools/Auswertung — genau wie hier skizziert. Doku: docs/webrtc.md. **Ausbaustufen:** TURN-Server (Besucher hinter symmetrischem NAT), ephemere SIP-Credentials, Engine-seitiges Admission-Control pro Agent; **Widget-Optik/Theming** (minimalistischere Varianten, Farben/Branding pro Agent — Nutzer-Wunsch vom ersten Test 2026-07-21); Route (b) (nativer Media-Ingress als dritte `CallMedia`-Implementierung, ohne Asterisk) bleibt als Latenz-Optimierung offen.

## Summary über den weitergeleiteten Gesprächsteil (Konzept)

**Idee des Nutzers:** Heute fasst die Post-Call-Summary nur den **Agent-Teil** des Gesprächs zusammen (Live-Transkript aus `ConversationText`). Optional sollte sich auch der Teil zusammenfassen lassen, der **nach der Weiterleitung** mit einem Menschen (oder einer anderen KI) geführt wird — entweder ergänzend oder als zweite, getrennte Summary.

- **Befund:** Den weitergeleiteten Teil haben wir aktuell **nicht** als Transkript. Nach `transfer_call` ist der Agent stumm; Anrufer ↔ Ziel laufen über eine **neue** Bridge, ohne laufendes Deepgram-STT. Um ihn zusammenzufassen, muss dieser Teil **aufgenommen** und danach **batch-transkribiert** werden (Deepgram Pre-recorded + Diarization) — also exakt die **Passthrough-Maschinerie**. Deshalb sinnvoll **nach** dem Passthrough-Modul (wiederverwendbar).
- **Technischer Knackpunkt:** Die `bridge.record`-Aufnahme hängt an der **Agent-Bridge**. Nach dem Transfer wandert der Anrufer in eine andere Bridge → die laufende Aufnahme erfasst den weitergeleiteten Teil vermutlich **nicht** mehr. Zu verifizieren; ggf. **Transfer-Bridge separat aufnehmen**. Das ist der eigentliche Aufwand, nicht das Zusammenfassen.
- **Recht/DSGVO (größer als beim Agent-Teil):** Am anderen Ende sitzt ein **Mensch/fremde KI, oft extern**, dessen Nummer/Einwilligung wir nicht kontrollieren. Aufzeichnung + Transkription dieses Teils braucht eine sauberere Einwilligungslogik (z. B. Ansage vor dem Verbinden).
- **Konzept-Vorschlag:** per-Agent-Flag (z. B. `summary.includeTransferredSegment`) → Transfer-Bridge aufnehmen, nach Hangup batch-transkribieren, dann **kombinierte Summary** über *Agent-Transkript + weitergeleitetes Transkript* (optional zwei getrennte Summaries „KI-Teil" / „Beratungs-Teil").
- **Reihenfolge:** nach Passthrough-Modul; Einwilligungs-Logik vor Produktivbetrieb.

## Sizing / Lasttest (Schätzung, ungemessen)

**Frage des Nutzers:** Wie viele parallele Anrufe schafft ein All-in-One-Container (Asterisk + Node-Engine + MongoDB + Admin-UI) auf z. B. einem 10-Kern-ARM-Server, bevor man horizontal skalieren muss?

- **Kerneinsicht:** STT/LLM/TTS laufen **in der Cloud** (Deepgram/Requesty), **nicht** lokal. Der Container ist im Kern ein **Audio-Relay + Control-Plane** → **CPU ist selten der Engpass**. Pro Anruf: ~256 kbit/s Audio (slin 8 kHz, kein Transcoding), leichte Buffer-Kopien je 20-ms-Frame, ein Jitter-Timer, inkrementelle Mongo-`$push`-Writes, wenige MB RAM.
- **Realistische Engpässe (in dieser Reihenfolge):**
  1. **Deepgram-Concurrency & Kosten** — die eigentliche, kommerzielle Decke (nicht Hardware).
  2. **Node.js Single-Thread-Event-Loop** — Playout-Tick alle 20 ms je Anruf; bei 100 Anrufen ~5.000 Timer-Wakeups/s in *einem* Thread. Der erste spürbare Effekt unter Last ist **Playout-Jitter (Knacken/Verzögerung)**, nicht CPU-Sättigung. Gegenmittel: mehrere Node-Worker pro Container, bevor man horizontal skaliert.
  3. **SIP-Trunk-Kanäle** (extern, z. B. sipgate 2/10/50) — limitiert oft früher als die Engine.
- **Hausnummer (geschätzt, nicht gemessen):** ~**50–150** gleichzeitige Anrufe pro Container auf einem dedizierten 10-Kern-ARM; limitierend eher Node-Event-Loop + Deepgram-Limits als CPU/RAM.
- **Belastbar nur per Lasttest:** z. B. **SIPp** erzeugt N parallele Anrufe gegen den Container; dabei Event-Loop-Lag, Playout-Underruns und Deepgram-Fehlerquote messen. Erst dann sind Kundenzusagen seriös. (Bewusst (noch) nicht in der Doku.)

## Admin-UI (Erweiterungen, Zukunft)

> **Basis umgesetzt:** Node/Fastify **API-First** (JSON-Management-API + OpenAPI/Swagger, Auth via UI-Session **oder** Header `x-api-key`), Hybrids/GlassKit-SPA mit Login, **Agents-CRUD**, Anrufliste/Detail (Transkript, Summary, Transfer-Status, **Aufnahme-Player** via GridFS), PWA. Damit ist auch die früher separat geplante externe Management-API abgedeckt (die UI ist nur ein Client). Offen sind nur noch folgende Erweiterungen:

- **Trunk-/Telefonie-Anbindung — entschiedene Strategie (phasiert):**
  - **Phase 1 — umgesetzt:** **ENV-gesteuerter Einzel-Trunk** pro Appliance (`TRUNK_*` → [entrypoint](../docker/entrypoint.sh) generiert `pjsip_trunk.conf` via `#include`). Siehe [configuration.md → SIP-Trunk (Appliance)](configuration.md#sip-trunk-appliance). Deckt Single-Tenant-Deployments ab — **MonaHilft** sowie **Kunden-Self-Host/RZ**.
  - **Phase 2 — offen/später:** **Trunk-Verwaltung über die Admin-UI** — Trunks in der DB pflegen (Provider auswählen, SIP-ID/Passwort hinterlegen, aktivieren), daraus pjsip generieren + `pjsip reload` auslösen; **SIP-Credentials verschlüsselt** ablegen.
  - **Phase 3 — offen/später:** **Multi-Trunk** (mehrere Provider/Failover, Multi-Tenant). Nur nötig für **Failover / Multi-Provider / Multi-Tenant** — für den Standard-Einzelkunden nicht erforderlich. Das Datenmodell ist bereits N-Trunk-fähig gedacht.

## Bekannte offene Punkte (separat)

- **Passthrough-Diarization mit Zwei-Geräte-Setup verifizieren.** Der Passthrough-Pfad (Routing → Aufnahme → Batch-Transkription → Summary) ist end-to-end verifiziert, aber die **Sprecher-Trennung `caller`/`callee`** noch nicht: Im Test liefen beide Softphones auf **einem PC** (Headset-Echo) → Deepgram hört **eine** akustische Quelle und labelt alles als `caller`. Mit zwei getrennten Geräten (z. B. 101 vom Handy/zweiten Rechner) oder einem echten Trunk-Anruf erneut prüfen, dass die Diarization sauber auf zwei Sprecher aufteilt. (Der Live-sipgate-Trunk steht dafür inzwischen bereit — ein Passthrough-Agent auf eine echte DDI legen und gegenprüfen.)

- **Akustisches Echo** ohne Headset (Selbsthören): Capture-seitig (Headset/Softphone-AEC/echtes Telefon). Optional serverseitiges Halbduplex (schwächt Barge-in). Vom Nutzer vorerst zurückgestellt.
- **Leichtes Knacken** in der Ausgabe (selten): wahrscheinlich Playout-Grenzübergänge (Übergang Audio↔Stille bei Underrun/Ende). Jitter-Puffer erhöht (80 ms); falls es bleibt → kurze Fade-In/Out an den Frame-Grenzen.
- **end_call: Hangup-Nachlauf feinjustieren.** Aktuell wird datengetrieben aufgelegt (Puffer leer
  + >800 ms kein Audio mehr). Idee: nach dem Ende des Audio-Streams noch eine kleine, konfigurierbare Pause (~0,5–1 s) abwarten, bevor wirklich aufgelegt wird — wirkt natürlicher (kein „Schnitt" direkt nach dem letzten Wort). Wert experimentell testen (`HANGUP_GRACE_MS`).
- **GPT‑5 + integriertes LLM:** wir senden `temperature: 0.5`; GPT‑5-Modelle (managed) erlauben nur die Default-Temperatur → „Failed to think". Code-Fix: Temperatur bei GPT‑5 weglassen, dann läuft `gpt-5-mini` auch integriert. Aktuell läuft `think` über Requesty (`openai/gpt-4o-mini`).
- **Deepgram managed-Google/Gemini:** zeitweise 403 (Billing-Sperre in Deepgrams Google-Projekt) → nicht nutzbar bis Deepgram das behebt.
- **GlassKit `glk-select`: Optionen wurden nur einmal übernommen** — *erledigt in glasskit-elements 1.12.0.* `_moveOptions()` lief in einem einmaligen `requestAnimationFrame`; spätere Änderungen der `<option>`-Kinder erreichten das innere `<select>` nie. Betraf jeden Select mit dynamischer Liste — bei uns Provider, Modelle und Stimmen im TTS-Panel. GlassKit hat es generisch in `base.js` gelöst (MutationObserver → `projectLightDom()`, plus Wertwiederherstellung und öffentliches `refresh()`); damit sind auch `glk-tab-item` und `glk-modal` mit erledigt. Unser Workaround `syncSelectOptions()` ist entfernt, `package.json` verlangt jetzt `^1.12.0`.
