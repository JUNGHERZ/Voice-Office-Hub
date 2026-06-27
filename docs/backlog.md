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
  3. **SIP-Trunk-Kanäle** (extern, z. B. SIPGate 2/10/50) — limitiert oft früher als die Engine.
- **Hausnummer (geschätzt, nicht gemessen):** ~**50–150** gleichzeitige Anrufe pro Container auf
  einem dedizierten 10-Kern-ARM; limitierend eher Node-Event-Loop + Deepgram-Limits als CPU/RAM.
- **Belastbar nur per Lasttest:** z. B. **SIPp** erzeugt N parallele Anrufe gegen den Container;
  dabei Event-Loop-Lag, Playout-Underruns und Deepgram-Fehlerquote messen. Erst dann sind
  Kundenzusagen seriös. (Bewusst (noch) nicht in der Doku.)

## Management-API (extern, neben der Admin-UI)

**Idee des Nutzers:** Zusätzlich zur Admin-UI eine **HTTP-API** anbieten, über die sich von außen
(ohne direkten DB-Zugriff) Ressourcen verwalten lassen:

- **Agents:** anlegen, listen, löschen, Parameter ändern (CRUD über die `agents`-Collection;
  dieselben Felder wie das Agent-Schema / die UI).
- **Requests:** abrufen (Liste + Detail inkl. Transkript/Summary/Transfer; Aufnahme-Download
  über GridFS-`gridFsId`), read-only.

- **Bewertung:** Sinnvoll als **API-First-Ansatz** — die Admin-UI wird dann nur ein Client dieser
  API. Auth über API-Key/Token (getrennt vom Admin-Passwort der UI). Liegt nahe, das **direkt mit
  der Admin-UI zusammen** zu bauen (gleicher Service), statt später nachzurüsten.
- **Reihenfolge:** zusammen mit / direkt nach der Admin-UI.

## Admin-UI (Erweiterungen, Zukunft)

Zusätzlich zu den geplanten Views (Anrufliste/Requests + Verlauf, Aufnahme abhören, Transkript
ansehen, **Agents verwalten**):
- **Trunk-/Telefonie-Anbindung konfigurierbar machen:** z. B. **SIPGate** auswählen, Zugangsdaten
  (SIP-ID/Passwort) hinterlegen und den **Trunk aktivieren** — also die heute statische
  `pjsip.conf`-Trunk-Vorlage über die UI verwalten (mehrere Trunks/Provider denkbar).

## Bekannte offene Punkte (separat)

- **Passthrough-Diarization mit Zwei-Geräte-Setup verifizieren.** Der Passthrough-Pfad
  (Routing → Aufnahme → Batch-Transkription → Summary) ist end-to-end verifiziert, aber die
  **Sprecher-Trennung `caller`/`callee`** noch nicht: Im Test liefen beide Softphones auf
  **einem PC** (Headset-Echo) → Deepgram hört **eine** akustische Quelle und labelt alles als
  `caller`. Mit zwei getrennten Geräten (z. B. 101 vom Handy/zweiten Rechner) oder einem echten
  Trunk-Anruf erneut prüfen, dass die Diarization sauber auf zwei Sprecher aufteilt.

- **Akustisches Echo** ohne Headset (Selbsthören): Capture-seitig (Headset/Softphone-AEC/echtes
  Telefon). Optional serverseitiges Halbduplex (schwächt Barge-in). Vom Nutzer vorerst zurückgestellt.
- **Aufnahme (ARI `bridge.record`) liefert 500** „Internal Server Error" — best-effort, blockiert
  nichts; gehört zu Plan-Phase „Aufnahme (KI-Modus)".
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
