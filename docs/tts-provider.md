# TTS-Provider: Auswahl, Kosten und DSGVO-Einstufung

Welche Stimme ein Agent spricht, entscheidet `speak.provider` — einstellbar im
Agenten-Panel. Dieses Dokument beschreibt die verfügbaren Engines, ihre Kosten,
ihre datenschutzrechtliche Einstufung und wie man bestehende Stimmen migriert.

Die maßgebliche Quelle im Code ist das Manifest **`src/tts/catalog.ts`**. Daraus
speisen sich das Mongoose-Enum, die Auswahlfelder im Panel, die DSGVO-Badges und
die Tabellen unten. Wer einen Provider ergänzt, ergänzt ihn dort.

---

## Überblick

| Provider | Pfad | Transport | Sprachen | Preis / 1000 Zeichen | Gemessene TTFA | Verarbeitung |
|---|---|---|---|---|---|---|
| **Deepgram Aura** | native + Voice-Agent | WebSocket `/v1/speak` | en, de u. a. | $0,030 | **218 ms** | 🟢 EU-Endpoint möglich |
| **Mistral Voxtral** | nur native | HTTP + SSE `/v1/audio/speech` | 9 inkl. Deutsch (Stimme siehe unten) | **$0,016** | **400 ms** | 🟢 **EU** |
| **Deepgram Flux TTS** | native + Voice-Agent | WebSocket `/v2/speak` | **nur Englisch** (7 Stimmen) | $0,045 (bis 12.09.2026 frei) | **159 ms** (EU-Endpoint 113 ms) | 🟢 EU-Endpoint (s. u.) |
| **Azure Neural TTS** | nur native | HTTP + REST `/cognitiveservices/v1` | 150+ Locales, echte deutsche Stimmen | $0,016 (Commitment ab $0,0075) | **199 ms** | 🟢 **EU** (regionsabhängig) |
| **Speechify Simba** | nur native | HTTP chunked `/audio/stream` | 3.0 (Default): de, en, es, fr, it, pt · 3.2: nur en | **$0,006–0,010** | 667 ms | 🟡 USA |
| **Fish Audio S2** | nur native | WebSocket + MessagePack | 80+ | $0,015 / 1k **Bytes** (`s2.1-pro-free`: $0) | 324 ms | 🔴 **Drittland** |
| **ElevenLabs** | native + Voice-Agent | WebSocket `stream-input` | 30+ | ≈ $0,11 | **146 ms** | 🟡 USA |

TTFA = Zeit bis zum ersten Audio-Byte, Median über drei deutsche Sätze mit je
frischer Verbindung (`npm run tts-bench`, gemessen 2026-08-18 von einem
Entwicklerrechner in Deutschland). Auf Kosten pro gesprochener Minute
umgerechnet: ElevenLabs $0,126 · Aura $0,028 · **Voxtral $0,015**.

„Pfad" meint den `voiceProvider` des Agents: Die **Deepgram-Voice-Agent-API**
reicht nur ihre eigenen Stimmen und ElevenLabs durch. Alle übrigen Engines
laufen ausschließlich in der **nativen Kaskade** (`voiceProvider: "native"`).
Stellt man am Agenten trotzdem einen nativ-only-Provider ein, fällt der
Voice-Agent-Pfad mit einer Warnung auf die Deepgram-Stimme zurück — ein Anruf
scheitert nie an der TTS-Auswahl.

---

## Auswahlhilfe

**Deutscher Agent, DSGVO im Vordergrund → Mistral Voxtral.** Einzige Engine im
Feld mit EU-Verarbeitung als Standard und mit Abstand die günstigste — rund ein
Achtel der ElevenLabs-Kosten. Der Preis dafür ist Latenz: 400 ms gegenüber
146 ms bei ElevenLabs, also gut eine Viertelsekunde mehr, bis das erste Wort
kommt. Das ist im Gespräch spürbar, aber nicht disqualifizierend.

**Niedrigste Latenz zählt mehr als alles andere → ElevenLabs.** Der warm
gehaltene Socket mit `auto_mode` ist im Feld unerreicht (146 ms) — und mit
$0,126 je gesprochener Minute rund achtmal so teuer wie Voxtral.

**Guter Mittelweg → Deepgram Aura.** 218 ms und $0,028/min, dazu derselbe
Anbieter wie beim STT und ein EU-Endpoint.

**Für deutsche Telefonagenten → Azure Neural TTS.** Gemessen 199 ms bis zum
ersten Ton — nur 60 ms hinter ElevenLabs, dabei rund ein Zehntel der Kosten, echte
deutsche Stimmen und Verarbeitung in `westeurope`. Damit ist es der einzige
Anbieter im Feld, der Latenz, Kosten, deutsche Sprachqualität und EU-Residency
zugleich erfüllt; alle anderen geben mindestens eines davon auf.

Die Herstellerangaben taugen für diese Entscheidung nicht: Mistral nennt
70–90 ms, das ist reine Modellzeit; die eigene Doku spricht von ~0,8 s
End-to-End — gemessen sind es 400 ms. Deshalb das Messharness (siehe „Messen").

---

## DSGVO und EU-Residency

Anrufaudio und Transkripte sind personenbezogene Daten. Wo die TTS-Engine
verarbeitet, ist damit eine Frage der Auftragsverarbeitung, nicht des Geschmacks.

| Provider | Betreiber | Verarbeitung | Einstufung |
|---|---|---|---|
| **Mistral Voxtral** | Mistral AI SAS, Paris (FR) | EU per Default; 30 Tage Missbrauchs-Retention, Zero Data Retention im Scale-Tarif | 🟢 **EU** — keine Drittlandübermittlung |
| **Deepgram** (Aura, Flux-STT, Voice Agent) | Deepgram Inc. (US) | `api.eu.deepgram.com` seit 10.01.2026 allgemein verfügbar; unterstützt `/v1/speak`, `/v2/listen`, `/v1/agent/converse`. Gleiche Keys, nur andere Domain | 🟢 **mit EU-Endpoint** — ohne ihn 🟡 |
| **ElevenLabs** | ElevenLabs Inc. (US) | Mit **EU-Data-Residency** (nur Enterprise) liegt die Speicherung in der EU; zusammen mit Zero Retention Mode auch die Verarbeitung. Ohne sie USA. | 🟢 **mit EU-Residency** — ohne sie 🟡 |
| **Azure Neural TTS** | Microsoft Ireland Operations Ltd. | Verarbeitung in der **gewählten Region** — `westeurope` (Niederlande) oder `germanywestcentral` (Frankfurt) bleiben in der EU | 🟢 **EU** bei EU-Region — eine US-Region hebelt die Einstufung still aus |
| **Speechify** *(geplant)* | Speechify Inc. (US) | laut Datenschutzerklärung Verarbeitung und Speicherung in den USA | 🟡 SCC/DPF erforderlich |
| **Fish Audio** *(geplant)* | Shanghai Qita Dynamic Technology Co., Ltd (CN) | keine Residency-Zusage | 🔴 **Drittland ohne Angemessenheitsbeschluss** |
| **Deepgram Flux TTS** | Deepgram Inc. (US) | `api.eu.deepgram.com` bedient `/v2/speak` **nachweislich** (live geprüft, von Deutschland aus schneller als global) — Deepgram führt den Pfad in seiner Regionsliste aber nicht auf | 🟢 **mit EU-Endpoint** — für eine belastbare Zusage bei Deepgram bestätigen lassen |

**Empfohlene Konfiguration für deutsche Installationen** — alle drei Anbieter auf
ihre EU-Endpunkte legen:

```bash
# Deepgram (STT wie TTS)
NATIVE_STT_URL=wss://api.eu.deepgram.com/v2/listen
NATIVE_TTS_URL=wss://api.eu.deepgram.com/v1/speak
DEEPGRAM_AGENT_URL=wss://api.eu.deepgram.com/v1/agent/converse

# ElevenLabs — NUR mit Enterprise-Vertrag, sonst schlägt die Verbindung fehl
ELEVENLABS_BASE_URL=wss://api.eu.residency.elevenlabs.io/v1

# Mistral braucht nichts: EU ist dort der Standard
```

`ELEVENLABS_BASE_URL` gilt **systemweit** — die native Kaskade und die
Dritt-TTS-Durchreiche der Voice-Agent-API nutzen dieselbe Basis. Es gibt keinen
Weg, versehentlich nur den einen Pfad umzustellen.

**Warum die EU-URL nicht der Default ist:** ElevenLabs bietet Data Residency
ausschließlich im Enterprise-Tarif. Ein normaler Account bekommt auf dem
Residency-Host keine Verbindung — als Default würde die Variable also jede
Installation ohne Enterprise-Vertrag beim ersten ElevenLabs-Anruf brechen. Sie
gehört deshalb bewusst in die `.env` der jeweiligen Installation.

Die Badges im Agenten-Panel zeigen dieselbe Einstufung direkt bei der Auswahl,
damit die Entscheidung nicht erst in der Doku auffällt.

### Geklonte Stimmen sind personenbezogene Daten

Eine Stimme, die eine identifizierbare Person nachbildet, ist ein
personenbezogenes Datum — zusätzlich zum Persönlichkeitsrecht an der eigenen
Stimme. Praktisch heißt das:

- **Einwilligung der Sprecherin bzw. des Sprechers** einholen und dokumentieren,
  und zwar ausdrücklich für die Synthese, nicht nur für die Aufnahme.
- **Löschfrist festlegen.** Mistrals Voice-API kennt dafür `retention_notice`
  (Standard 30 Tage); die Admin-API setzt den Wert bei jedem Anlegen mit.
- **Nicht mehr benötigte Klone löschen** (`DELETE /api/tts/voices/:id`).

---

## Stimmen migrieren (ElevenLabs → Voxtral)

Voxtral klont zero-shot aus ~3 Sekunden Referenzaudio, in Blindtests wurde es
gegenüber ElevenLabs Flash v2.5 in 68,4 % der Vergleiche bevorzugt. Ein Wechsel
ist damit realistisch — mit zwei Einschränkungen.

**Für Deutsch führt kein Weg am Klonen vorbei.** Die Cloud-API hält nur zehn
Preset-Stimmen bereit, alle englisch (acht Varianten einer US-Stimme, zwei
britische), davon eine einzige weibliche. Voxtral ist ein Cloning-Modell — die
eigentliche Stimme bringt man selbst mit. Deutscher Text mit einer englischen
Preset-Stimme funktioniert zwar (cross-lingual, geprüft), klingt aber
entsprechend. Ein deutscher Produktionsagent braucht eine geklonte Stimme.

> **Nicht aus ElevenLabs-Ausgaben klonen.** Die Nutzungsbedingungen von
> ElevenLabs untersagen, erzeugtes Audio als Eingabe für Modelltraining oder für
> konkurrierende Dienste zu verwenden. Ein paar Sekunden generierte Sprache in
> Voxtral zu klonen wäre genau das.

**Der saubere Weg** ist, aus derselben **Originalaufnahme** neu zu klonen, aus
der die ElevenLabs-Stimme entstanden ist — also aus dem Rohmaterial der
Sprecherin bzw. des Sprechers, an dem die eigenen Nutzungsrechte bestehen. Drei
Sekunden genügen.

```bash
# Referenzaufnahme (WAV/MP3) base64-kodieren und anlegen
BASE64=$(base64 -i stimme-original.wav)
curl -X POST http://localhost:8080/api/tts/voices \
  -H "x-api-key: $ADMIN_API_KEY" -H "Content-Type: application/json" \
  -d "{\"name\":\"Empfang\",\"sampleAudio\":\"$BASE64\",\"sampleFilename\":\"stimme-original.wav\",\"retentionNotice\":30}"
```

Die zurückgegebene `id` trägt man am Agenten als Stimme ein (Panel: Feld
„Eigene/geklonte Stimm-ID"). Bestehende Stimmen listet
`GET /api/tts/voices`, Löschen `DELETE /api/tts/voices/:id`.

---

## Technische Hinweise

### Voxtral gibt 24 kHz aus — die Telefonstrecke fährt 8 kHz

Voxtral synthetisiert fest mit 24 kHz. Die Umsetzung auf `AUDIO_SAMPLE_RATE`
übernimmt `src/audio/resample.ts`: ein Polyphase-FIR mit Fenster-Sinc-Prototyp,
Cutoff 3600 Hz, ~96 Taps. Gemessene Kurve: bis 3 kHz flach, bei 4 kHz (der
Ziel-Nyquistfrequenz) −48,7 dB, darüber −71 dB und mehr.

Der Filter ist nicht optional. Ohne ihn faltet sich alles zwischen 4 und 12 kHz
— Zischlaute, Plosive — zurück ins Sprachband und wird als metallisches Sirren
hörbar. Die vorhandenen Filter im Medienpfad helfen nicht: der DC-Blocker in
`audiosocketServer.ts` ist ein 6-Hz-*Hoch*pass, die Rampen sind 5-ms-Hüllkurven.

### HTTP-TTS klingt anders als WebSocket-TTS

Aura und ElevenLabs halten einen Socket offen; Voxtral fährt **einen Request je
Satz**. Streng seriell heißt das: an jeder Satzgrenze eine Lücke in Höhe der
Request-Latenz. Läuft die Playout-Queue dabei leer, blendet die Medienstrecke
aus und wieder ein — als Kerbe hörbar.

Gegenmittel ist `NATIVE_HTTP_TTS_CONCURRENCY=2`: der nächste Satz wird
vorgeholt, während der aktuelle noch spielt. Die Ausgabereihenfolge bleibt
garantiert (Head-of-Line-Emitter in `src/native/ttsHttp.ts`). Der Standard ist
`1`; auf `2` erhöhen, wenn Antworten zerhackt klingen.

### Azure: REST statt WebSocket — und was das kostet

Azure kann Text streamen (Tokens direkt in den Socket, ohne auf Satzgrenzen zu
warten), aber nur über den WebSocket-v2-Endpunkt — und den unterstützt Microsoft
ausschließlich in den SDKs für **C#, C++ und Python**. Für Node gibt es weder
SDK-Feature noch öffentlich dokumentiertes Wire-Format; ein Nachbau wäre geraten,
nicht spezifiziert.

Der Adapter fährt deshalb REST: ein `POST /cognitiveservices/v1` je Satz, SSML im
Body. Architektonisch ist Azure damit in derselben Klasse wie Voxtral — mit
demselben Vorbehalt bei den Satzgrenzen (siehe „HTTP-TTS klingt anders"). Dafür
sind `raw-8khz-16bit-mono-pcm` und `raw-16khz-16bit-mono-pcm` native Formate:
**kein Resampling**, anders als bei Voxtral.

Der Sprechtext wird XML-escaped, bevor er ins SSML geht. Das ist nicht Kosmetik —
ein kaufmännisches Und aus der LLM-Antwort („Meyer & Sohn") würde das Dokument
sonst zerreißen und Azure mit 400 antworten lassen; der Satz fiele stumm aus.

Stimmen stehen bei Azure im **Modellfeld**, nicht im Stimmfeld: der Name *ist* die
Stimme (`de-DE-KatjaNeural`), genau wie bei Aura.

**Stimmauswahl (0.8.11).** Der Katalog führt zehn kuratierte Stimmen — acht
deutschsprachige plus zwei englische —, die im Agenten-Panel als Dropdown
erscheinen. Region `westeurope` bietet insgesamt 774 Stimmen, davon 27 deutsche;
alles außerhalb der Auswahl geht weiterhin über das Freitextfeld, und die
vollständige, regionsaktuelle Liste holt `GET /api/tts/voices?provider=azure`
direkt bei Azure ab. Der Katalog bleibt bewusst eine Einstiegsauswahl statt einer
Kopie: eine gepflegte Liste von 774 Einträgen veraltet, und erfundene Namen hatten
wir schon (siehe Voxtral).

Gemessen in `westeurope` (Median aus drei Läufen bei warmer Verbindung, derselbe
Satz):

| Stimme | TTFA | Audiodauer |
|---|---:|---:|
| `de-DE-ConradNeural` | 61 ms | 8,20 s |
| `de-DE-KatjaNeural` | 93 ms | 8,80 s |
| `de-DE-FlorianMultilingualNeural` | 97 ms | 7,14 s |
| `de-DE-SeraphinaMultilingualNeural` *(Default)* | 132 ms | 8,35 s |
| `de-DE-AmalaNeural` | 211 ms | 9,12 s |
| `de-DE-Seraphina:DragonHDLatestNeural` | 299 ms | 7,45 s |
| `de-DE-Mia:MAI-Voice-2-Flash` | 503 ms | 6,80 s |

**Der Default ist `de-DE-SeraphinaMultilingualNeural`, obwohl Conrad doppelt so
schnell antwortet.** Grund ist die Laufzeit-Übersetzung: der `callLocalizer`
wechselt die Sprache mitten im Gespräch, und die mehrsprachigen Stimmen decken
laut Azure über 90 weitere Locales mit derselben Klangfarbe ab. Eine einsprachige
Stimme wechselte dabei hörbar die Identität. Für rein deutsche Agenten ohne
Übersetzung ist Conrad oder Katja die schnellere Wahl.

**Die `MAI-Voice-2`-Stimmen sind trotz des Namenszusatzes „Flash" nichts für die
Telefonie**: 503 ms bis zur ersten Silbe sind das Vier- bis Achtfache der
klassischen Neural-Stimmen. Ihre 18 Sprechstile sind für Vorproduktion gedacht,
nicht für ein Gespräch, das auf die erste Silbe wartet.

Ein Hinweis zur Messung: mit **kalter** Verbindung liegen dieselben Stimmen bei
233–254 ms statt 61–132 ms — der TLS-Handshake dominiert. Innerhalb eines Anrufs
mit dicht aufeinanderfolgenden Sätzen ist die Verbindung warm, nach einer längeren
Hörpause nicht mehr. Das ist derselbe Effekt, den der Abschnitt „HTTP-TTS klingt
anders als WebSocket-TTS" weiter oben beschreibt; die dortigen Zahlen sind
entsprechend die pessimistischere Referenz.

**Sprechtempo (0.8.10).** `speak.speed` wirkt bei Azure als `<prosody rate>` im
SSML — als Prozentwert relativ zur Standardgeschwindigkeit, also 1.2 → `+20%`.
Der Multiplikator wird auf 0,5–2,0 geklemmt (darüber rendert Azure die Stimme
nicht mehr sauber); außerhalb des Bereichs gibt es eine Warnzeile, keinen Fehler.
Ist nichts gesetzt, bleibt das `prosody`-Tag ganz weg — ein `rate='+0%'` wäre
wirkungslos, aber zusätzliche Angriffsfläche im XML-Dokument.

Gemessen an `de-DE-SeraphinaMultilingualNeural`, derselbe Satz:

| `speak.speed` | Audiodauer |
|---|---:|
| unset / 1.0 | 8,35 s |
| 1.1 | 7,64 s |
| 1.2 | 6,94 s |
| 1.3 | 6,21 s |

Die mehrsprachigen Neural-Stimmen sprechen von Haus aus eher ruhig; 1.1–1.2
klingt am Telefon flüssiger, ohne gehetzt zu wirken. Die DragonHD-Varianten
sind schon ohne `prosody` rund 20 % schneller, kosten aber etwa 100 ms mehr bis
zur ersten Silbe.

### Speechify: warum simba-3.0 und kein SSML

Default ist `simba-3.0`, nicht das neuere `simba-3.2` — **nur 3.0 spricht
Deutsch** (dazu en, es, fr, it, pt-BR). 3.2 ist streaming-nativ und schneller,
aber englisch-only.

Die dokumentierten `*_32`-Stimmen gehören zu 3.2 und damit zu Englisch. Der Katalog führt 983 Stimmen, davon **44 mit `de-DE` für simba-3.0** (live
abgerufen 2026-08-18). Im Manifest steht eine Auswahl — die `-agent`-Varianten
(`katharina-agent`, `benedikt-agent`, `henrik-agent`) sind ausdrücklich für
Sprachassistenten gebaut. Die vollständige Liste holt
`GET /api/tts/voices?provider=speechify&model=simba-3.0`.

Emotion und Tempo gingen bei Speechify nur über SSML. Das ist bewusst nicht
verdrahtet: Das LLM müsste Markup erzeugen, der Satz-Chunker schneidet aber an
`.`/`!`/`?` — also mitten durch ein Tag —, und das Markup landete im
DB-Transkript und im Sprach-Scorer. Großer Radius für einen kosmetischen Gewinn.

Falls der Dienst statt rohem PCM doch einen WAV-Container liefert, schneidet der
Adapter den Header ab; sonst wäre er am Satzanfang als Knacks zu hören.

### Fish Audio: Drittland, MessagePack und eine offene Frage

Fish ist der einzige Anbieter im Feld mit **roter** Einstufung: betrieben von
Shanghai Qita Dynamic Technology Co., Ltd, ohne Angemessenheitsbeschluss.
Anrufaudio und -text sind personenbezogen. Der Provider ist deshalb doppelt
gesperrt — ohne `FISH_AUDIO_ENABLED=true` erscheint er weder im Panel noch baut
ihn der Anruf (Fallback auf Aura). Vor dem Einschalten gehören eine eigene
Transfer-Folgenabschätzung und SCC dazu.

Technisch fällt Fish zweimal aus der Reihe: Es serialisiert mit **MessagePack**
statt JSON (die einzige neue Laufzeitabhängigkeit des ganzen Blocks), und es
rechnet in **UTF-8-Bytes** statt in Zeichen ab — deutsche Umlaute und ß kosten
doppelt. `metrics.ttsCharacters` trägt bei Fish deshalb Bytes; eine zeichengenaue
Zahl wäre für die Kostenrechnung schlicht falsch.

**`sample_rate: 8000` wird akzeptiert** — die offene Frage aus dem Plan ist damit
beantwortet. Gegengeprüft mit demselben Satz bei 8000, 16000 und 44100 Hz: die
Bytezahlen skalieren mit der Rate (1,76 s / 2,09 s / 1,95 s Sprache), bei einem
ignorierten Parameter wäre dreimal dieselbe Datenmenge gekommen. Es wird also
**nicht resampelt**.

Scheitert ein Handshake, liest der Adapter den Antwort-Body aus: Statt
`Unexpected server response: 402` steht die Erklärung des Dienstes im Log.

### ElevenLabs meldet kein Turn-Ende

Der reale `stream-input`-Endpoint sendet `isFinal` erst beim Verbindungsende,
nicht als Antwort auf `flush` — geprüft mit `auto_mode=true` und `=false`, in
beiden Fällen gleich. Das `flushed`-Event des Adapters feuert deshalb erst beim
Schließen. Produktiv hat das heute keine Folge (einziger Verbraucher wäre
`agentAudioDone`, und das Auflegen wartet über `MediaSession.pendingMs()`), aber
wer ein verlässliches Turn-Ende braucht, muss auf `multi-stream-input` mit
`close_context` wechseln — den Endpoint nutzt der Voice-Agent-Pfad bereits.

### Abrechnungsbasis

Gezählt wird, was tatsächlich an den Anbieter **gesendet** wurde — ein per
Barge-in verworfener Satz zählt nicht. Die Werte landen pro Anruf in
`metrics.ttsProvider/ttsModel/ttsCharacters/ttsCredits`.

---

## Messen

```bash
npm run tts-bench          # bzw. npx tsx src/scripts/ttsBench.ts
TTS_BENCH_PROVIDERS=mistral,deepgram npm run tts-bench
```

Das Harness schickt dieselben deutschen Sätze durch jeden konfigurierten
Provider und meldet TTFA (Median, Minimum, Maximum), Audiodauer, Zeichen und
Kosten. Es braucht weder Datenbank noch Asterisk, nur die API-Keys im Env.
Provider ohne Key werden übersprungen statt still auf Aura zurückzufallen. Für
ElevenLabs die Voice-ID über `TTS_BENCH_ELEVEN_VOICE` mitgeben.

Das Ende einer Äußerung erkennt das Harness über ein Ruhefenster, nicht über
`flushed` — sonst würde es je nach Provider Verschiedenes messen (siehe oben).

Im laufenden Betrieb landen die Turn-Latenzen zusätzlich pro Anruf in der
Datenbank (`metrics.turnLatencyMs`, `turnThinkMs`, `turnTtsMs`, `turns` —
jeweils Median über alle Agenten-Turns). Damit lässt sich die Provider-Wahl
gegen echte Gespräche prüfen statt gegen ein Skript.

---

## ENV-Referenz

| Variable | Default | Zweck |
|---|---|---|
| `DEEPGRAM_API_KEY` | *(leer)* | Aura-TTS, Flux-STT und Voice Agent |
| `ELEVENLABS_API_KEY` | *(leer)* | ElevenLabs-TTS; Voice-ID steht am Agenten |
| `MISTRAL_API_KEY` | *(leer)* | Voxtral-TTS und Voice-Cloning |
| `AZURE_SPEECH_KEY` | *(leer)* | Azure Neural TTS |
| `AZURE_SPEECH_REGION` | `westeurope` | **Bestimmt den Verarbeitungsort** — EU-Region wählen |
| `AZURE_SPEECH_ENDPOINT` | *(leer)* | Vollständige URL; nur für Private Endpoints / Custom Voice |
| `SPEECHIFY_API_KEY` | *(leer)* | Speechify Simba |
| `FISH_AUDIO_API_KEY` | *(leer)* | Fish Audio S2 |
| `FISH_AUDIO_ENABLED` | `false` | **Drittland-Freigabe** — ohne sie ist Fish gesperrt |
| `NATIVE_TTS_URL` | `wss://api.deepgram.com/v1/speak` | Aura-Endpoint (EU: `api.eu.deepgram.com`) |
| `ELEVENLABS_BASE_URL` | `wss://api.elevenlabs.io/v1` | ElevenLabs-Basis, **systemweit** (EU: `wss://api.eu.residency.elevenlabs.io/v1`, Enterprise) |
| `NATIVE_TTS_MISTRAL_URL` | `https://api.mistral.ai/v1` | Mistral-Basis |
| `NATIVE_HTTP_TTS_CONCURRENCY` | `1` | Parallele Synthese-Requests bei HTTP-TTS |

API-Keys bleiben immer im Server-Env. Sie landen nie in der Datenbank und nie im
Frontend — der Katalog-Endpoint meldet nur, **ob** ein Key gesetzt ist.

---

## Stand der Messungen

Alle sieben Engines gemessen (`npm run tts-bench`, drei deutsche Sätze, frische
Verbindung je Satz, von einem Entwicklerrechner in Deutschland, 2026-08-18):

| Provider | TTFA | $/Minute | Verarbeitung | Deutsch |
|---|---|---|---|---|
| ElevenLabs Flash v2.5 | **138 ms** | $0,115 | 🟡 US (EU nur Enterprise) | ✅ |
| Deepgram Aura-2 | 159 ms | $0,027 | 🟢 EU-Endpoint | ✅ |
| Deepgram Flux TTS | 162 ms | $0,032 | 🟢 EU-Endpoint | ❌ nur Englisch |
| **Azure Neural TTS** | **191 ms** | **$0,013** | 🟢 **EU-Region** | ✅ |
| Fish Audio S2.1 Pro | 324 ms | $0,016 (frei: $0) | 🔴 Drittland | ✅ |
| Mistral Voxtral | 461 ms | $0,016 | 🟢 EU | ⚠️ nur geklont |
| Speechify Simba 3.0 | 670 ms | **$0,010** | 🟡 US | ✅ |

**Azure gewinnt den Zielkonflikt.** Es ist der einzige Anbieter, der Latenz,
Kosten, deutsche Sprachqualität und EU-Verarbeitung zugleich erfüllt — 53 ms
hinter dem schnellsten Anbieter, bei einem Neuntel von dessen Kosten.

Die übrigen geben jeweils mindestens eines auf: ElevenLabs die EU-Residency (außer
im Enterprise-Tarif) und den Preis, Flux TTS die deutsche Sprache, Voxtral und
Speechify die Latenz, Fish den Datenschutz.

