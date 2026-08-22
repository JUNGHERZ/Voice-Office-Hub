# Changelog

Alle nennenswerten Änderungen an diesem Projekt werden hier dokumentiert.
Das Format orientiert sich an [Keep a Changelog](https://keepachangelog.com/de/1.1.0/),
die Versionierung folgt [Semantic Versioning](https://semver.org/lang/de/).

## [Unreleased]

## [0.11.0] – 2026-08-22

Eine Widget-Sitzung war bisher kein Sicherheitsmerkmal, sondern nur eine Auskunft. Das ändert sich.

### Changed

- **Ein Web-Anruf braucht eine eingelöste Sitzung.** `POST /api/widget/session` prägt jetzt je Anruf ein Token (`callToken` in der Antwort), merkt sich `Token → Agent` mit kurzer Frist und gibt es zurück; der Client setzt es wie bisher als SIP-Header `X-Widget-Token`. Beim `StasisStart` löst die Engine es ein — unbekannt, abgelaufen, schon verbraucht oder für einen **anderen** Agenten ausgestellt, und der Anruf endet vor dem Answer, ohne Gesprächsdatensatz und ohne Kosten.

  Das schließt zwei Lücken auf einmal. Erstens war das SIP-Passwort ein Deployment-Secret: Wer es hatte, brauchte den Session-Endpunkt nie wieder, und damit griffen weder Origin-Prüfung noch Rate-Limits noch der Deckel für gleichzeitige Anrufe. Zweitens waren mit denselben Zugangsdaten **alle** dreistelligen Durchwahlen im `[webrtc-inbound]`-Kontext wählbar, also auch die eines fremden Agenten — wo je Agent abgerechnet wird, war das eine Kostenverschiebung zwischen Mandanten. Ein Token gilt jetzt für genau einen Agenten und genau ein INVITE; das Live-Transkript bleibt davon unberührt und funktioniert mit demselben Token weiter, auch im Nachlauf.

  Echte ephemere SIP-Zugangsdaten wären der direktere Weg, setzen aber dynamische PJSIP-Konfiguration voraus (Realtime oder ein Reload je Sitzung) — die Appliance schreibt ihre Konfiguration einmal beim Containerstart. Das Token erreicht dasselbe Schutzziel ohne dieses Gerüst.

  **Für Bestandsbetriebe:** Das mitgelieferte Widget zieht automatisch mit. Ein eigener Client, der sein Token bisher selbst erzeugt, muss es aus der Session-Antwort übernehmen — oder übergangsweise `WIDGET_REQUIRE_SESSION=false` setzen. Abgewiesene Anrufe stehen als `info`-Zeile mit Grund im Log; ohne sie sähe ein falsch konfiguriertes Widget aus wie „Anrufer legen sofort auf".

### Added

- **`x-api-key` am Session-Endpunkt hebt den IP-Deckel auf.** Wer die Sitzung serverseitig holt, damit der Widget-Schlüssel den Browser nie erreicht, wurde von `WIDGET_SESSION_RATE_IP` falsch gezählt: Der Deckel traf nicht mehr einzelne Besucher, sondern die ganze Appliance. Ein authentifizierter Aufrufer ist ein Vermittler und kein Besucher — er bringt sein eigenes Gate mit. Alles andere bleibt: Key-Deckel je Agent, Concurrent-Deckel, Kill-Switch, Origin-Prüfung, Sitzungsbindung. Ohne den Header ändert sich nichts, ein falscher Header steht wie gar keiner.

## [0.10.3] – 2026-08-22

### Added

- **`widgetToken` im `agent.resolve`-Umschlag.** Ein Web-Anruf war für den Overlay-Hook bisher nicht wiedererkennbar: `agentId` ist bei jedem Besucher derselbe, `from` und `channelId` entstehen erst im Moment des Anrufs. Wer pro Anruf anderen Kontext einsetzen will, hatte damit keinen Anker — und ihn kurz vorher in den Agenten zu schreiben scheidet aus, weil zwei gleichzeitige Besucher sich gegenseitig überschrieben. Das Widget-Token, das der Dialplan schon als drittes Stasis-Argument durchreicht und die Engine am Gespräch speichert, steht jetzt zusätzlich im Auflöser-Aufruf und ist von der Signatur gedeckt. Bei Telefonaten fehlt der Schlüssel — der Umschlag ist dort unverändert.

## [0.10.2] – 2026-08-22

### Added

- **Widget-Session auch für fremde Origins.** `POST /api/widget/session` akzeptierte bisher nur Anfragen von der Appliance selbst — das Widget ließ sich damit nirgendwo sonst betreiben, denn der Fetch aus dem eingebetteten iframe trägt die Origin der **einbettenden** Seite. Erlaubt sind jetzt zusätzlich die Origins aus `widget.allowedOrigins` des Agenten. Dasselbe Feld steuerte bereits die Einbettung (CSP `frame-ancestors`); es gilt nun für beides, mit derselben Semantik: `https://*.kunde.de` deckt Unterdomänen ab, nicht die Domäne selbst, Schema und Port müssen übereinstimmen. **Leere Liste = unverändertes Verhalten** (nur die Appliance selbst); eine nicht gelistete Origin bleibt bei 403. Kein neuer Mechanismus: kein Ticket, kein Exten-Pool, `findByWidgetKey` unverändert.

### Changed

- **Doku ohne harte Zeilenumbrüche.** Die Dateien unter `docs/` waren auf ~100 Zeichen umbrochen. Ein Absatz ist jetzt eine Zeile — inhaltlich unverändert (geprüft: identische Wortfolge, Code-Blöcke und Tabellen unangetastet), aber Diffs bleiben künftig auf die tatsächlich geänderten Stellen beschränkt. Nebenbei repariert: zwölf deutsche Komposita, die der alte Umbruch mitten im Wort getrennt hatte.

## [0.10.1] – 2026-08-22

Ein aufgelegter Klingelversuch ist kein Systemfehler mehr — und er klingelt jetzt
auch. Beides sind Folgen davon, dass die Begrüßung seit 0.10.0 **vor** dem Answer
entsteht: Zwischen `StasisStart` und dem Abheben lagen bis dahin ~1 ms, seitdem sind
es 1,2–1,6 s. In diesem Fenster wurde ein Auflegen erstmals wahrscheinlich, und die
Engine war darauf nicht vorbereitet.

### Added

- **Rufton während des Aufbaus.** Der Dialplan schickt vor `Stasis()` bewusst keine
  Antwort, damit unbekannte Rufnummern noch mit 404 abgelehnt werden können. Bis
  0.10.0 folgte 1 ms später das 200 OK, seitdem hörte der Anrufer in der gesamten
  Erzeugungszeit **nichts** — keinen Rufton, kein Freizeichen, eine tote Leitung, die
  zum Auflegen einlädt. Die Engine setzt jetzt vor der Begrüßung ein 180 Ringing
  (`channel.ring()`, best effort). Die Ablehnung unbekannter Nummern bleibt
  unverändert; sie greift vor diesem Punkt.
- **Anrufstatus `abandoned`.** Weder `completed` noch `failed` beschreibt einen
  Anrufer, der vor dem Zustandekommen auflegt: Das eine erfindet ein Gespräch und
  verfälscht jede Auswertung über `status`, das andere meldet dem Betreiber eine
  Störung. Die Admin-UI zeigt „Nicht angenommen" in neutralem Badge; der Filter
  `GET /api/requests?status=abandoned` kennt den Wert.

### Fixed

- **Aufgelegter Anrufer beendet den Anrufaufbau, statt in einen ARI-Fehler zu laufen.**
  Zwischen `StasisStart` und der fertigen Verdrahtung hing bisher **kein**
  Hangup-Handler — `StasisEnd` brach nur die Begrüßungserzeugung ab. Der Aufbau lief
  danach weiter, hob ab, baute Bridge und Medienkanal und scheiterte am nächsten
  ARI-Aufruf mit „Channel not in Stasis application": ein `error` im Log, `status:
  "failed"` und ein `call.failed` beim Empfänger — für einen Anruf, bei dem nur jemand
  aufgelegt hatte. Jetzt steigt der Aufbau nach dem Verschwinden des Kanals aus, und ein
  Kanal-weg-Fehler aus einem der fünf ARI-Aufrufe wird als das gedeutet, was er ist
  (`info`, `abandoned`, `call.ended`). Ein echter Aufbaufehler bleibt `failed`.
  Gilt gleichermaßen für den Passthrough-Modus, wo der Anrufer während der Wählzeit
  zum Ziel auflegen kann.
- **Instanz-Listener werden wieder abgemeldet.** Pro Anruf registrierte der callHandler
  zwei `ChannelDestroyed`-Listener am Kanal und entfernte keinen davon. `ari-client`
  hält solche Listener in einer Liste je Ereignistyp, kürzt sie von sich aus nie und
  läuft sie bei **jedem** `ChannelDestroyed` komplett durch — auf einer Appliance, die
  wochenlang läuft, wuchs damit Speicher und Aufwand mit jedem Anruf.

### Notes

- Der `AbortController` aus 0.10.0 funktioniert wie vorgesehen; der beobachtete
  Fehlschlag lag nicht an ihm. Ungetestet war, was **nach** dem Abbruch geschieht — der
  Fake-Kanal ließ `answer()` immer gelingen und bildete damit den entscheidenden Teil
  des echten ARI nicht ab. Die Fakes modellieren einen verschwundenen Kanal jetzt.

## [0.10.0] – 2026-08-22

Vier Ergänzungen am Agenten, eine Aufbewahrungsgrenze für Aufnahmen und ein
Begrüßungs-Prompt. Additiv: Ohne gesetzte Felder verhält sich die Engine wie in
0.9.x. **Zwei Ausnahmen** stehen unter „Changed" — sie wirken dort, wo nie eine
Variable gesetzt wurde.

### Added

- **`recording.enabled` (Default `true`).** Bis hierher nahm die Appliance
  bedingungslos auf. Wer dem widerspricht, bekommt jetzt keinen Mitschnitt: kein
  GridFS-Objekt, kein `recording`-Block am Gespräch, kein `recording.ready`.

  Der Default ist der eigentliche Punkt. Ein **fehlendes** Feld gilt als `true` —
  würde es als „aus" gelesen, hörte jede bestehende Installation nach dem Update
  stillschweigend auf aufzunehmen. Deshalb `??` und ausdrücklich kein `||`, ein
  Test hält es fest, und es gibt keine Migration: Der Default entsteht beim
  Auflösen, nicht in der Datenbank.

  Die Abwahl greift in **beiden** Aufnahmepfaden, auch im Passthrough. Dort
  wiegt sie schwerer, als es zunächst aussieht: Das Transkript entsteht dort AUS
  der Aufnahme (Batch-Transkription), ohne sie gibt es also weder Transkript noch
  Zusammenfassung. Das steht so an der Oberfläche und in der Doku — eine
  Zusage, die nur im Agent-Modus gilt, wäre keine.

- **Begrüßungs-Prompt (`greetingPrompt`).** Statt eines festen Eröffnungssatzes
  kann eine ANWEISUNG hinterlegt werden, aus der der Satz je Anruf entsteht —
  „Guten Morgen / Guten Tag / Guten Abend" je nach Uhrzeit, mit wechselnden
  Angaben. Der Inhalt kommt von außen, die **Sprache** bestimmt die Engine
  (`prior?.lang ?? contentLanguage`): Bis der Anrufer spricht, ist der
  pseudonymisierte Anrufer-Prior die einzige Quelle dafür, und der soll die
  Appliance nicht verlassen. Es wandert also der Prompt herein, nicht die
  Sprache hinaus.

  Zwei Dinge tragen die Umsetzung. Erstens der **Zeitpunkt**: Der Aufruf wird vor
  dem `Answer()` angestoßen und erst kurz vor dem Session-Aufbau abgewartet. Der
  Dialplan ruft `Stasis()` bewusst ohne vorheriges `Answer()` — dieses Fenster ist
  Rufton, keine Stille nach dem Abheben —, und der Anrufaufbau läuft gegen die
  Wartezeit. Zweitens der **Abbruch**: Legt der Anrufer noch im Rufton auf, wird
  der Modellaufruf abgebrochen. Ohne das zahlte jeder Klingelabbrecher ein Modell,
  und ein Anschluss mit vielen Auflegern erzeugte eine laufende Rechnung für
  Gespräche, die nie stattgefunden haben.

  Scheitert die Erzeugung — Fehler, Zeitüberschreitung, leere Antwort —, gilt der
  statische Text und der Anruf läuft weiter. `greeting` bleibt deshalb nötig: Es
  ist nicht mehr der Normalfall, sondern das Sicherheitsnetz. Einen Cache gibt es
  bewusst nicht; ein pro Anruf wechselnder Text träfe den Übersetzungs-Cache
  (Schlüssel samt Quelltext-Hash) ohnehin nie.

  Neu am Gespräch: **`greetingText`**, der tatsächlich gesprochene Satz — immer,
  auch wenn er unverändert vom Agenten stammt. Ein später geänderter
  `greeting`-Text würde sonst rückwirkend etwas belegen, das nie gesagt wurde.

- **Admin-UI:** Schalter „Gespräch aufzeichnen" im Agenten-Formular (mit dem
  Passthrough-Hinweis), Feld „Begrüßungs-Prompt" direkt unter der Begrüßung — die
  dann als „Begrüßung (Rückfall)" beschriftet wird, sobald ein Prompt gesetzt ist,
  weil sie sonst etwas anzeigt, das im Anruf gar nicht gesprochen wird. In der
  Agentenliste erscheint `externalRef` als Kennzeichen (nur Anzeige: Das Feld
  gehört dem anlegenden System, ein editierbares Duplikat lädt zu Abweichungen
  ein). `maxDurationSec` bleibt bewusst API-seitig.

- **`externalRef` am Agenten.** Freie Kennung des anlegenden Systems; VOH wertet
  sie nie aus, führt sie aber überall mit — im Agent-Dokument, in der
  Agentenliste der Oberfläche und in **jedem** Ereignis zu diesem Agenten. Bis
  hierher verwarf Mongoose ein unbekanntes Feld im PATCH stillschweigend, womit
  ein Änderungsvergleich auf der Gegenseite ewig einen Unterschied fand.
  Abgrenzung zu `agentRef` am Gespräch: das stammt aus einer Resolver-Antwort und
  existiert nur, wenn ein Anruf über den Hook lief.

- **`maxDurationSec` und `endedReason`.** Eine harte Obergrenze der
  Gesprächsdauer (Kostendeckel) legt über dieselbe Drain-Logik auf wie `end_call`,
  der laufende Satz wird also nicht mitten im Wort abgeschnitten.

  `endedReason` beantwortet dauerhaft, warum ein Gespräch endete: `caller`,
  `agent`, `transfer`, `idle`, `announce`, `maxDuration`, `failed`. Der
  `transfer`-Fall ist der Grund, warum es kein Nebenprodukt ist: Eine Übergabe an
  einen Menschen läuft **nicht** über den Auflege-Pfad — beide Beine legen einfach
  auf — und sähe sonst aus wie ein Anrufer, der frühzeitig aufgelegt hat. Für die
  Auswertung ist das der wichtigste Unterschied überhaupt: Weiterleitung ist ein
  Erfolg, frühes Auflegen ein Verdacht. Das Feld ist ein **freier String** ohne
  Aufzählung — ein künftig ergänzter Grund darf weder ein Bestandsdokument noch
  einen älteren Empfänger in einen Fehler laufen lassen.

- **Verbrauchsmengen je Anruf** (`metrics.llmModel`, `llmPromptTokens`,
  `llmCachedPromptTokens`, `llmCompletionTokens`, `llmRequests`, `sttSeconds`).
  Die Token-Zahlen lagen im LLM-Stream längst an und landeten nur im Debug-Log;
  jetzt werden sie über Turns **und** Tool-Runden summiert. Mengen, keine Beträge:
  Preise sind vertragsabhängig und gehören nicht in eine Appliance.

  `llmModel` trägt das **tatsächlich benutzte** Modell, nicht das Feld am
  Agenten. Wer die Modellwahl bewusst der Engine überlässt und `think.model` leer
  lässt, hätte sonst dauerhaft ein leeres Feld — und damit keine Kostenrechnung,
  für die die Felder überhaupt existieren. `sttSeconds` zählt die an den Provider
  gestreamte Audiodauer und läuft während eines durchgestellten Gesprächs
  ausdrücklich nicht weiter. Auf dem gebündelten Voice-Agent-Pfad bleiben die
  LLM-Felder leer — dort denkt der Anbieter selbst und meldet keine Token; die
  Abrechnungsbasis ist dort die Gesprächsdauer.

- **`RECORDING_TTL_DAYS`** (Default `0` = aus): Aufnahmen verfallen nach der
  Frist, **samt GridFS-Chunks**. Gespräch und Transkript bleiben vollständig
  erhalten, nur `GET /api/requests/:id/recording` liefert danach 404.

  Bewusst **kein** TTL-Index, obwohl es das Muster von `CallerProfile` wäre: Ein
  Mongo-TTL-Index löscht ausschließlich Dokumente der indizierten Collection. Auf
  `recordings.files` angewandt bliebe für jede Aufnahme der Chunk-Eintrag liegen
  — also praktisch das gesamte Datenvolumen, dauerhaft und ohne Referenz, das
  genaue Gegenteil des Zwecks. Stattdessen ein Aufräumjob (Start + stündlich),
  der über das Upload-Datum schneidet und damit zugleich Waisen abräumt.

  Die Frist ist zugleich eine **Abholfrist**: Der erste Abholversuch eines
  Empfängers kann scheitern, und der nächste kommt oft erst, wenn jemand das
  Gespräch anhören will. Sehr kurz gesetzt verliert man deshalb nicht nur alte
  Aufnahmen, sondern auch die — ohne Fehlermeldung, weil danach nur noch ein 404
  kommt. Steht so in der Doku.

  Einen Löschendpunkt für Gespräche gibt es weiterhin nicht: mit einem globalen
  API-Key ohne Rollenmodell eine Angriffsfläche ohne Anwendungsfall.

### Changed

- **`metrics.timeToFirstAudioMs` misst jetzt wirklich ab dem Answer.** Bis 0.9.x
  lief die Uhr ab dem Eintritt in die Stasis-App; weil der Answer damals
  unmittelbar folgte, war der Unterschied unter einer Millisekunde. Mit der vor
  dem Answer erzeugten Begrüßung wäre er es nicht mehr geblieben: Gemessen wurde
  auf der Appliance **1382 ms**, obwohl der Anrufer nach dem Abheben nur **292 ms**
  Stille erlebte — der Rest war Rufton. Der Wert beantwortet die Frage „wie lange
  ist es nach dem Abheben still", und genau das misst er jetzt. Wer historische
  Werte vergleicht, sieht an dieser Stelle einen Sprung nach unten.

- **`WEBHOOK_TIMEOUT_MS` von 5000 auf 15000.** Empfänger, die `call.ended`
  synchron verarbeiten (Zusammenfassung, Abrechnung, Benachrichtigungen),
  brauchen regelmäßig länger; die Folge waren Wiederholungen und — ohne
  Idempotenz beim Empfänger — doppelt verbuchte Gespräche.

- **`LOCALIZE_MODEL` und `SUMMARY_MODEL` haben regionsgebundene Defaults**
  (`bedrock/claude-haiku-4-5@eu-central-1` statt `openai/gpt-4.1-mini`). Diese
  beiden Nebenaufgaben sehen den kompletten Ansagen-Katalog, das ganze Transkript
  und künftig die Begrüßung samt Firmennamen. Für eine Appliance, deren
  Existenzgrund die Datenhaltung in der EU ist, darf der **voreingestellte**
  Endpunkt dafür kein ungebundener sein — beim Konversationsmodell wird die Region
  längst festgenagelt, bei den Nebenaufgaben blieb es bisher aus.

  Wer die Variablen nie gesetzt hat, wechselt mit dem Update das Modell. Die
  Umstellung wirkt aber **nicht rückwirkend**: `AgentTranslation` ist über den
  Quelltext-Hash abgesichert, unveränderte Ansagen werden nicht neu übersetzt. Die
  bestehenden Einträge bleiben also so, wie das alte Modell sie erzeugt hat —
  richtig so, eine Neuübersetzung würde nichts heilen, aber es soll niemanden
  überraschen, der nach dem Update in die Sammlung schaut.


## [0.9.0] – 2026-08-21

Zwei neue Nähte nach außen, mit denen eine übergeordnete Verwaltung mit der
Engine zusammenarbeiten kann. **Beide sind ohne gesetzte URL aus** — ohne
`RESOLVER_URL`/`WEBHOOK_URL` verhält sich die Engine exakt wie in 0.8.13: kein
ausgehender Verkehr, kein zusätzliches Feld, keine geänderte Entscheidungslogik.
Die bestehende Testsuite lief unverändert durch; das war die Bedingung.

### Added

- **Konfigurations-Overlay pro Anruf** (`RESOLVER_URL`, `RESOLVER_SECRET`,
  `RESOLVER_TIMEOUT_MS`). Nach dem DDI-Treffer, aber **vor** dem Answer, darf ein
  externer Endpunkt mitentscheiden: den Anruf freigeben (`allow`), auf eine kurze
  Ansage umleiten (`announce`) oder ablehnen (`reject`) — und dabei einzelne
  Felder des Agenten für genau diesen Anruf ersetzen, typischerweise den
  Systemprompt mit eingesetzten Laufzeitwerten.

  Zwei Entscheidungen tragen den Rest:

  **Das Overlay legt sich auf das gespeicherte Dokument, nicht auf den fertig
  aufgelösten Agenten.** Dadurch greifen für überlagerte Felder exakt dieselben
  Normalisierungen und Defaults wie für gespeicherte (ein Overlay
  `listen: {model:"flux-general-multi"}` bekommt so die üblichen Sprachhinweise
  und `smart_format`), und die `id` kann gar nicht erst überschrieben werden —
  sie entsteht ausschließlich aus `_id`. Der Agent bleibt damit ein normales
  Dokument: Anrufliste, Übersetzungen, Anrufer-Gedächtnis und der `agentId`-Eintrag
  im Tool-Envelope hängen weiter an derselben Kennung.

  Eine Ausnahme ist ausdrücklich verdrahtet: ein übergebenes `tools: []`
  bleibt leer, weil die Auflösung bei leerer Liste sonst
  `transfer_call`/`end_call` nachsetzt — und damit eine reine Ansage
  aushebeln würde.

  Ersetzt wird flach je Feld, und das gilt wörtlich: Zusammengesetzte Felder
  (`speak`, `listen`, `think`) gehören vollständig in ein Overlay. Wechselt eines
  nur `speak.provider` ohne `speak.model`, greift der anbieter-unabhängige Default
  aus `DEFAULT_SPEAK_MODEL` — bei Azure ist der Modellname aber die Stimme. Die
  Engine protokolliert diesen Fall als `warn` und führt den Anruf weiter, statt
  ihn fallen zu lassen.

  **Fail-open.** Timeout, Verbindungsfehler, Nicht-200, unlesbare Antwort oder
  ein unbekanntes `verdict` → der gespeicherte Agent gilt unverändert und der
  Anruf läuft; am Request steht `resolverStatus: "unavailable"` statt `"ok"`.
  Der Hook liegt auf dem Klingelpfad, und ein Ausfall der Gegenstelle darf nicht
  alle Anschlüsse stumm schalten. Nur `reject` ist eine eigene
  Entscheidungsform — „abgelehnt" und „keine DDI-Zuordnung" dürfen sich nicht
  verwechseln lassen, sonst würde `UNKNOWN_NUMBER_BEHAVIOR=agent` einen
  abgelehnten Anruf doch noch beantworten.

  `announce` spricht die überlagerte Begrüßung und legt danach auf — über
  dieselbe Drain-Logik wie `end_call`, damit die Schlusssilbe nicht abgeschnitten
  wird. Mit `tools: []` hört der Agent gar nicht erst zu (die native Kaskade
  öffnet dann keinen STT-Strom), eine Ansage kann also nicht in ein Gespräch
  kippen. Anders als `UNKNOWN_NUMBER_BEHAVIOR=announce` (feste WAV) ist der Text
  frei wählbar; er wird gesprochen, kostet also eine kurze Provider-Session.

  Mit `report: false` hinterlässt ein Anruf **keine** Spur: kein
  `requests`-Dokument, keine Aufnahme, keine Ereignisse, keine Nacharbeit. Statt
  den Anrufpfad mit Bedingungen zu durchziehen, bekommt er ein Repository, das
  nichts schreibt.

- **Ereignis-Zustellung** (`WEBHOOK_URL`, `WEBHOOK_SECRET`,
  `WEBHOOK_TIMEOUT_MS`, `WEBHOOK_MAX_RETRIES`, `WEBHOOK_QUEUE_LIMIT`):
  `call.started`, `call.ended`, `call.failed`, `recording.ready` und
  `tool.called` gehen an einen externen Empfänger, statt dass der
  `/api/requests` pollen muss. Kein Ereignis je Transkript-Turn — die kommen
  gesammelt in `call.ended`.

  Die Ereignisse hängen **nicht** im callHandler, sondern als Dekorator um das
  Repository. Dort liegen alle Schreibpfade an einer Stelle, kein Aufrufer muss
  daran denken, und der `passthrough`-Modus ist ohne Sonderfall mit abgedeckt —
  sonst wäre ausgerechnet der durchgestellte Anruf der eine, den der Empfänger
  nie zu sehen bekommt.

  Zugestellt wird asynchron; ein Anruf wartet nie auf einen fremden Endpunkt.
  Wiederholt wird bei Timeout, 5xx und 429 mit exponentiellem Backoff, wobei
  `X-VOH-Delivery` konstant bleibt; bei 4xx außer 429 **nicht** — das ist ein
  Vertragsfehler und wird einmal laut protokolliert statt endlos wiederholt. Die
  Warteschlange ist gedeckelt und verwirft hörbar: ein endliches Limit ohne
  Verwerfen erzeugt genau die Hänger, die es verhindern soll. Sie liegt im
  Speicher — ein Redeploy mitten im Backoff verliert offene Zustellungen (beim
  Shutdown werden sie bis zu 5 s ausgeliefert), wer Lückenlosigkeit braucht,
  gleicht periodisch gegen `/api/requests` ab.

- **`requests.agentRef` und `requests.resolverStatus`.** `agentRef` ist die opake
  Kennung, die der externe Endpunkt beim Auflösen mitgibt; sie wird gespiegelt,
  nicht interpretiert. `resolverStatus` macht sichtbar, ob ein Overlay überhaupt
  griff — ohne das Feld wäre ein stiller Fail-open von einem angewendeten
  Overlay nicht zu unterscheiden. Beide Felder sind sparse und entstehen nur bei
  konfiguriertem Hook; Bestandsdokumente bleiben unberührt.

### Notes

- Im Umschlag des Overlay-Aufrufs steht die Kanal-Kennung neu als `channelId`;
  das gleichnamige `callId` bleibt aus Kompatibilität gesetzt, gilt aber als
  veraltet. Hintergrund: Zum Zeitpunkt des Aufrufs gibt es noch kein
  `requests`-Dokument, während `callId` im Custom-Tool-Envelope seit jeher die
  Request-ID meint. Dieselbe Kanal-Kennung taucht in jedem Ereignis als
  `call.channelId` wieder auf, `call.id` ist die Request-ID.
- Ein überlagerter `greeting`-Text ist nicht vorübersetzt und wird deshalb in
  `contentLanguage` gesprochen, auch wenn für die Rufnummer eine andere Sprache
  bekannt ist. Die gespeicherten Ansagen des Agenten sind davon nicht betroffen;
  das Vorübersetzen läuft unverändert weiter.


## [0.8.13] – 2026-08-20

### Fixed

- **Die Regionsdiagnose aus 0.8.12 schlug auf der häufigsten legitimen
  Konfiguration falsch an.** Wer die vier URL-Variablen geschlossen auf die
  EU-Domain gesetzt hatte — also genau so, wie es vor 0.8.12 gehen musste — bekam
  beim Start die Warnung „ein Teil des Verkehrs läuft woanders", obwohl
  ausnahmslos aller Verkehr korrekt nach Frankfurt lief. Beim ersten Redeploy auf
  dem Live-Dev war das prompt zu sehen.

  Der Fehler lag in der Fragestellung: geprüft wurde nur „weicht eine URL von der
  Region ab", nicht „weichen die URLs **voneinander** ab". Die Prüfung
  unterscheidet jetzt drei Fälle, weil sie unterschiedlich gefährlich sind:

  | Lage | Einstufung |
  |---|---|
  | Region und URLs decken sich | still |
  | alle URLs zeigen geschlossen auf eine andere Region | Hinweis, welche Region effektiv gilt |
  | URLs sind **untereinander** uneinheitlich | Warnung mit den Namen der Abweichler |

  Im mittleren Fall gewinnt die URL, der Verkehr ist konsistent, und `DEEPGRAM_REGION`
  ist bloß dekorativ — das ist ein Hinweis wert, keine Warnung. Eine Ausnahme
  bleibt laut: zeigen die URLs geschlossen auf `global`, während die Region `eu`
  sagt, wollte jemand Europa und bekommt die USA.

- **`transfer_call` leitete mitten in einer laufenden Hilfestellung weiter.** Live
  beobachtet: Der Agent führte den Anrufer Schritt für Schritt durch `msconfig`,
  hörte dann „Trojaner a" und „Trojaner b" in der Autostart-Liste, sagte „Lass
  mich dich mit einem Spezialisten verbinden" — und rief das Tool im selben Zug
  auf, ohne die Antwort abzuwarten.

  Die Werkzeugbeschreibung beschrieb bis dahin nur, WAS das Tool tut, nie WANN es
  aufzurufen ist. Damit lag die Auslösung vollständig beim Modell. Sie nennt jetzt
  die Auslöser (Anrufer verlangt einen Menschen, ist verärgert, oder es ist
  nachweislich nicht zu helfen), die Gegenanzeige (nicht mitten in einer
  Schrittfolge; ein schwieriger Befund allein ist kein Grund), und den
  entscheidenden Unterschied: **Schlägt der Agent die Weiterleitung selbst vor,
  ist das ein Vorschlag** — er wartet die Antwort ab. Hat der Anrufer darum
  gebeten, verbindet er direkt.

  Betrifft alle Agenten, weil `transfer_call` ein eingebautes Tool ist.

### Gemessen

**Der EU-Endpunkt wirkt.** Erster Anruf über `api.eu.deepgram.com`:
`timeToFirstAudioMs` **514 ms** — der niedrigste Wert aller neun Azure-Anrufe,
vorher 629–1381 ms bei einem Median von 811. Das sind rund 300 ms am Median und
115 ms gegenüber dem bisherigen Bestwert. Die erwarteten 462 ms wurden nicht ganz
erreicht: der Verbindungsaufbau ist nur ein Teil von `timeToFirstAudioMs`, daneben
stehen ARI-/AudioSocket-Aufbau und die Synthese der Begrüßung.

Bei `turnLatencyMs` (1323 ms gegen zuletzt 1369/1377/1392) ist die erwartete
Verbesserung um ~136 ms von der Streuung eines Einzelanrufs nicht zu trennen —
dafür braucht es mehr Anrufe.


## [0.8.12] – 2026-08-20

### Gemessen

**Das Anruferaudio lief in die USA.** Die Defaults der vier Deepgram-URLs zeigen
auf `api.deepgram.com`, und auf dem Live-Dev war keine davon überschrieben —
obwohl `docs/tts-provider.md` den EU-Block seit 0.8.x empfiehlt. Von Nürnberg
aus gemessen, echter Flux-WebSocket auf `flux-general-multi`:

| Endpunkt | Verbindung offen | TCP-RTT |
|---|---:|---:|
| `api.deepgram.com` (USA) | **514 ms** | 143 ms |
| `api.eu.deepgram.com` (Frankfurt) | **52 ms** | 7 ms |

Die 462 ms schlagen voll auf `timeToFirstAudioMs` durch, weil `start()` die
Begrüßung erst nach `Promise.all([stt.start(), tts.start()])` spricht — bei
einem HTTP-TTS wie Azure, das gar keine Verbindung aufbaut, war die STT-Strecke
der alleinige Flaschenhals. Die laufende Round-Trip-Zeit verzögert zusätzlich
jedes EndOfTurn um rund 136 ms, auf jedem Turn.

Nebenbei geprüft: **`westeurope` ist Amsterdam, nicht Deutschland.** Azure bietet
Frankfurt als `germanywestcentral` an, von arm2 aus 8 ms TCP gegen 15 ms. Der
Gewinn ist real, aber klein gegen eine Synthese-TTFA von 61–132 ms, und
**Azure-Speech-Keys sind regionsgebunden** (200 gegen `westeurope`, 401 gegen
`germanywestcentral`) — ein Wechsel braucht eine neue Ressource. DSGVO-seitig
ändert er nichts: Amsterdam ist EU, Frankfurt ist EU. Anders als bei Deepgram
war hier also nichts zu reparieren.

### Added

- **`DEEPGRAM_REGION`** (`global` | `eu`, Default `global`) schaltet STT,
  Aura-TTS, Flux-TTS und die Voice-Agent-API gemeinsam um — gleicher Key, nur
  andere Domain. Die vier Einzel-URLs bleiben als Escape-Hatch und gewinnen
  weiterhin.

  Der Grund für einen Schalter statt vier Variablen ist genau der Befund oben:
  eine vergessene Zeile fällt bei vier Variablen niemandem auf, ein Schalter
  kann nicht halb greifen. Für den Rest gibt es Diagnose statt Vertrauen — das
  Startlog nennt jetzt `deepgramRegion` und den **tatsächlich verwendeten**
  STT-Host, ein unbekannter Regionswert wird als Fehler protokolliert (statt
  still in den USA zu landen), und laufen Region und einzelne URLs auseinander,
  warnt die Engine mit den Namen der Abweichler.

  Ein Sonderfall steckt in der Hostwahl: Die Voice-Agent-URL liegt global auf
  einer **eigenen** Domain (`agent.deepgram.com`), in der EU dagegen auf
  derselben `api.eu`-Domain wie alles andere. Ein `agent.eu.deepgram.com`
  existiert nicht — wer beim manuellen Umstellen stumpf ein `eu.` einsetzt, baut
  eine tote URL. Der Test hält das ausdrücklich fest.


## [0.8.11] – 2026-08-19

### Added

- **Stimmauswahl für Azure.** Der Katalog führte genau eine Stimme
  (`de-DE-KatjaNeural`) — jede andere musste als ID abgetippt werden, obwohl der
  Endpoint `GET /api/tts/voices?provider=azure` die Live-Liste längst kennt. Jetzt
  stehen zehn kuratierte Stimmen im Dropdown: acht deutschsprachige (inkl. je einer
  österreichischen und schweizerischen) plus zwei englische. Das Freitextfeld
  bleibt — `westeurope` bietet 774 Stimmen, davon 27 deutsche, und eine gepflegte
  Vollkopie würde nur veralten.

  Gemessen (Median aus drei Läufen, warme Verbindung, derselbe Satz):

  | Stimme | TTFA | Audiodauer |
  |---|---:|---:|
  | `de-DE-ConradNeural` | 61 ms | 8,20 s |
  | `de-DE-KatjaNeural` | 93 ms | 8,80 s |
  | `de-DE-FlorianMultilingualNeural` | 97 ms | 7,14 s |
  | `de-DE-SeraphinaMultilingualNeural` | 132 ms | 8,35 s |
  | `de-DE-AmalaNeural` | 211 ms | 9,12 s |
  | `de-DE-Seraphina:DragonHDLatestNeural` | 299 ms | 7,45 s |
  | `de-DE-Mia:MAI-Voice-2-Flash` | 503 ms | 6,80 s |

### Changed

- **Azure-Default ist jetzt `de-DE-SeraphinaMultilingualNeural`** statt Katja —
  obwohl Conrad doppelt so schnell antwortet. Grund ist die Laufzeit-Übersetzung:
  der `callLocalizer` wechselt die Sprache mitten im Gespräch, und die
  mehrsprachigen Stimmen decken laut Azure über 90 weitere Locales mit derselben
  Klangfarbe ab. Eine einsprachige Stimme wechselte dabei hörbar die Identität.
  Für rein deutsche Agenten ohne Übersetzung bleibt Conrad die schnellere Wahl.
  Betrifft nur neu angelegte Agenten; bestehende behalten ihre Stimme.

### Notes

**Die neuen `MAI-Voice-2`-Stimmen sind trotz des Zusatzes „Flash" nichts für die
Telefonie.** 503 ms bis zur ersten Silbe sind das Vier- bis Achtfache der
klassischen Neural-Stimmen; ihre 18 Sprechstile zielen auf Vorproduktion, nicht
auf ein Gespräch, das auf die erste Silbe wartet. Aufgenommen wurden sie deshalb
nicht.

Zur Einordnung der Zahlen: mit **kalter** Verbindung liegen dieselben Stimmen bei
233–254 ms statt 61–132 ms — der TLS-Handshake dominiert. Innerhalb eines Anrufs
mit dicht aufeinanderfolgenden Sätzen ist die Verbindung warm, nach einer längeren
Hörpause nicht mehr.

Der Katalogtest prüft neu auf doppelte Modell- und Stimm-IDs. Bei wachsenden
Listen ist das Copy-Paste-Duplikat der wahrscheinlichste Fehler, und im Dropdown
stünde derselbe Eintrag dann zweimal.


## [0.8.10] – 2026-08-19

### Untersucht

**„Rauschen und Klacken" auf den Azure-Testanrufen: Es ist die Ambience, und sie
arbeitet korrekt.** Fünf Anrufe auf die Azure-DDI zeigten durchgehend einen
Grundpegel von 112–132 RMS. Die pur erzeugte `office`-Ambience bei `volume: 0.25`
liegt bei **124,8 RMS (−48,4 dBFS)** — die Aufnahmen treffen die Referenz auf die
Nachkommastelle. Ein Kontrollanruf ohne Ambience liegt bei 7 RMS (−73,4 dBFS),
also 25 dB darunter; das ist das Komfortrauschen.

Das Klacken ist das Tippen des Presets („Büroatmosphäre (Raumklang + Tippen)"):
im Hochtonband gemessen 15 Schübe je Minute, einer alle 4,0 s, je 3–4 Anschläge
im Abstand von 180 ms — exakt das dokumentierte Raster. Verstärkt wird beides
dadurch, dass `AmbienceMixer.mix()` mit **konstantem Gain** auch auf die
Sprachframes addiert: bei 0.25 sind das −38,9 dBFS, praktisch der Pegel des
Median-Sprachsignals. Auf einer Freisprecheinrichtung hebt die automatische
Verstärkungsregelung das Bett in Sprechpausen zusätzlich an.

**Die naheliegende Vermutung war falsch und ist widerlegt.** Ein HTTP-Provider
wie Azure erzwingt an jeder Satzgrenze einen möglichen Queue-Underrun, und
`MediaSession.tick()` blendet bei Underrun aus und beim nächsten Frame wieder
ein — das war der erwartete Klick-Mechanismus. Gemessen zeigt Azure jedoch **49
Amplitudeneinbrüche je Sprechminute gegen 58 bei Aura**, ist also eher ruhiger,
und das Modulationsspektrum der Hüllkurve hat bei 50 Hz keinen Ausschlag, es gibt
also kein Artefakt im 20-ms-Rahmenraster. Der Head-of-Line-Emitter aus 0.8.0 hält
die Queue gefüllt.

**Der Abschaltversuch hat keinen der Anrufe erreicht.** Der Agent wurde zuletzt
um 14:08 gespeichert, alle fünf Anrufe liefen danach, `updatedAt` bewegte sich
nicht mehr. Der Code-Pfad ist in Ordnung: `agentResolver` liest pro Anruf frisch
ohne Cache, der Mixer entsteht pro Anruf, und das Agentenformular schreibt
`ambience.enabled` korrekt in den Body.

### Added

- **Sprechtempo für Azure** (`speak.speed`). Der Adapter baute sein SSML bisher
  ohne `<prosody>`, das Feld lief also ins Leere — im Katalog stand Azure
  konsequenterweise mit leeren `knobs`, die UI bot gar keinen Regler an. Jetzt
  wird der Multiplikator als `<prosody rate>` gesetzt (1.2 → `+20%`), auf 0,5–2,0
  geklemmt und beim Klemmen einmal je Anruf gewarnt. Gemessen an Seraphina,
  gleicher Satz: 8,35 s ohne Angabe, 7,64 s bei 1.1, 6,94 s bei 1.2, 6,21 s bei
  1.3. Ohne gesetztes Tempo bleibt das SSML unverändert schlank — ein
  wirkungsloses `rate='+0%'` wäre nur zusätzliche Angriffsfläche im XML.

### Notes

Als Rückstand notiert: **Ambience-Ducking** (`docs/backlog.md`, 2e). Dass das
Bett unter der Sprache in voller Lautstärke weiterläuft, ist der eigentliche
Grund, warum 0.25 zu viel ist — mit Ducking wäre derselbe Wert als *Pausenpegel*
unproblematisch. Das Steuersignal liegt in `MediaSession.tick()` bereits vor
(TTS-Frame oder nicht), die Hüllkurve gehört in den `AmbienceMixer`. Bis dahin
hilft `volume` auf 0.10–0.12 oder das Preset `room` (gleiches Bett ohne Tippen).


## [0.8.9] – 2026-08-18

### Gemessen

**Der Einkaufspreis pro Gesprächsminute steht — auf 46 echten Live-Dev-Gesprächen
(77,3 Gesprächsminuten, Ø 101 s, Ø 6,8 LLM-Turns).**

| Komponente | Modell | $/Gesprächsmin | Anteil |
|---|---|---:|---:|
| STT | Deepgram `flux-general-multi` | 0,0078 | 28 % |
| LLM | `bedrock/claude-haiku-4-5@eu-central-1` | 0,0060 | 22 % |
| TTS | Azure `de-DE-SeraphinaMultilingualNeural` | 0,0141 | 50 % |
| **Summe** | | **0,0279** | |

Rund **$0,047 pro Anruf** bei Ø 101 s, ohne SIP-Trunk-Minuten. Mit ElevenLabs
statt Azure wären es $0,115/min — Faktor 4,1 auf die Gesamtrechnung, Faktor 7,2
auf den TTS-Anteil allein.

Zwei Werte, die nicht geschätzt sind: **2,75 Zeichen/Token für Deutsch** (gegen
die Bedrock-Abrechnung gemessen; Englisch liegt bei ~4 — dieselbe Zeichenzahl
kostet auf Deutsch also ein Drittel mehr Tokens), und der Requesty-Realpreis
**$1,10/$5,50 pro 1M** statt der Anthropic-Liste $1,00/$5,00: `eu-central-1`
kostet 10 % Regionsaufschlag, den die EU-Residency wert ist.

### Added

- **Prompt-Caching für Claude-Modelle** (`LLM_PROMPT_CACHE`, Default `true`). Der
  System-Prompt geht pro Anruf rund sieben Mal erneut raus — einmal je
  Agenten-Antwort. Ein `cache_control`-Breakpoint auf der System-Message macht
  daraus einen einmaligen Schreibvorgang und danach Cache-Treffer zu ~10 % des
  Inputpreises. Live gegen Bedrock gemessen, 23.508 Zeichen System-Prompt:
  $0,011669 ohne Caching, $0,014299 beim Anlegen, **$0,002296 bei jedem
  weiteren Aufruf** — Faktor 5,1, amortisiert ab dem zweiten Aufruf.

  Der Breakpoint sitzt bewusst auf der System-Message: Anthropic rendert
  `tools` → `system` → `messages`, damit sind Tool-Definitionen und System-Prompt
  in einem Zug gecacht. Die wachsende Historie danach bleibt ungecacht — sie
  ändert sich pro Turn ohnehin und ist mit ~550 Tokens klein gegen einen großen
  System-Prompt.

- **LLM-Nutzung aus dem Stream** (`LlmStreamResult.usage`): Prompt-, Completion-,
  Cache-Treffer- und Cache-Schreib-Tokens. Requesty sendet sie im letzten
  SSE-Event ohne `stream_options` mit — der Request-Shape bleibt unverändert.
  Ohne diese Zahlen wäre das Caching in Produktion nicht überprüfbar.

### Notes

**Prompt-Caching wirkt erst ab einer Mindestlänge, und das ist kein Fehler.**
Claude cacht ein Präfix erst ab einer modellabhängigen Grenze — Haiku 4.5
braucht 4096 Tokens, das sind rund 11.300 Zeichen deutscher Prompt. Darunter
ignoriert die API den Block **stillschweigend**: kein Fehler, kein
Schreibaufschlag, aber auch keine Ersparnis. Live gegengeprüft mit 4003 Tokens
(knapp darunter) — Kosten mit und ohne `cache_control` identisch.

Weil ein zu früh gesetzter Breakpoint also nichts kostet, ist die Mindestlänge
bewusst **kein Gate**, sondern speist nur die Diagnose: liegt der Prompt
darunter, sagt die Engine das einmal je Anruf im Log, statt den ausbleibenden
Effekt zum Rätsel zu machen. Mit den heutigen Agenten-Prompts (1.036 Zeichen)
ist das der Normalfall — der Hebel entsteht erst mit größeren Wissensbasen.

Die **harte** Grenze ist stattdessen das Modell: `cache_control` ist eine
Anthropic-Eigenheit, und einem OpenAI- oder Gemini-Modell statt eines Strings
ein Content-Block-Array zu schicken, riskiert einen 400 mitten im Anruf. Nicht-
Claude-Modelle bekommen den Request deshalb unverändert — im Test und live gegen
`openai/gpt-4.1-mini` gegengeprüft.

Ohne Caching überholt der LLM ab etwa 12.000 Zeichen System-Prompt den TTS-Anteil
als teuerster Posten (bei 60.000 Zeichen: $0,101/min allein für den LLM). Mit
Caching bleibt er auch dort unter dem TTS-Anteil ($0,030/min).


## [0.8.8] – 2026-08-18

### Gemessen

**Alle sieben Engines stehen jetzt mit Zahlen da — der Block ist damit
vollständig.**

| Provider | TTFA | $/Minute | Verarbeitung | Deutsch |
|---|---|---|---|---|
| ElevenLabs Flash v2.5 | 138 ms | $0,115 | 🟡 US | ✅ |
| Deepgram Aura-2 | 159 ms | $0,027 | 🟢 EU-Endpoint | ✅ |
| Deepgram Flux TTS | 162 ms | $0,032 | 🟢 EU-Endpoint | ❌ nur Englisch |
| **Azure Neural TTS** | **191 ms** | **$0,013** | 🟢 **EU-Region** | ✅ |
| Fish Audio S2.1 Pro | 324 ms | $0,016 | 🔴 Drittland | ✅ |
| Mistral Voxtral | 461 ms | $0,016 | 🟢 EU | ⚠️ nur geklont |
| Speechify Simba 3.0 | 670 ms | $0,010 | 🟡 US | ✅ |

**Der `sample_rate`-Spike aus dem Plan ist beantwortet: Fish akzeptiert 8000 Hz.**
Gegengeprüft mit demselben Satz bei 8000, 16000 und 44100 Hz — die Bytezahlen
skalieren mit der Rate (1,76 s / 2,09 s / 1,95 s Sprache). Bei einem ignorierten
Parameter wäre dreimal dieselbe Datenmenge gekommen. Es wird also nicht resampelt,
und Fish war mit 324 ms schneller als erwartet.

### Added

- **`s2.1-pro-free` im Katalog.** Fish stellt dasselbe S2.1-Pro-Modell kostenfrei
  bereit — verifiziert, das API-Guthaben bleibt nach einem Aufruf unverändert.
  Es unterliegt allerdings einer Fair-Use-Policy und gibt laut Fish **keine Zusage
  zu Uptime oder TTFA**; für einen Telefonagenten ist das die falsche Grundlage,
  deshalb bleibt `s2.1-pro` der Default.


## [0.8.7] – 2026-08-18

### Fixed

**Ein gescheiterter WebSocket-Handshake nennt jetzt seine Ursache.** Scheitert
schon der Verbindungsaufbau, meldet die `ws`-Bibliothek nur
`Unexpected server response: 402` — die Erklärung steht im Antwort-Body und blieb
bisher verborgen. Der Fish-Adapter liest ihn aus, sodass im Log die Meldung des
Dienstes selbst erscheint.

Konkret bei Fish Audio: *„Insufficient API credit. API credit is managed
independently from platform credit."* Genau das war der Stolperstein — Fish führt
**zwei getrennte Guthabentöpfe**. Die Credits des Weboberflächen-Plans (im Konto
sichtbar) gelten nicht für die API; deren Guthaben wird unter
fish.audio/app/developers separat aufgeladen. Die Konto-Endpunkte zeigen es
unmissverständlich: `/wallet/self/package` meldet 8000 Credits,
`/wallet/self/api-credit` meldet `0.000000` bei `cumulative_top_up: 0`.

Der `sample_rate: 8000`-Spike bleibt damit offen — der Adapter kommt ohne
API-Guthaben nicht bis zur Synthese.


## [0.8.6] – 2026-08-18

### Gemessen

**Azure Neural TTS löst den Zielkonflikt, an dem alle anderen scheitern: 199 ms
Time-to-First-Audio bei $0,013 je gesprochener Minute, deutsche Stimmen und
Verarbeitung in `westeurope`.**

Das war die offene Frage seit 0.8.2, und sie fällt deutlicher aus als erwartet.
Azure liegt nur 60 ms hinter ElevenLabs — dem schnellsten Anbieter im Feld — und
kostet dabei rund ein Zehntel. Die Sorge vor hohem TTFB, die den Adapter überhaupt
erst als Wagnis erscheinen ließ, bestätigt sich nicht; die Forenberichte dazu
betrafen offenbar andere Regionen oder Aufrufmuster.

Vollständiger Stand (`npm run tts-bench`, drei deutsche Sätze, frische Verbindung
je Satz, von Deutschland aus):

| Provider | TTFA | $/Minute | Verarbeitung |
|---|---|---|---|
| ElevenLabs Flash v2.5 | 139 ms | $0,123 | 🟡 US (EU nur Enterprise) |
| **Azure Neural TTS** | **199 ms** | **$0,013** | 🟢 **EU-Region** |
| Deepgram Aura-2 | 213 ms | $0,026 | 🟢 EU-Endpoint |
| Deepgram Flux TTS | 214 ms | $0,034 | 🟢 EU-Endpoint, nur Englisch |
| Mistral Voxtral | 482 ms | $0,017 | 🟢 EU |
| Speechify Simba 3.0 | 667 ms | $0,009 | 🟡 US |

Audio gegengeprüft: `de-DE-KatjaNeural` liefert sauberes 8-kHz-PCM (RMS 2745,
Peak 18173, kein Clipping, kein Container-Header).

Damit ist die Ausgangsfrage dieses Blocks beantwortet — ein DSGVO-konformer
Ersatz für ElevenLabs mit brauchbarer Latenz und deutschen Stimmen existiert, er
heißt Azure und nicht Voxtral.


## [0.8.5] – 2026-08-18

### Added

- **Deutsche Speechify-Stimmen im Katalog**, live abgerufen statt geraten: der
  Anbieter führt 983 Stimmen, davon 44 mit `de-DE` für simba-3.0. Im Manifest
  steht eine Auswahl inklusive der `-agent`-Varianten, die ausdrücklich für
  Sprachassistenten gebaut sind. Die vollständige Liste holt
  `GET /api/tts/voices?provider=speechify&model=simba-3.0` über den Cursor.

### Gemessen

**Speechify ist der günstigste und zugleich mit Abstand der langsamste Anbieter:**
709 ms bis zum ersten Ton, mit Ausreißern bis 2,1 s — rund das Fünffache von
ElevenLabs. Bei $0,010 je gesprochener Minute gegenüber $0,116 ist das ein
Kompromiss, aber für einen Telefonagenten auf der falschen Seite.

Der Adapter selbst arbeitet: deutsche Stimme, sauberes 8-kHz-PCM, kein
Container-Header.

**Fish Audio antwortet mit HTTP 402** (Payment Required) — das Konto hat kein
Guthaben. Damit bleibt die offene Frage aus 0.8.4 offen: ob `sample_rate: 8000`
bei `format: "pcm"` akzeptiert wird. Der Adapter steht, der Beweis fehlt.


## [0.8.4] – 2026-08-18

### Added

**Speechify Simba und Fish Audio S2 — damit sind alle sieben Engines aus dem
Manifest gebaut.**

**Speechify** sitzt auf der HTTP-Basisklasse: ein `POST /v1/audio/stream` je Satz,
`pcm_8000` nativ, also kein Resampling. Default ist `simba-3.0` und nicht das
neuere `simba-3.2` — **nur 3.0 spricht Deutsch**. Die dokumentierten
`*_32`-Stimmen gehören zu 3.2 und damit zu Englisch; für 3.0 gibt es keine
öffentliche Liste, deshalb steht im Katalog bewusst **keine** deutsche Stimme und
das Freitextfeld trägt, bis jemand mit Schlüssel `GET /v1/voices` abruft.
Erfundene Stimmnamen hatten wir schon.

Falls Speechify statt rohem PCM doch einen WAV-Container liefert, schneidet der
Adapter den RIFF-Header ab. Die Prüfung kostet nichts und entfällt still, wenn
kein Header kommt — mit Header wären es 44 Byte Kopfdaten im Sprachkanal, am
Satzanfang als Knacks hörbar.

**Fish Audio** fällt zweimal aus der Reihe: Es serialisiert mit **MessagePack**
statt JSON (`@msgpack/msgpack`, die einzige neue Laufzeitabhängigkeit des ganzen
Blocks) und rechnet in **UTF-8-Bytes** statt Zeichen ab — deutsche Umlaute und ß
kosten doppelt. `metrics.ttsCharacters` trägt dort deshalb Bytes; eine
zeichengenaue Zahl wäre für die Kostenrechnung schlicht falsch. Wie ElevenLabs
kennt Fish kein serverseitiges Clear, also trennt `clear()` hart und der nächste
Satz verbindet lazy neu — samt erneutem `start`-Event, sonst wüsste der Server
weder Stimme noch Format.

**Fish ist doppelt gesperrt.** Der Anbieter wird aus China betrieben, ohne
Angemessenheitsbeschluss, und Anrufaudio ist personenbezogen. Ohne
`FISH_AUDIO_ENABLED=true` erscheint er weder im Panel noch baut ihn der Anruf.
Der Katalog-Endpoint prüft die Freigabe mit — ein Provider, den man wählen kann,
der aber still auf Aura zurückfiele, wäre schlimmer als gar keiner.

### Changed

- `speak` kennt drei neue Felder für den Fish-Feinschliff: `temperature`, `topP`
  (je 0–1 mit Validator) und `latencyMode` (`low`/`balanced`/`normal`, Default
  `low` — für Telefonie ist der Qualitätsgewinn der übrigen Stufen die
  Zusatzlatenz nicht wert). Sie kamen bewusst erst jetzt und nicht auf Vorrat in
  0.8.0: Felder, die kein Adapter liest, sind totes Gewicht.

### Ungeprüft

Für Speechify und Fish lag kein Schlüssel vor — beide Adapter sind gegen die
dokumentierten Wire-Formate gebaut, nicht gegen die laufende API. Nach den
Erfahrungen dieses Blocks (erfundene Voxtral-Stimmen, falsch verstandenes
`Flushed` bei Flux) ist das ausdrücklich ein Vorbehalt und kein Nebensatz. Der
konkreteste offene Punkt: ob Fish `sample_rate: 8000` bei `format: "pcm"`
akzeptiert. Die Doku nennt 44100 als Default und listet keine erlaubten Werte;
wird der Wert ignoriert, käme Audio in falscher Rate an — hörbar als zu schnelle
oder zu langsame Sprache.


## [0.8.3] – 2026-08-18

### Added

**Deepgram Flux TTS — und damit endlich ein ehrliches Barge-in.** Der eigentliche
Gewinn ist nicht die Latenz (gemessen 201 ms, zwischen Aura und ElevenLabs),
sondern eine Lücke, die seit jeher offenstand: `runAssistantTurn` schreibt den
Assistententurn erst nach vollständigem LLM-Stream in die Historie, und bei
Barge-in kehrt der `catch` vorher zurück — **der halbe Satz, den der Anrufer
tatsächlich gehört hat, fehlte danach komplett**. Das Modell wusste nicht, was es
gesagt hatte, als es unterbrochen wurde, und wiederholte es gern.

Flux ersetzt Auras `Clear` durch `Interrupt` und meldet mit `SpeechInterrupted`
zurück, was wirklich gesprochen wurde. Das neue `interrupted`-Event trägt den Text
in die Historie und ins DB-Transkript — bewusst ohne Generations-Gate, denn
gesprochen ist gesprochen, unabhängig vom Abbruch.

Damit die Meldung stimmt, reicht der callHandler jetzt `pendingPlayoutMs` bis in
`cancelActiveTurn()` durch (`VoiceSessionOptions`, ein Callback statt einer
Referenz — die Session bekommt eine Zahl, keinen Zugriff auf die Medienstrecke).
Ohne diese Korrektur meldete der Server ein zu langes `text_spoken`: Zwischen
gesendetem und gehörtem Audio liegt der Playout-Puffer, bei langen Sätzen mehrere
Sekunden. Die Historie behauptete dann Sätze, die nie zu hören waren — schlechter
als gar keine Kürzung. Live geprüft: mit korrigiertem Offset liefert der Server
genau den gehörten Ausschnitt.

Im Voice-Agent-Pfad ist Flux ein einzelnes Feld — `version: "v2"` neben dem
`flux-*`-Modellnamen.

### Fixed

Zwei Abweichungen zur Dokumentation, die erst gegen die echte API auffielen:

- **`Flushed` ist NICHT das Turn-Ende.** Anders als bei Aura bestätigt es nur den
  Eingang der Flush-Anforderung — das Audio beginnt danach (gemessen: `Flushed`
  bei +1229 ms, erstes Audio bei +1306 ms). Wer darauf `flushed` emittiert,
  meldet das Turn-Ende, bevor der erste Ton läuft. Das Event hängt jetzt an
  `SpeechMetadata`, das laut Doku *und* Messung nach dem letzten Audioframe kommt.
- **Flux spricht erst nach `Flush`.** Ein `Speak` allein erzeugt nur
  `SpeechStarted` und wartet — anders als Aura, das sofort losläuft.

### Changed

- **Flux TTS steht auf 🟢 statt 🟡.** In 0.8.0 hatte ich es als vermutlich
  US-only eingestuft, weil Deepgram `/v2/speak` in seiner Regionsliste nicht
  aufführt. Live geprüft bedient `api.eu.deepgram.com` den Pfad aber sehr wohl —
  von Deutschland aus sogar schneller als global (113 ms gegenüber 159 ms). Für
  eine belastbare Zusage sollte man sich das von Deepgram bestätigen lassen,
  solange die Doku schweigt.
- Die Event-Map `TtsStreamEvents` liegt jetzt in `native/types.ts` bei der Naht
  statt in `ttsStream.ts`: `interrupted` kommt von Aura gar nicht, die Map gehört
  also nicht zu einer Implementierung. `ttsStream.ts` re-exportiert sie.
- `TtsStreamLike.clear()` nimmt optional `unplayedMs` entgegen. Optional, damit
  Aura, ElevenLabs, die HTTP-Basisklasse und die Test-Fakes zuweisbar bleiben.

**Einschränkung, die bleibt:** Flux TTS gibt es nur auf Englisch (sieben Stimmen).
Für die deutschen Bestandsagenten ist es damit nicht einsetzbar — der Wert liegt
vorerst in der Barge-in-Mechanik und in englischsprachigen Agenten.


## [0.8.2] – 2026-08-18

### Added

**Azure Neural TTS als vierte Engine.** Anlass war eine unbequeme Lücke: Von den
bisherigen Engines verarbeitet nur Voxtral in der EU — und dort gibt es keine
deutschen Preset-Stimmen, Deutsch geht nur über eine geklonte oder cross-lingual
gesprochene englische Stimme. Azure schließt genau das: gewachsener deutscher
Stimmkatalog **und** Verarbeitung in einer EU-Region (`westeurope`,
`germanywestcentral`), preislich gleichauf mit Voxtral und mit Commitment-Tarif
halb so teuer.

Der Adapter (`src/native/ttsAzure.ts`) sitzt auf der HTTP-Basisklasse aus 0.8.0 —
ein `POST /cognitiveservices/v1` je Satz mit SSML im Body. `raw-8khz-16bit-mono-pcm`
und `raw-16khz-16bit-mono-pcm` sind native Ausgabeformate, es wird also **nicht**
resampelt.

Zwei Dinge, die beim Bauen Aufmerksamkeit brauchten. Erstens das **XML-Escaping**:
Der Body ist SSML, und ein kaufmännisches Und aus der LLM-Antwort („Meyer & Sohn")
zerreißt das Dokument — Azure antwortet mit 400, der Satz fällt stumm aus. Zweitens
der **Stimmkatalog**: Azure führt über 600 Stimmen, und nach den erfundenen
Voxtral-Presets steht im Manifest nur ein einziger, belegter Einstiegswert. Die
vollständige, regionsaktuelle Liste holt `GET /api/tts/voices?provider=azure` live
bei Azure ab; das Freitextfeld nimmt jeden Namen entgegen, auch Custom Neural Voices.

Wie bei Aura **ist** der Stimmname das Modell (`de-DE-KatjaNeural`) — er steht
deshalb in `speak.model`, nicht in `speak.voice`.

### Bewusst nicht gebaut

**Kein WebSocket-v2-Pfad.** Nur der kann Text streamen (Tokens direkt in den Socket
statt auf Satzgrenzen zu warten), aber Microsoft unterstützt ihn ausschließlich in
den SDKs für C#, C++ und Python; für Node gibt es weder Feature noch öffentlich
dokumentiertes Wire-Format. Ein Nachbau wäre geraten statt spezifiziert — alle
bisherigen Integrationen hatten dokumentierte Protokolle. Erst messen, dann
entscheiden, ob der Aufwand sich lohnt.

**Die Latenz ist noch ungemessen**, weil hier kein Azure-Schlüssel vorlag. Der
Provider steht im Messharness (`npm run tts-bench`) bereits mit drin — sobald
`AZURE_SPEECH_KEY` gesetzt ist, steht die Zahl neben den anderen dreien. Fremdmessungen
sehen Azure bei 150–250 ms; Microsoft selbst nennt in der eigenen Doku keine Zahl,
sondern nur die Mess-API dafür.


## [0.8.1] – 2026-08-18

### Changed

**Die ElevenLabs-Basis-URL gilt jetzt systemweit — `ELEVENLABS_BASE_URL`.**
Bis 0.8.0 war sie halb konfigurierbar: die native Kaskade las `NATIVE_TTS_ELEVEN_URL`,
die Dritt-TTS-Durchreiche der Voice-Agent-API hatte `wss://api.elevenlabs.io/v1`
hartkodiert. Wer den einen Pfad umstellte, änderte am anderen nichts — und merkte es
nicht, weil beide Pfade dieselbe Stimme sprechen.

Anlass ist die **EU-Data-Residency von ElevenLabs**: Unter
`wss://api.eu.residency.elevenlabs.io/v1` liegt die Speicherung in der EU, zusammen mit
Zero Retention Mode auch die Verarbeitung. Damit lässt sich die Engine mit der besten
gemessenen Latenz (146 ms) DSGVO-konform betreiben, ohne sie zu ersetzen. Ein Schalter,
beide Pfade.

Der Default bleibt bewusst der globale Endpoint: Data Residency ist ein
Enterprise-Feature, ein normaler Account bekommt auf dem Residency-Host keine
Verbindung. Als Default würde die Variable jede Installation ohne Enterprise-Vertrag
beim ersten ElevenLabs-Anruf brechen. `NATIVE_TTS_ELEVEN_URL` bleibt als Alias gültig.

Die DSGVO-Einstufung für ElevenLabs steht damit im Panel und in der Doku auf
🟢 *mit* EU-Residency (ohne sie unverändert 🟡) — dieselbe Logik wie bei Deepgram.


## [0.8.0] – 2026-08-18

### Added

**Mistral Voxtral als dritte TTS-Engine — und ein Provider-Katalog, aus dem sich alles Weitere speist.**
Bis 0.7.x kannte das Projekt genau zwei Stimmen-Anbieter, und Modell wie Stimme waren
im Agenten-Panel reine Freitextfelder: keine Auswahl, keine Validierung, keine Aussage
darüber, wo Anrufaudio eigentlich verarbeitet wird. Neu ist das Manifest
`src/tts/catalog.ts` als einzige Quelle der Wahrheit — daraus stammen das Mongoose-Enum,
die Auswahlfelder im Panel, die DSGVO-Badges und die Doku-Tabellen. Ein siebter Provider
ist damit ein Katalogeintrag, kein neuer Zweig in vier Dateien. Der Katalog liegt als
`GET /api/tts/providers` unter dem Formular; er meldet nur, **ob** ein API-Key gesetzt
ist, nie seinen Wert.

Voxtral selbst spricht neun Sprachen inklusive Deutsch, kostet $0,016 je 1000 Zeichen
(rund ein Siebtel von ElevenLabs Flash/Turbo) und verarbeitet als einzige Engine im Feld
standardmäßig in der EU. Anders als Aura und ElevenLabs hält es keinen Socket offen,
sondern fährt einen HTTP-Request je Satz — die neue Basisklasse `native/ttsHttp.ts`
stellt dahinter dieselben Zusagen her, auf die der Orchestrator baut: Audio in
Auftragsreihenfolge (Head-of-Line-Emitter, damit ein vorgeholter Satz das Audio nicht
verschränkt), `flushed` erst wenn wirklich alles übergeben ist, und ein Barge-in, das
laufende Requests abbricht **und** Nachzügler stummschaltet, die schon im Reader lagen.

**Resampler (`src/audio/resample.ts`).** Voxtral gibt fest 24 kHz aus, die Telefonstrecke
fährt 8 kHz — und nacktes Dezimieren wäre keine Option gewesen: alles zwischen 4 und
12 kHz, also Zischlaute und Plosive, faltete sich zurück ins Sprachband und wäre als
metallisches Sirren hörbar. Die vorhandenen Filter im Medienpfad helfen dagegen nicht,
der DC-Blocker ist ein 6-Hz-*Hoch*pass. Jetzt läuft ein Polyphase-FIR mit
Fenster-Sinc-Prototyp (Cutoff 3600 Hz, ~96 Taps) davor; gemessen ist die Kurve bis 3 kHz
flach und bei 4 kHz bereits 48,7 dB unten. Der Filterzustand überlebt Chunk-Grenzen
inklusive eines halben Samples — ein Netzwerk-Chunk darf mitten in ein 16-Bit-Wort fallen.

**Voice-Cloning-API** (`/api/tts/voices`): auflisten, aus Referenzaudio klonen, löschen.
Voxtral klont zero-shot ab etwa drei Sekunden. Wichtig und in `docs/tts-provider.md`
ausführlich begründet: Das Referenzmaterial darf **nicht** aus ElevenLabs-Ausgaben
stammen — deren Nutzungsbedingungen untersagen, erzeugtes Audio als Eingabe für
Modelltraining oder konkurrierende Dienste zu verwenden. Sauber ist, aus derselben
Originalaufnahme neu zu klonen. Beim Anlegen wird immer eine Löschfrist mitgegeben
(`retention_notice`, Standard 30 Tage), denn die geklonte Stimme einer identifizierbaren
Person ist ein personenbezogenes Datum.

**Messharness (`npm run tts-bench`).** Die Herstellerangaben zur Latenz gehen weit
auseinander — Mistral nennt 70–90 ms, das ist aber reine Modellzeit; die API liefert
laut eigener Doku rund 0,8 s bis zum ersten Audio. Statt das zu glauben, schickt das
Harness dieselben deutschen Sätze durch jeden konfigurierten Provider und misst TTFA,
Audiodauer, Zeichen und Kosten. Provider ohne Key werden übersprungen statt still auf
Aura zurückzufallen. Ergänzend landen die Turn-Latenzen jetzt auch pro Anruf in der
Datenbank (`metrics.turnLatencyMs`, `turnThinkMs`, `turnTtsMs`, `turns` — Median über
alle Agenten-Turns); berechnet wurden sie schon immer, sie landeten bisher nur im Log.

**DSGVO-/EU-Residency-Einstufung** je Provider: als Badge direkt neben der Auswahl im
Panel und ausführlich in `docs/tts-provider.md`, inklusive der Empfehlung, für Deepgram
(STT wie TTS) den EU-Endpoint zu konfigurieren.

### Changed

- **Agenten-Panel: Modell und Stimme sind jetzt Auswahlfelder** statt Freitext, gespeist
  aus dem Katalog, mit Freitext-Ausweg für eigene und geklonte IDs. Das Formularmodell
  hält Modell und Stimme je Provider getrennt (`modelBy`/`voiceBy`), damit beim
  Umschalten kein Wert verlorengeht — die bisherige Sonderlösung mit zwei Feldern für
  eine Datenbankspalte hätte sich bei sechs Providern verzwölffacht. In der Datenbank
  landet unverändert nur der Wert des aktiven Providers.
- **Provider-Auswahl folgt dem Pfad.** Die Deepgram-Voice-Agent-API reicht nur eigene
  Stimmen und ElevenLabs durch; im Panel erscheinen deshalb nur Provider, die im
  gewählten `voiceProvider` auch laufen, mit Hinweiszeile statt ausgegrauter Option.
- **`buildNativeTts` ist eine Builder-Tabelle** (`src/native/ttsFactory.ts`) statt einer
  if/else-Kette im Orchestrator. Sechs Zweige mit identischer Form sind eine Matrix; der
  Fallback bleibt bewusst imperativ außerhalb der Tabelle, weil er die eigentliche
  Zusage ist: unvollständige Konfiguration fällt mit Warnung auf Aura zurück, ein Anruf
  scheitert nie an der TTS-Auswahl. Nebeneffekt: jeder Builder prüft seinen eigenen
  Modellstring, die providerübergreifende Heuristik `!model.startsWith("aura")` entfällt.
- Das `speak.provider`-Enum stammt jetzt aus dem Katalog und enthält — wie schon bei
  `voiceProvider` — bewusst nur **implementierte** Provider.
- **GlassKit auf 1.12.0 / 1.11.0 angehoben.** Beim Bau des Panels fiel auf, dass
  `glk-select` seine `<option>`-Kinder nur einmal übernahm — jeder Select mit dynamischer
  Liste (Provider je Pfad, Modelle und Stimmen je Provider) zeigte dauerhaft den ersten
  Stand. GlassKit hat das generisch in `base.js` behoben; der hiesige Zwischenfix ist
  wieder entfernt, `package.json` verlangt die reparierte Version.

### Fixed

- **Voxtral: falscher Feldname und erfundene Stimmen.** Gegen die echte API geprüft: die
  SSE-Deltas heißen `audio_data`, nicht `delta` — der Adapter las ins Leere und lieferte
  bei HTTP 200 null Audio. Und die 20 „Preset-Stimmen" aus der Doku-Recherche stammten aus
  dem Open-Weights-Repo; die Cloud-API kennt zehn, alle englisch, davon eine weibliche.
  Für einen deutschen Agenten heißt das: Voxtral braucht eine geklonte Stimme, die Presets
  sind ein Demo-Satz. Katalog korrigiert, PCM-Breite (float32 LE) ist jetzt verifiziert
  statt erkannt.
- **ElevenLabs meldet kein Turn-Ende.** Der reale `stream-input`-Endpoint sendet `isFinal`
  erst beim Verbindungsende, nicht nach `flush` — mit `auto_mode=true` wie `=false`. Der
  Kopfkommentar des Adapters behauptete das Gegenteil, der Fake-Server im Test hat es nie
  auffallen lassen. Produktiv folgenlos (einziger Verbraucher wäre `agentAudioDone`, und
  das Auflegen wartet über `MediaSession.pendingMs()`), aber dokumentiert — und das
  Messharness erkennt das Ende jetzt über ein Ruhefenster statt über `flushed`.
- **Nativ-only-Provider im Deepgram-Voice-Agent-Pfad ließen den Anruf scheitern.**
  `buildSpeak` fiel für alles außer `eleven_labs` direkt in den Deepgram-Zweig durch und
  hätte ein fremdes Modell (etwa `voxtral-mini-tts-latest`) als Deepgram-Modellnamen in
  die Settings-Message geschrieben — die Voice-Agent-API lehnt das ab. Vor der
  Provider-Erweiterung konnte der Fall nicht auftreten, mit ihr wäre er sofort da
  gewesen. Jetzt greift derselbe Warn-und-Fallback-Weg wie bei unvollständiger
  ElevenLabs-Konfiguration.
- **Der Admin-Error-Handler machte aus Client-Fehlern ein opakes 500.** Fastify-eigene
  Fehler (Schema-Validierung, 404, Payload zu groß) tragen ihren Status selbst, wurden
  aber verschluckt: Aufrufer erfuhren nicht, was an ihrer Anfrage falsch war, und jeder
  Tippfehler landete als Fehler im Server-Log. Client-Status im 4xx-Bereich werden jetzt
  durchgereicht.


## [0.7.5] – 2026-07-27

### Fixed
- **Der Mattglas-Effekt der Tab-Bar hatte nie gewirkt.** GlassKit setzt dort ein
  `backdrop-filter`, aber gleich zwei Dinge auf unserer Seite haben es neutralisiert: die
  Zentrierung per `transform: translateX(-50%)` und der `view-transition-name` auf dem Host.
  Beide isolieren das Element, sodass der Filter nichts mehr zu verwischen hat. Die
  Zentrierung läuft jetzt über Flexbox, und die Bar bekommt keinen Transition-Namen mehr
  (sie sieht über alle Views gleich aus; nur der aktive Reiter blendet weich statt hart um).
  Verifiziert mit einem Headless-Chrome-Vergleich beider Varianten.
- **Login-Bildschirm zeigte noch das „VOH"-Textbadge** statt des App-Icons.

### Changed
- **Die Tab-Bar behält bewusst die GlassKit-Farben.** Ein Zwischenstand hatte sie eigens
  eingefärbt — das war die Behandlung des Symptoms: Sie wirkte nur deshalb zu durchsichtig,
  weil der Blur fehlte. Mit funktionierendem Filter tragen `--gl-surface-3`/`--gl-surface-1`
  wie im Showcase des Design-Systems.

## [0.7.4] – 2026-07-27

### Added
- **Agent duplizieren** — Symbol oben rechts im Agent-Formular (nur bei gespeichertem Agenten).
  Legt die komplette Konfiguration als neuen Agenten an und öffnet ihn direkt. Bewusst **nicht**
  mitkopiert werden `targetNumbers` und `widget.exten`/`widget.key`: Rufnummer und Pseudo-Durchwahl
  identifizieren einen Agenten eindeutig — bei zwei Agenten auf derselben DDI landete ein Anruf
  beim erstbesten Treffer, und welcher das ist, wäre Zufall. Die Kopie startet daher ohne Nummer.

### Fixed
- **Kopfzeile lag unter der Dynamic Island** (installierte App auf iOS). `viewport-fit=cover` legt
  die Seite bewusst unter Notch und Home-Indicator, aber `.app-head` hatte ein festes
  `padding: 16px 16px 0` — nur die Tab-Bar berücksichtigte `safe-area-inset-bottom`. Jetzt gibt es
  `--safe-t/r/b/l` für alle vier Seiten; im **Querformat** wandert die Aussparung an den Rand,
  weshalb auch links/rechts zählen. `max(16px, …)` hält am Desktop die gewohnten Abstände.
- **`100dvh` statt `100vh`** — auf mobilen Browsern erzeugte die volle Viewport-Höhe einen
  Überhang, sobald die Adressleiste ein- und ausfuhr.

### Changed
- **Fensterleiste der installierten App nicht mehr orange.** `theme-color` stand auf der
  Logo-Akzentfarbe `#f5a623`; bei Chrome färbt das die komplette Titelleiste, und ein oranger
  Balken über der petrolfarbenen Oberfläche wirkt wie ein Fremdkörper. Jetzt der App-Hintergrund
  (`#0e2530` dunkel, `#e8ecf1` hell, beides GlassKit-Tokens), inkl. Splash-Screen-Farbe im
  Manifest. Zwei `media`-Tags decken die OS-Einstellung ab; beim manuellen Theme-Wechsel in der
  App zieht `applyTheme` die Farbe nach. Orange bleibt Akzent, wo es auf kleiner Fläche wirkt.
- **App-Icon statt „VOH"-Textbadge** in der Kopfzeile.

## [0.7.3] – 2026-07-27

### Fixed
- **Ein Anruf mit Sprach-Prior kostete einen LLM-Call zu viel.** Bei vorbelegter Sprache blieb
  der Erkennungs-Zweig aktiv, solange der Bestätigungs-Lauf lief — jeder weitere Anrufer-Turn
  setzte damit `rerunPending` und stieß nach dem Ergebnis einen zweiten Lauf an, der nichts
  Neues erbrachte. Im Live-Log als zwei „Ansagen lokalisiert" pro Prior-Anruf sichtbar (ohne
  Prior nur eins). Die Bestätigung braucht jetzt genau einen Lauf; ohne Prior bleibt der Rerun
  erhalten, weil dort mehr Kontext echter Gewinn ist.

## [0.7.2] – 2026-07-27

### Fixed
- **Vorübersetzungen wurden nie gespeichert** (`Mongoose maps do not support keys that contain
  "."`). Die Einträge lagen als Mongoose-`Map`, deren Keys keine Punkte enthalten dürfen —
  unsere Pool-Keys heißen aber genau `filler.0`, `idle.1`, `tool.<name>`. Der Fehler trat erst
  im Update-Cast zur Laufzeit auf, nicht beim Anlegen des Dokuments, und blieb deshalb bis zum
  ersten Live-Anruf unsichtbar: Der Katalog wurde übersetzt, der Write scheiterte, der Agent
  fiel stumm auf die Standardsprache zurück. Die Einträge liegen jetzt als **Array** mit
  explizitem `key`-Feld — damit existiert die Einschränkung strukturell nicht mehr.
  Bestehende Daten sind nicht betroffen (es wurde nie etwas geschrieben).

### Changed
- **Aktiviertes Anrufer-Gedächtnis ohne `CALLER_PROFILE_SECRET` warnt jetzt** (einmal pro
  Prozess). Vorher blieb es stillschweigend wirkungslos — wer den Schalter am Agenten setzt und
  das Secret vergisst, sucht den Fehler sonst beim Feature statt bei der Konfiguration.

## [0.7.1] – 2026-07-27

### Changed
- **Status-Abschnitt aus beiden READMEs entfernt.** Er zählte die Features ein zweites Mal auf,
  war inhaltlich veraltet (nannte 112 Tests, es sind 263) und stand optisch quer zum Rest. Was
  er sagte, steht besser in der Feature-Liste; die Roadmap-Zeile am Ende steht im
  [Backlog](docs/backlog.md).
- **Erster Feature-Bullet nennt keinen Provider mehr.** „call answering & natural voice dialogue
  (Deepgram Voice Agent)" nahm dem direkt folgenden Bullet die Aussage weg — dort steht, dass die
  Voice-Plattform hinter einer neutralen Schnittstelle austauschbar ist. Jetzt: „answers calls
  over SIP and holds a natural voice conversation".

## [0.7.0] – 2026-07-27

### Added
- **Begrüßung in der Sprache des Anrufers.** Die Begrüßung geht raus, bevor der Anrufer ein
  Wort gesagt hat — die Laufzeit-Lokalisierung aus 0.6.26 kommt dafür grundsätzlich zu spät,
  egal wie schnell sie ist. Der Agent merkt sich deshalb nach dem Gespräch die bestätigte
  Sprache je Rufnummer und begrüßt beim nächsten Anruf direkt in dieser Sprache. Opt-in pro
  Agent (`callerMemory.language`), zusätzlich `CALLER_PROFILE_SECRET` nötig. Wirkt über den
  aufgelösten Agenten und damit für **beide** Provider ohne Provider-Code.
- **Vorübersetzte Ansagen (`agentTranslations`).** Der Ansagen-Katalog wird außerhalb des
  Anrufs übersetzt — inklusive Greeting, das die Laufzeit-Übersetzung nie erreichen konnte.
  Zur Laufzeit ist es ein Map-Lookup. Erzeugt wird nach dem Speichern eines Agenten, nach
  einem Anruf in einer noch unbekannten Sprache und auf Knopfdruck im Admin.
- **Jede Übersetzung ist an ihren Quelltext gebunden.** Jeder Eintrag trägt den Hash seines
  Originals; passt der nicht mehr, gilt er als veraltet und wird nicht ausgespielt — egal ob
  über Admin-UI, API, Seed-Script oder direkt in der Datenbank geändert wurde. Es gibt bewusst
  keinen Lösch-Hook, der genau einen Fall vergessen könnte. Bis die Neuübersetzung durch ist,
  spricht der Agent die Standardsprache: lieber deutsch als veraltet-englisch.
- **`agent.contentLanguage`** — die Sprache, in der Begrüßung und Ansagen *verfasst* sind.
  Bislang gab es dafür kein Feld: `agent.language` ist die STT-Sprache und bei `"multi"` ohne
  Aussage über den Katalog, weshalb das Modell die Ausgangssprache bei **jedem** Anruf erraten
  musste. Leer = wird beim Speichern aus Begrüßung und System-Prompt erkannt (Stopwort-Scorer,
  kein LLM-Call) und eingetragen; ein gesetzter Wert wird nie überschrieben.
- **Admin: „Übersetzte Ansagen ansehen…"** zeigt je Sprache Original und Übersetzung
  untereinander, markiert veraltete Einträge und erlaubt das Neuerzeugen. Ein fehlender Eintrag
  wird als Lücke angezeigt statt weggelassen — ein Übersetzungs-Fehlschlag wie in 0.6.28 wäre
  damit sichtbar gewesen, statt nur im Requesty-Log zu stehen.
- **Metriken** `greetingLanguage`, `priorSource` und `priorConfirmed` je Anruf. Ohne sie ließe
  sich nicht beurteilen, ob der Prior überhaupt trägt.

### Changed
- **Der Lokalisierungs-Prompt bekommt die Ausgangssprache genannt** statt sie erraten zu lassen.
  Das Pflichtfeld `catalogLanguage` in der Antwort **bleibt** — nicht wegen des Werts, sondern
  weil der erzwungene Zwischenschritt vor dem Formulieren den 0.6.28-Fix trug. Aus „erkenne"
  wird „bestätige"; weicht die Antwort ab, wird gewarnt.
- **Der `CallLocalizer` kann vorgewärmt starten** (`preload`). Bei vorbelegter Sprache läuft die
  Erkennung trotzdem an — sie liefert die Anredeform, die eine statische Vorübersetzung nicht
  kennen kann — und ein einzelner Scorer-Widerspruch schaltet sofort um, ohne auf das LLM zu
  warten.

### Security
- Rufnummern im Anrufer-Gedächtnis werden als **HMAC** abgelegt, nie im Klartext; ein
  TTL-Index lässt Profile nach `CALLER_PROFILE_TTL_DAYS` verfallen. Ohne
  `CALLER_PROFILE_SECRET` bleibt das Gedächtnis vollständig aus — bewusst kein Fallback auf
  `ADMIN_SESSION_SECRET`. Gespeichert wird ausschließlich die Sprache: Eine Rufnummer ist keine
  Person, und was bei der Sprache ein Schönheitsfehler ist, wäre bei inhaltlichen Erinnerungen
  eine Datenpanne. Web-Anrufe, interne Durchwahlen und unterdrückte Nummern bekommen kein Profil.
- **Bestätigung und Widerspruch zählen verschieden.** Wer auf Englisch begrüßt wird, antwortet
  eher auf Englisch — auch wenn ihm Deutsch lieber wäre. Eine Bestätigung zählt daher nur hoch,
  ein Widerspruch überschreibt sofort. Aus einer Fehlzuordnung kommt man mit einem einzigen
  Anruf wieder heraus; dasselbe entschärft geteilte Anschlüsse.

## [0.6.30] – 2026-07-26

### Fixed
- **Tool-Fortsetzungen nach einem Filler wurden nicht mehr latenzgemessen.** `speakFiller`
  unterdrückt den `agentStartedSpeaking`-Emit, damit die Filler-Ansage die A/B-Latenzzahlen
  nicht verfälscht — das galt bisher aber für den Rest des Turns, sodass ausgerechnet die
  langsamen Runden (die mit Filler) gar keine Messung mehr hatten. Die Messung wird jetzt
  nach der Tool-Antwort neu scharf geschaltet: `total` bleibt bewusst die volle Wartezeit
  des Anrufers ab seinem Sprechende (inklusive Tool), `ttt`/`tts` werden für die
  Fortsetzungsrunde neu genommen statt veraltete Werte der ersten Runde zu zeigen. Die
  Log-Zeile trägt dann `afterFiller: true`, damit diese Turns beim A/B-Vergleich getrennt
  ausgewertet werden können.

## [0.6.29] – 2026-07-26

### Changed
- **Der Timer-Filler wird jetzt geloggt** (`Filler-Ansage` mit Text, auslösenden Tools und
  Wiederholungs-Flag). Bisher war ausgerechnet das schwerer zu beobachtende der beiden
  Ansagen-Features nur im Transkript sichtbar, während die Stille-Ansage protokolliert wurde.
- **`Stille-Ansage` nennt die Eskalationsstufe** (`stage: "1/2"`). Aus dem Log allein war
  vorher nicht erkennbar, welche Stufe gerade lief — nötig, um `idlePrompts.timeoutMs`
  sinnvoll einzustellen.
- **Tool-Aufrufe loggen ihr Ende mit Dauer** (`FunctionCall fertig` mit `ok` und `ms`). Die
  Tool-Dauer ist die Größe, an der `fillers.delayMs` ausgerichtet wird; bisher stand nur der
  Start im Log.

## [0.6.28] – 2026-07-26

### Fixed
- **Ansagen blieben bei englischen Anrufern deutsch.** Im Live-Test antwortete das
  Lokalisierungs-Modell mit `{"language":"en"}` **ohne** `phrases` — Sprache erkannt,
  Übersetzung verweigert. Ursache war der Prompt selbst: Er bot mit „spricht der Anrufer
  dieselbe Sprache wie der Katalog, antworte NUR mit dem Code" eine billige Abkürzung an,
  und gpt-4.1-mini nahm sie bei englischen Anrufern reproduzierbar auch dann, wenn der
  Katalog deutsch war. Bemerkenswert: Bei **Spanisch** übersetzte derselbe Prompt im selben
  Lauf korrekt — die Abkürzung wird also sprachabhängig falsch genommen, was sich nicht
  herleiten, sondern nur messen lässt.
- **Der naheliegende Gegenentwurf war schlechter.** „phrases immer zurückgeben, unverändert
  wenn es schon passt" lieferte bei **Italienisch** zweimal von zwei Läufen die deutschen
  Originale und bei Französisch einmal von zwei — dieselbe Verweigerung in anderer
  Verkleidung. Nebenbefund: Auch bei `temperature: 0` unterscheiden sich Läufe gelegentlich,
  Einzelmessungen taugen hier nichts.
- **Behoben, indem dem Modell die Entscheidung genommen wird.** Der Prompt kennt keinen Weg
  mehr, die Formulierung zu überspringen; stattdessen benennt das Modell in einem neuen
  Pflichtfeld `catalogLanguage` erst die Ausgangssprache und formuliert dann bedingungslos
  jeden Katalog-Wert. Dieselbe Mechanik wie beim `formality`-Feld aus 0.6.26: erst benennen
  lassen, dann handeln lassen. Gemessen 15/15 über fünf Sprachfälle × drei Wiederholungen.
- **Nebeneffekt, der bleiben darf:** Da nicht mehr abgekürzt wird, zieht das Modell die
  Anredeform jetzt auch **innerhalb derselben Sprache** nach — duzt der Anrufer auf Deutsch,
  wird aus „Sind Sie noch da?" ein „Bist du noch da?". Passt schon alles, kommen die
  Originaltexte zeichengleich zurück (gemessen 7/7).
- **Diagnose im eigenen Log:** Der CallLocalizer protokolliert jetzt `language`,
  `catalogLanguage`, `formality` und die Anzahl gelieferter Ansagen. Der Fehler oben war
  ausschließlich im Requesty-Dashboard sichtbar.

## [0.6.27] – 2026-07-26

### Added
- **Stille-Reengagement: Nachfassen, wenn der Anrufer schweigt (beide Provider).**
  Schweigt der Anrufer länger als `idlePrompts.timeoutMs`, spricht der Agent eine
  Ansage aus einem Pool. Die **Zeilenreihenfolge ist die Eskalationsstufe** (Zeile 1 =
  sanfte Nachfrage, Zeile 2 = konkretes Angebot) — kein Rotieren, damit der Betreiber
  die Leiter selbst schreibt. Nach `maxPrompts` Ansagen endet sie, mit `hangupAfter`
  im Auflegen: Der Abschied wird über dieselbe Drain-Logik wie `end_call` zu Ende
  gesprochen, bevor die Leitung fällt. Opt-in pro Agent, Default aus.
  Deckt mehr ab als „der Anrufer zögert": das **Dead Air nach einem abgebrochenen
  Barge-in** (Anrufer sagt „äh—", das Final-Transkript ist leer, es startet kein neuer
  Turn — bisher konnte nur der Anrufer das auflösen), **einseitige Audiostrecken**
  (stummes Headset, Handy in der Tasche) und **liegengelassene Anrufe**, die sonst
  STT-, TTS- und SIP-Minuten verbrauchen, bis die Gegenseite auflegt.
- **Wachsende Abstände statt festem Takt.** Die Wartezeit steigt je Stufe (1× / 1,5× /
  2× `timeoutMs`) plus 0–20 % Jitter. Der Jitter wirkt **ausschließlich nach oben** —
  der konfigurierte Wert bleibt damit eine Zusage („nie vor 8 Sekunden"), denn zu früh
  ins Nachdenken des Anrufers zu reden ist der teurere Fehler. Für den Betreiber bleibt
  es ein einziges Feld; Backoff und Jitter sind Verhalten, keine Knöpfe.
- **Neue Metriken** `metrics.idlePrompts` und `metrics.idleHangup` im Request-Dokument
  — ohne sie lässt sich `timeoutMs` nicht sinnvoll einstellen.
- **Stille-Ansagen und ihr Abschied hängen im Lokalisierungs-Katalog** (0.6.26) und
  werden damit automatisch in die Anrufersprache übersetzt, inklusive Anredeform. Der
  `idle`-Pool war als reine Datenerweiterung vorgesehen — weder `localize.ts` noch der
  Localizer-Kern mussten angefasst werden.

### Changed
- **Der Stille-Detektor sitzt im callHandler, nicht in der Session.** Zwei Gründe: Nur
  der callHandler kennt das echte Playout-Ende (`media.pendingMs()`) — `agentAudioDone`
  feuert bereits, wenn der TTS-Stream geflusht ist, während der Anrufer noch mehrere
  Sekunden zuhört. Und über `injectMessage` funktioniert der Wächter so für **beide**
  Provider statt nur native. Die Logik selbst liegt in `src/ari/idleWatcher.ts` als
  reine Zustandsmaschine ohne eigenen Timer (der callHandler taktet sie), damit sie
  ohne Fake-Timer testbar bleibt.
- **`requestHangup` ist nicht mehr an `end_call` gebunden** und nimmt einen Grund
  entgegen — Tool und Stille-Wächter teilen sich dieselbe Abschieds-Drain-Logik.
- **Ansage-Sperren:** Der Wächter schweigt während laufender Tool-Dispatches (die
  Wartezeit gehört dem Filler), in der Transfer-Klingelphase, bei durchgestelltem
  Gespräch und nach angefordertem Auflegen. Dafür zählt der callHandler laufende
  Tool-Aufrufe jetzt mit (`toolsInFlight`).
- **Sprechdauer-Boden für Transporte ohne Playout-Puffer.** `MediaBridge` (RTP) sendet
  alle Frames sofort und führt kein `pendingMs()` — dort würde der letzte Audio-Zeitpunkt
  veralten, während der Anrufer noch hört. Die geschätzte Sprechdauer des letzten
  Agent-Turns (14 Zeichen/s, derselbe Schätzer wie beim Timer-Filler) dient deshalb als
  zusätzliche Untergrenze; sie kann die Ansage nur verzögern, nie verfrühen.

### Fixed
- README.md und README.de.md trugen noch die Versions-Badges von 0.6.25; das Nachziehen
  der Badges ist jetzt Teil der Release-Routine.

## [0.6.26] – 2026-07-25

### Added
- **Timer-Filler bei Tool-Wartezeiten (nur native).** Ruft das LLM ein langsames
  customTool oder MCP-Tool auf, droht bis zur Antwort (plus TTFT der Folgerunde)
  hörbare Stille — und wer in die Stille „Hallo?" fragt, löst ein Barge-in aus und
  bricht die laufende Tool-Fortsetzung ab. Die NativeSession spricht jetzt nach einer
  konfigurierbaren Verzögerung eine kurze Ansage aus einem rotierenden Pool. Bewusst
  NICHT bei `end_call` (Runde wird nie beantwortet — sonst Filler über dem Abschied)
  und `transfer_call` (das Modell kündigt selbst an, die Bridge ist gated). Ein
  eventuell vom Modell gesprochener Ansage-Text verschiebt den Filler-Start um dessen
  geschätzte Sprechdauer (Anti-Doppelung). Der Filler läuft über dieselben
  Generations-Rails wie der übrige Turn (Barge-in/close brechen ihn ab) und geht ins
  Transkript, aber NICHT in die LLM-Historie (eine assistant-Message zwischen
  `tool_calls` und den `tool`-Antworten wäre ein OpenAI-400). Opt-in pro Agent
  (`fillers.enabled`, `delayMs`, `phrases[]`), optionale Per-Tool-Phrase am customTool.
- **Laufzeit-Lokalisierung fest hinterlegter Ansagen (beide Provider).** Fährt ein
  Agent mehrsprachige STT (`language: "multi"`) und der Anrufer spricht eine andere
  Sprache, werden Filler-Ansagen und die Transfer-Fehlschlag-Ansage per LLM-One-Shot
  in die Anrufersprache übersetzt — inklusive der im Gespräch verwendeten Anrede-/
  Höflichkeitsform (Sie/du, vous/tu, …). Der Betreiber pflegt jede Ansage nur EINMAL
  in der Standardsprache; auch Sprachen, die niemand vorgesehen hat, funktionieren.
  Erkennung läuft eager im Hintergrund nach dem ersten inhaltlichen Anrufer-Turn und
  passt sich bei einem Sprachwechsel mitten im Gespräch an (Stopwort-Scorer als
  Verdachtsmelder → erneuter LLM-Lauf; frühere Sprachen kommen aus dem Per-Call-Cache).
  Der Übersetzungs-Prompt arbeitet dafür in zwei Schritten: das Modell muss die erkannte
  Anredeform erst als eigenes Feld (`formality`) benennen und dann übersetzen. Diese
  erzwungene Zwischenentscheidung war nötig — mit einer bloßen „übernimm die Anrede"-
  Anweisung kippte das Register je nach Katalog-Umfang und Modell (real gegen Requesty
  gemessen: 1–3 von 4 Fällen richtig); mit dem `formality`-Schritt waren es 24 von 24
  über zwei Modelle, zwei Katalog-Größen und Wiederholungen. Zusätzlich wahrt der Prompt
  die Sprecher-Perspektive (1. Person bleibt 1. Person — vorher wurde aus „Ich werfe einen
  Blick" schon mal die Aufforderung „Wirf einen Blick").
  Fällt die Erkennung aus oder ist noch nicht fertig, gilt die Standardsprache — eine
  Ansage beschädigt nie ein Gespräch. Neue Bausteine `src/llm/localize.ts`,
  `languageScorer.ts`, `callLocalizer.ts`; eigenes günstiges Modell `LOCALIZE_MODEL`
  (Default `openai/gpt-4.1-mini`). Der Ansagen-Katalog ist pool-generisch angelegt, so
  dass künftige Ansagen-Pools (z. B. Stille-Reengagement) ohne Umbau andocken.
- **Erkannte Gesprächssprache im Anruf.** Die erkannte Anrufersprache landet in
  `request.language` und erscheint als Badge in der Anrufliste.
- **Transfer-Fehlschlag-Ansage pro Agent konfigurierbar** (`transferFailedAnnouncement`,
  vorher fest verdrahtet) — inklusive Admin-Formularfeld; wird ebenfalls lokalisiert.

### Notes
- Die übersetzte Ansage spricht die Stimme des Anrufs: eine rein deutsche Aura-Stimme
  sagt „One moment, please" mit Akzent (wie schon bei den normalen fremdsprachigen
  Antworten). Akzentfrei wird es mit einer mehrsprachigen Stimme (ElevenLabs; ggf.
  eine mehrsprachige Aura-Generation) — reine `speak.provider`-Frage, keine Engine-Änderung.
- Das Greeting bleibt in der Standardsprache (es wird gesprochen, bevor der Anrufer ein
  Wort gesagt hat — es gibt keine Sprachevidenz). Wer international erreichbar ist,
  textet es zweisprachig.

## [0.6.25] – 2026-07-23

### Fixed
- **16-kHz-Pipeline: „Murmelstimmen" auf der Appliance — Einschränkung dokumentiert
  und abgesichert.** Der AudioSocket-Treiber von Asterisk ≤ 22.6 (Appliance: 20.6)
  überträgt unabhängig vom `externalMedia`-Format IMMER slin@8 kHz (`format=slin16`
  setzt nur die NativeFormats-Deklaration; Write/Read bleiben slin) — 16-kHz-Audio
  läuft dann mit halber Geschwindigkeit. Multi-Format-AudioSocket (Message-Typen
  0x11–0x18) existiert erst ab Asterisk 22.7 und erfordert zusätzlich eine
  Protokoll-Erweiterung unseres AudioSocket-Servers. Die Engine prüft jetzt beim
  Boot die Asterisk-Version und loggt bei 16 kHz + AudioSocket + Asterisk < 22.7
  einen klaren Fehler. Doku/.env.example entsprechend korrigiert; auf der
  Appliance vorerst bei `AUDIO_SAMPLE_RATE=8000` bleiben.

## [0.6.24] – 2026-07-23

### Added
- **16-kHz-Audio-Pipeline (opt-in per ENV):** `AUDIO_SAMPLE_RATE=16000` +
  `EXTERNAL_MEDIA_FORMAT=slin16` schalten die gesamte Kette auf HD-Audio —
  AudioSocket-Framing, Flux-STT, Aura/ElevenLabs-TTS (`pcm_16000`), Deepgram-VA,
  Ambience, Rampen und DC-Blocker leiten sich bereits aus der Config ab. Größter
  Gewinn im Web-Widget (Breitband Ende-zu-Ende: bessere STT-Genauigkeit, brillantere
  Stimmen); zum G.711-Trunk transkodiert Asterisk (bleibt dort 8 kHz). Neu dafür:
  Bridge-Aufnahmen entstehen bei 16 kHz als Asterisk-`wav16` (Dateiendung folgt dem
  Format, Inhalt ist normales RIFF-WAV). Default bleibt 8 kHz — bestehende
  Deployments unverändert. Lokal Ende-zu-Ende verifiziert (Aufnahme-Header 16 kHz,
  DC ≈ 0, keine harten Kanten).

### Fixed
- **Testsuite gegen lokale `.env` abgeschirmt:** fünf Testdateien luden die Config
  ohne ENV-Pinning (`helpers/env`) — eine lokale 16-kHz-`.env` ließ die
  Frame-Größen-Tests scheitern und den Playout-Timer leaken (hängende Suite).
  Pinning jetzt in allen Testdateien; `AUDIO_SAMPLE_RATE`/`EXTERNAL_MEDIA_FORMAT`
  werden für Tests auf 8 kHz/slin fixiert.

## [0.6.23] – 2026-07-23

### Fixed
- **Rest-Wahrnehmung an Äußerungsgrenzen („fast unsichtbar") beseitigt:** Aura-Sprache
  sitzt auf einem DC-Sockel (bis −1600) — die Nulllinien-Verschiebung beim Übergang
  Rauschen ↔ Sprache blieb trotz Rampen als leiser „Bums" wahrnehmbar (und DC wandert
  im Widget-Pfad ungefiltert bis in den Browser-Lautsprecher). Der Playout filtert
  TTS-Frames jetzt durch einen Ein-Pol-DC-Blocker (Hochpass fc ≈ 6 Hz, Telefonie-
  Standard; Zustand läuft über Frame-Grenzen). Aufnahme-Analyse nach 0.6.22 belegte:
  Rampen wirken (Greeting-Onset-Sprung 67 statt >600), der Sockel war der Rest.

## [0.6.22] – 2026-07-23

### Fixed
- **Klick jetzt am Äußerungs-ANFANG (Folgefehler des 0.6.21-Dauertakts).** Messung
  gegen die echte Aura-API: Streams beginnen mit hartem DC-Sprung (erstes Sample
  −388…−627, Sockel bis −1600) — vor totenstiller Leitung als Klick am Sprechbeginn
  hörbar (die Sample-Rate ist unschuldig; der Sprung existiert bei 8/16/24 kHz).
  Zwei Playout-Bausteine: (1) ~5-ms-Ein-/Ausblende an TTS-Burst-Grenzen (Lead-in-
  Stille verbraucht die Einblende nicht — auch das Greeting startet gerampt);
  (2) hauchleises Komfortrauschen (±12 ≈ −65 dBFS) statt digitaler Nullen im
  Leerlauf — maskiert Mikro-Kanten und beseitigt das „tote Leitung"-Gefühl.

## [0.6.21] – 2026-07-23

### Fixed
- **Klickgeräusch am Ende jeder Agent-Äußerung (ohne Ambience).** Ursache war nicht
  die TTS (Aura-Streamenden klingen bei 8/16/24 kHz nachweislich sauber aus), sondern
  der Underrun-Stopp des Playout-Takts ~1 s nach dem Äußerungsende: Der Übergang
  „aktiver Stille-Strom → gar kein Strom" kippt den Jitter-Buffer der Endgeräte hörbar
  in den Leerlauf (Telefon wie Web-Widget; im Ambience-Modus nie aufgetreten, weil der
  Takt dort durchläuft). Der Playout-Takt läuft jetzt immer von attach() bis close()
  und sendet im Leerlauf Stille (~16 kB/s pro aktivem Anruf). end_call-Drain
  (`pendingMs()`) und Barge-in-Verhalten bleiben unverändert.

## [0.6.20] – 2026-07-23

### Fixed
- **Transfer bei Sofortannahme: Mitarbeiter hörte den Rest der Verbinde-Ansage.**
  Das Audio-Gate blockt nach dem Connect nur neue Frames; die beim Connect noch im
  Playout gepufferte Restansage spielte weiter in die Mixing-Bridge — bei sofort
  annehmenden Zielen hörbar. Der callHandler flusht den Playout-Puffer jetzt im
  Connect-Zweig (derselbe Mechanismus wie beim Barge-in).

## [0.6.19] – 2026-07-22

### Added
- **Spekulations-Telemetrie im Turn-Latenz-Log:** Jede `Turn-Latenz`-Zeile trägt
  jetzt `eager: "hit"` (Turn wurde aus der bestätigten Spekulation bedient) bzw.
  `"miss"` (Spekulation verworfen, normaler Neustart); verworfene Spekulationen
  durch Weitersprechen loggen `TurnResumed — Spekulation verworfen` auf info.
  Damit sind Trefferquote und Threshold-Tuning (`NATIVE_EAGER_EOT_THRESHOLD`)
  ohne Debug-Loglevel am Live-System ablesbar.

## [0.6.18] – 2026-07-22

### Fixed
- **`NATIVE_EAGER_EOT` griff ohne Threshold nicht:** Flux deaktiviert den Eager-Modus
  komplett, wenn keine `eager_eot_threshold` mitgesendet wird (im Live-Test 0.6.17
  entdeckt: Latenzen unverändert, keine EagerEndOfTurn-Events). Bei aktivem Flag
  sendet die Engine jetzt immer eine Schwelle — `NATIVE_EAGER_EOT_THRESHOLD` oder
  Default 0.5 (Mitte des gültigen Bereichs 0.3–0.9; Fehlspekulationen sind dank
  Gate unhörbar und kosten nur LLM-Input-Tokens).

## [0.6.17] – 2026-07-22

### Added
- **EagerEndOfTurn-Spekulation (native, `NATIVE_EAGER_EOT`):** Der LLM-Turn startet
  bereits auf das vorläufige Flux-Turn-Ende (EagerEndOfTurn) statt erst auf das
  bestätigte — typischer Gewinn 200–500 ms Antwortzeit. Sicherheitsmodell: Sätze,
  Historie, Transkript-Events und Tool-Calls warten hinter einem Gate, bis das
  EndOfTurn den Wortlaut bestätigt; TurnResumed oder ein abweichendes Final-Transkript
  brechen die Spekulation ab (LLM-Abort + Generationszähler) — für den Anrufer
  unhörbar, Kosten nur LLM-Input-Tokens. `NATIVE_EAGER_EOT_THRESHOLD` übersteuert
  optional die Flux-Schwelle. Default aus (opt-in pro Deployment).

## [0.6.16] – 2026-07-22

### Added
- **TTS-Verbrauchsmetrik pro Anruf (native):** Die Engine zählt zeichengenau, was
  tatsächlich an den TTS-Anbieter gesendet wurde (= Abrechnungsbasis; per Barge-in
  verworfene, nie gesendete Sätze zählen nicht) und persistiert `metrics.ttsProvider/
  ttsModel/ttsCharacters` — bei ElevenLabs zusätzlich `ttsCredits` (Flash/Turbo:
  0,5 Credits/Zeichen, sonst 1,0). Damit ist der ElevenLabs-Credit-Verbrauch pro
  Gespräch exakt zuordenbar, auch wenn das Konto von mehreren Diensten geteilt wird.
  Anzeige als Badge im Anruf-Detail („TTS 4.714 Zeichen ≈ 2.357 Credits").
  Der gebündelte Deepgram-Agent spricht intern → dort weiterhin keine Verbrauchsdaten.

## [0.6.15] – 2026-07-22

### Added
- **Anrufbeschriftung mit Agenten-Auflösung:** Anrufliste, Dashboard („Letzte Anrufe"),
  Live-Ansicht und Anruf-Detail zeigen den Agenten-Namen in Klammern hinter der
  gewählten Nummer — z. B. „Web → 123 (Weiterleitungs Fred)". Die Requests-API
  liefert dafür den referenzierten Agenten-Namen mit (`populate` auf `agentId`);
  besonders nützlich bei Web-Anrufen, wo die interne Pseudo-Durchwahl statt der
  vollwertigen DDI erscheint.

## [0.6.14] – 2026-07-22

### Fixed
- **Web-Widget hinter Docker-NAT (EasyPanel/Swarm): kein Audio in beide Richtungen.**
  Signalisierung und Engine-Seite liefen (Transkript/Begrüßung in der Aufnahme), aber
  Asterisk annoncierte dem Browser nur container-interne ICE-Host-Kandidaten
  (172.18.x/10.x) — unerreichbar, alle Kandidaten-Paare scheiterten. Der entrypoint
  schreibt jetzt bei **explizit gesetzter `PUBLIC_IP`** einen `[ice_host_candidates]`-
  Block in die rtp.conf (alle Container-IPs → öffentliche IP; RTP-Ports sind
  host-publiziert). Auto-erkannte PUBLIC_IP schreibt bewusst NICHT um — lokales
  Direktrouting (OrbStack) behält seine funktionierenden lokalen Kandidaten.
- **Widget-Exten-Auto-Vergabe übernahm eine kollidierende Nummer:** Eine früher (bei
  deaktiviertem Widget, daher unvalidiert) gespeicherte `widget.exten`, die inzwischen
  als DDI eines ANDEREN Agenten existiert, wurde beim Aktivieren respektiert → der
  Web-Anruf landete beim falschen Agenten. Kandidaten, die andere Agents belegen,
  werden jetzt übersprungen und neu vergeben.

## [0.6.13] – 2026-07-22

### Added
- **ElevenLabs-Stimm-Feinschliff pro Agent** (`speak.stability`, `speak.similarityBoost`,
  `speak.speed`): wird in der nativen Kaskade als `voice_settings` mit jeder
  (Re-)Verbindung an ElevenLabs übergeben — überlebt damit auch die harten
  Barge-in-Disconnects. `stability`/`similarityBoost` 0–1 (Schema-validiert), `speed`
  wird auf den erlaubten Bereich 0.7–1.2 geklemmt. Unset = Voice-Default aus dem
  ElevenLabs-Dashboard. Im Deepgram-Agent-Modus (Dritt-TTS-Durchreiche) sind
  `voice_settings` nicht übertragbar — dort gelten weiterhin die Dashboard-Defaults
  der Stimme (dokumentiert).
- **Admin-UI:** Modal „Erweiterte Stimm-Einstellungen" im Agent-Formular (sichtbar bei
  TTS-Provider ElevenLabs), inkl. Zusammenfassungszeile und „Zurücksetzen"; Komma als
  Dezimaltrenner wird akzeptiert.

### Fixed
- **Agents-Liste:** zeigt bei ElevenLabs-Agents nicht mehr irreführend das (dort
  bedeutungslose) gespeicherte Aura-Modell, sondern das ElevenLabs-Modell bzw.
  „ElevenLabs". Zeilen tragen außerdem wieder die Leading-Icons aus dem ursprünglichen
  Mockup (Headset = Agent, Transfer-Pfeile = Passthrough) — der leere Platz vor dem
  Text entfällt.
- **Anrufliste, Dashboard („Letzte Anrufe") und Live-Ansicht** haben jetzt dieselben
  Leading-Icons, dort nach Herkunft des Anrufs: Telefonhörer (Trunk/Softphone) bzw.
  Globus (Web-Widget) — der Modus steht weiterhin im Badge/Filter. Gemeinsames Modul
  `webui/js/icons.js`; GlassKit-Eigenheit dokumentiert (Shadow-CSS erreicht geslottete
  SVGs nicht — Größe muss in der View gesetzt werden, sonst 0×0).

## [0.6.12] – 2026-07-22

### Changed
- **Web-Widget: Pseudo-Durchwahl (`widget.exten`) ist jetzt server-verwaltet.** Beim
  Aktivieren des Widgets vergibt der Server automatisch eine freie 3-stellige Nummer
  (bzw. nutzt eine vorhandene 3-stellige DDI des Agenten mit) und ergänzt sie in
  `targetNumbers` — das manuelle Feld samt „muss auch unter Zielrufnummern
  stehen"-Stolperfalle entfällt im Formular (Anzeige nur noch informativ). API-Clients
  können `widget.exten` weiterhin explizit setzen; der Schema-Validator bleibt als
  Sicherheitsnetz bestehen. Behebt den Fehlversuch, das Widget an einem Agenten mit
  reiner E.164-Nummer zu aktivieren („Widget: exten muss gesetzt sein und in
  targetNumbers stehen" trotz korrekt wirkender Eingaben).

## [0.6.11] – 2026-07-22

### Fixed
- **Dev-Setup: `transfer_call` → 101 schlug direkt nach einem Container-Neustart fehl**
  („Could not create dialog to invalid URI '101' … Is endpoint registered?"). Ursache war
  KEIN Code-/NAT-Problem, sondern ein Registrierungs-Zeitfenster: Ein Neustart verwirft
  alle SIP-Registrierungen; bis das Softphone von sich aus neu registriert (Minuten),
  fehlt der 101-Contact — eingehende Anrufe funktionieren derweil normal (Digest-Auth
  ohne Registrierung), weshalb scheinbar „nur der Transfer" klemmte. Die Dev-AORs
  begrenzen die Registrierungs-Gültigkeit jetzt auf ≤ 90 s (Clients registrieren im
  Minutentakt neu) → das Fenster ist praktisch weg. Prod/Trunk war nie betroffen.

## [0.6.10] – 2026-07-21

**NativeSession**: eigene STT→LLM→TTS-Kaskade als dritter Voice-Provider
(`voiceProvider: "native"`) — die Engine orchestriert das Gespräch selbst, callHandler/
MediaSession/Toolset bleiben unverändert hinter der `VoiceAgentSession`-Naht. Erster
Live-Test: spürbar schnellere Turns als der gebündelte Agent, sauberes Barge-in;
Medienkosten grob ⅓ des Voice-Agent-Preises (Flux $0.0078/min + Aura $0.03/1k Zeichen
vs. $0.059/min BYO-LLM — Listenpreise 2026-07).

### Added
- **`src/native/` — die Kaskade:** `FluxSttStream` (v2-Listen-WS, 8 kHz verifiziert;
  Turn-Events StartOfTurn/EndOfTurn/Eager/Resumed; einmaliger Auto-Reconnect bei Drop),
  `streamChatCompletion` (Requesty-SSE mit index-basierter Tool-Call-Akkumulation,
  AbortError-Normalisierung für Barge-in; Wire-Format live verifiziert), `AuraTtsStream`
  (Speak-WS @ 8 kHz, `Clear`/`Cleared`-Quarantäne live verifiziert, Lazy-Reconnect gegen
  Idle-Drops), Satz-Chunker (Abkürzungs-/Zahlen-Heuristik) und `ConversationHistory`
  (Zeichenbudget-Trimming, hält tool_calls-Gruppen zusammen).
- **`NativeSession`-Orchestrator:** Turn-Loop mit **Satz-Overlap** (Sprechen beginnt,
  während das LLM streamt), Tool-Runden inkl. paralleler Calls und end_call-Sonderfall,
  `injectMessage` (Transfer-Fehlschlag) mit Stale-Response-Schutz, **zweischichtige
  Barge-in-Quarantäne** (Server-Clear + Turn-Generationszähler) und per-Turn-Latenzlog
  (`total`/`ttt`/`tts`) für A/B-Vergleiche.
- **TTS-Provider-Matrix in native:** `speak.provider` wählt Aura-2 **oder ElevenLabs**
  (`stream-input`-WS, `pcm_8000`, Voice-ID am Agent, Key aus `ELEVENLABS_API_KEY`;
  Barge-in dort per hartem Disconnect + Lazy-Reconnect, da das Protokoll kein Clear kennt).
  Unvollständige Konfiguration fällt mit Warnung auf Aura zurück.
- **Freischaltung:** `voiceProvider`-Enum + Factory-Case + Formular-Option
  „Native (STT→LLM→TTS-Kaskade)"; `config.native`-Block (`NATIVE_*`-ENV).

### Notes
- Flux erfordert den native-Modus mit `flux-*`-listen-Modell (nova-3 → Warnung + Fallback
  flux-general-multi). Größter Latenz-Hebel laut Messung ist das think-Modell
  (LLM-First-Token ≈ 2,2–2,4 s mit dem Prod-Default); EagerEndOfTurn-Spekulation ist als
  Ausbaustufe vorbereitet (`NATIVE_EAGER_EOT`, v1 nur Beobachtung).

## [0.6.9] – 2026-07-21

WebRTC-Web-Widget: ein **einbettbares Browser-Softphone** — Website-Besucher rufen den
Agenten direkt im Browser an (SIP over WebSocket → Asterisk chan_pjsip). Der bestehende
Telefonie-Pfad (Stasis → Engine → Voice-Session, Live-Ansicht/Transkript/Aufnahme/Summary/
Metriken) läuft unverändert. Doku: `docs/webrtc.md`.

### Added
- **Asterisk (ENV-gesteuert, `WEBRTC_ENABLED`):** `transport-ws` + Endpoint `webwidget`
  (`webrtc=yes`, DTLS-Auto-Cert, Codecs `opus,ulaw,alaw` — Opus-Modul im Ubuntu-Paket
  verifiziert) und dedizierter Dialplan-Context `[webrtc-inbound]`: nur 3-stellige
  Pseudo-DDIs wählbar, eindeutige Caller-ID `web-<uniqueid>` (kein Dedup-Konflikt,
  „Web" in der Anrufliste). PUBLIC_IP-Auflösung im entrypoint vorgezogen (Trunk **und**
  WebRTC), `icesupport` + `websocket_write_timeout` werden gesetzt.
- **`agent.widget`** (Schema-validiert): `enabled`, `exten` (3-stellig, muss in
  `targetNumbers` stehen), `allowedOrigins` (CSP frame-ancestors), `showTranscript`;
  Embed-`key` server-verwaltet inkl. Rotations-Endpoint (`POST /api/agents/:id/widget/key`)
  und Formular-Sektion (Snippet kopieren, Demo-Link).
- **Öffentliche Widget-Endpoints** (key-/token-gebunden, ohne Login): `POST /api/widget/session`
  (liefert WS-URL + SIP-Creds erst nach Kill-Switch-, Key-, Origin-, Rate-Limit- und
  Concurrent-Prüfung), `GET /widget/:key` (iframe-Seite mit per-Agent-frame-ancestors),
  `GET /api/widget/call/:token` (Live-Transkript, 120 s Nachlauf). Eigener
  Sliding-Window-Limiter ohne neue Dependency; Fastify jetzt mit `trustProxy`.
- **Widget-Frontend:** Loader `webui/widget.js` (ein `<script>`-Tag, Floating-Button +
  iframe mit Mikrofon-Permission), iframe-Seite `widget-app/index.html` (sip.js 0.21 als
  Vendor-ESM, registerloses INVITE, deutsche UI, Mute/Auflegen, **pegelgesteuerter Orb**
  über AnalyserNode am Agent-Audio + Mikro-Indikator, optionales Live-Transkript-Panel
  mit 2-s-Polling, Zustands-postMessage für den Button-Puls, prefers-reduced-motion),
  Demo-/Testseite `webui/widget-demo.html`.
- **Engine (minimal):** drittes Stasis-Argument (`X-Widget-Token` aus dem INVITE) wird als
  `requests.widgetToken` gespeichert (sparse Index) — Grundlage des Widget-Transkripts.

### Notes
- **Single-Port-Design:** Der Admin-Server proxyt `/ws` loopback-intern an Asterisk
  (`@fastify/http-proxy`, websocket) — EIN öffentlicher Port (8080) trägt UI, API, Widget
  und SIP-WS. Jeder simple TLS-Proxy davor funktioniert ohne Pfad-Sonderrouten (EasyPanel-
  Domain, OrbStack-`*.orb.local`); Asterisks HTTP-Server (trägt auch ARI) bleibt auf
  127.0.0.1 gehärtet. Medien laufen über die bestehende host-mode RTP-Range; `PUBLIC_IP`
  bleibt Pflicht (ICE). TURN ist eine dokumentierte Ausbaustufe (~5–10 % der Besucher
  hinter symmetrischem NAT). Threat-Model in `docs/webrtc.md` (Worst Case bei geleaktem
  SIP-Passwort = Gespräche mit dem Agenten; kein Trunk-Zugriff).

## [0.6.8] – 2026-07-20

Hintergrundatmosphäre im Anruf + ElevenLabs als optionale Ausgabestimme.

### Added
- **Ambience pro Agent** (`agent.ambience { enabled, preset, volume }`): eine leise Dauerschleife
  (z. B. Büroatmosphäre), die der Anrufer das ganze Gespräch über hört — auch in Sprechpausen
  und während das LLM denkt. Der AudioSocket-Playout-Takt läuft dazu bei aktiver Ambience
  durchgehend (statt nach ~1 s Stille zu pausieren) und mischt den Loop in jedes 20-ms-Frame
  (int16-Clamp; `pendingMs()` zählt weiterhin nur TTS → `end_call`-Drain und Barge-in-Metrik
  unverändert). Barge-in (`flush()`) verwirft nur TTS — die Atmosphäre läuft nahtlos weiter.
- **Eingebaute, lizenzfreie Presets** `office` / `room` / `rain` — prozedural generiert
  (deterministisches Seed-Rauschen + Filter, 16-s-Loop mit Crossfade, ≈ −27 dBFS), keine
  Binär-Assets im Repo/Image, unabhängig von `AUDIO_SAMPLE_RATE`. Eigene Loops via
  `AMBIENCE_DIR` (`<preset>.raw`, slin 16-bit LE mono) übersteuern den Generator.
- **`GET /api/ambience`**: Preset-Manifest für die UI; Agent-Formular mit Toggle, Preset-Select
  und Lautstärke-Regler (0–100 %); Seed-Agent „Vertrieb Demo" (DDI 120) mit aktiver Ambience.
- **ElevenLabs-TTS optional** (`speak.provider: "eleven_labs"`, Voice-ID in `speak.voice`):
  Durchreiche über die Dritt-TTS-Unterstützung der Deepgram Voice Agent API (`model_id` +
  Endpoint mit `xi-api-key`-Header). Der API-Key kommt ausschließlich aus dem Server-Env
  (`ELEVENLABS_API_KEY`) — nie in der DB. Fehlt Key oder Voice-ID, fällt der Anruf mit
  Warn-Log auf die Deepgram-Stimme zurück (ein Anruf scheitert nie an der TTS-Auswahl).

### Notes
- Ambience wird nur beim AudioSocket-Transport unterstützt (`MEDIA_TRANSPORT=rtp` → einmalige
  Warnung, Anruf ohne Atmosphäre); sie landet mit in der Aufnahme (Bridge-Mix) und pausiert,
  sobald ein Mensch den Anruf übernimmt (Transfer connected). Passthrough-Modus: ohne Ambience.

## [0.6.7] – 2026-07-20

### Fixed
- **Verwaiste „laufende" Anrufe nach Engine-Neustart.** Stürzt die Engine mitten im Gespräch ab
  oder wird redeployt, blieb der Request dauerhaft auf `in_progress` — und erschien seit 0.6.3
  für immer in der Live-Ansicht (auf dem Dev-Server standen so 3 Wochen alte Scanner-Anrufe als
  „Läuft"). Beim Engine-Start werden solche Waisen jetzt als `failed` markiert (`endedAt` bleibt
  leer — die echte Endezeit ist unbekannt, die UI zeigt „—").

## [0.6.6] – 2026-07-20

### Fixed
- **Anruf-Detail: Summary blieb auf „pending" stehen.** Das Auto-Refresh (0.6.3) endete mit
  dem Statuswechsel auf completed — Post-Call-Summary (Agent-Modus) und Batch-Transkription
  (Passthrough) starten aber erst danach. Das Polling läuft jetzt weiter, solange etwas auf
  „pending" steht (Nachlauf-Deckel ~3 min gegen dauerhaft hängende Zustände).

## [0.6.5] – 2026-07-20

MCP-Anbindung: ein Agent kann komplette MCP-Server (Model Context Protocol) als Tool-Quelle
einbinden — Tools erscheinen dem LLM präfixiert als `<server>_<tool>`. Doku in `docs/tools.md`.

### Added
- **`agent.mcpServers[]`** (Schema-validiert): `name` (= Tool-Präfix), `url` (Streamable
  HTTP), `headers` (statisch, `${ENV:NAME}`-Platzhalter), `toolFilter` (Whitelist),
  `timeoutMs`, `enabled`. Editor im Agent-Formular (Liste + Modal analog Custom-Tools).
- **`src/tools/mcp.ts`**: Tool-Listen-Cache pro Server-URL (TTL ~5 min — Call-Aufbau wartet
  nie auf `tools/list`), Client-Aufbau via `@modelcontextprotocol/sdk` (gepinnt 1.29.0),
  Ergebnis-Normalisierung (structuredContent bzw. konkatenierte Text-Teile).
- **Toolset-Integration:** MCP-Tools präfixiert im per-Call-Toolset; Verbindung **lazy** beim
  ersten Dispatch, lebt für die Call-Dauer, `toolset.close()` (Hook aus 0.6.1) schließt sie.
  Unerreichbarer Server → Anruf startet ohne dessen Tools (Warn-Log), Greeting blockiert nie.
- **Tests** (`test/mcpToolset.test.ts`): Mini-MCP-Server mit demselben SDK (stateless
  Streamable HTTP) — list+call übers Toolset, isError→ok:false, toolFilter, Cache-Nachweis
  (keine HTTP-Anfragen beim zweiten Toolset), unerreichbarer Server.

## [0.6.4] – 2026-07-20

Per-Call-Metriken: Antwortlatenz und Interaktionszähler werden pro Anruf persistiert und im
Admin-UI angezeigt — „fühlt sich langsam an" wird damit zur Zahl.

### Added
- **`requests.metrics`** (Subdokument, ein Write beim Finalisieren): `timeToFirstAudioMs`
  (Answer → erstes Begrüßungs-Audio), `bargeIns` (gezählt nur, wenn der Agent gerade hörbar
  war — Puffer spielt noch oder Audio < 1,5 s her), `toolCalls`/`toolErrors`,
  `voiceProvider`/`sttModel` (für A/B-Vergleiche nova-3 vs. flux pro Anruf).
- **Anruf-Detail:** Badge-Zeile „Erste Antwort 1,2 s", „2 Barge-ins", „3 Tools (1 Fehler)".
- `finalizeRequest(id, status, metrics?)` — abwärtskompatibel erweitert; Lifecycle-Test für
  Messpunkte inkl. Barge-in-Guard (kein Zähler beim regulären Nutzer-Turn).

## [0.6.3] – 2026-07-20

Live-Call-Ansicht im Admin-UI: laufende Anrufe auf einen Blick, wachsendes Transkript ohne
manuelles Neuladen.

### Added
- **Tab „Live"** (`#/live`, `webui/js/views/live-view.js`): laufende Anrufe
  (`status=in_progress`) mit tickender Dauer (1-s-Ticker) und Läuft-Badge; 3-s-Polling,
  Klick öffnet das Anruf-Detail. Empty-State, stiller Retry bei Netzfehlern.
- **Anruf-Detail:** bei laufendem Anruf alle 2 s stiller Reload (kein Lade-Flackern) —
  Transkript und Funktionsaufrufe wachsen live mit; Polling endet mit dem Terminal-Status.
- **Partial-Index** auf `requests.status` (nur `in_progress`) — die Live-Abfrage bleibt
  billig, egal wie groß die Anruf-Historie wird.

### Changed
- Polling statt Push (bewusst): Admin-Prozess und Engine teilen nur die Standalone-MongoDB
  (keine Change Streams). Ausbaustufe Replica-Set → Change Streams → SSE steht im Backlog.
- Service-Worker-Shell-Cache auf v2 (neue View precached).

## [0.6.2] – 2026-07-20

Tool-Verwaltung im Admin-UI: eingebaute Tools als Schalter, eigene HTTP-Tools als Liste mit
Modal-Editor — die Custom-Tools aus 0.6.1 sind damit ohne API-Handarbeit pflegbar.

### Added
- **Agent-Formular: Built-in-Tools als Toggle-Liste** (statt Komma-Text), gespeist aus dem
  neuen **`GET /api/tools`** (Registry-Namen + Beschreibungen, requireAuth).
- **Agent-Formular: Custom-Tool-Editor** (`glk-modal`): Name (Muster-, Built-in-Kollisions-
  und Duplikat-Prüfung), Beschreibung, Methode (POST/GET), Endpoint-URL, Timeout, dynamische
  Header-Zeilen mit `${ENV:NAME}`-Hinweis, Parameters als JSON-Schema-Textarea mit
  JSON-Validierung, Aktiv-Toggle, Entfernen. Persistiert über den normalen Agent-PATCH.

### Changed
- OpenAPI-`info.version` kommt aus package.json statt hartkodiert (neuer Export
  `appVersion()` in util/banner).

## [0.6.1] – 2026-07-20

Per-Agent-HTTP-Tool-Endpoints: fachliche Tools (CRM-Lookup, Terminbuchung, …) laufen als
externe HTTP-Endpoints und werden pro Agent in der DB hinterlegt — die Engine bleibt
Kern-Telefonie. Vollständiger Kontrakt in `docs/tools.md`.

### Added
- **`agent.customTools[]`** (Mongoose-Subschema mit Validierung): `name` (klein_mit_unterstrichen,
  eindeutig, Built-in-Kollisionen abgewiesen), `description`, `parameters` (JSON-Schema),
  `endpoint` (`url` http(s), `method` GET/POST, `headers`, `timeoutMs` 500–30000), `enabled`.
- **Per-Call-Toolset** (`src/tools/toolset.ts`): führt eingebaute Tools (`agent.tools`) und
  Custom-HTTP-Tools zusammen; `dispatch()` wirft nie (Fehler → sprechbares `{error}`-Ergebnis,
  Ergebnis-Kappung ~4 kB), `close()`-Hook für call-gebundene Ressourcen (MCP-Vorbereitung).
- **HTTP-Executor**: POST-Envelope `{arguments, call:{callId, callerNumber?, agentId?,
  targetNumber?}}` bzw. GET-Query; `${ENV:NAME}`-Platzhalter in URL/Headern (Secrets bleiben
  in der Umgebung, nicht in der DB); hartes Timeout via `AbortSignal.timeout`
  (`src/util/http.ts`).
- **`ToolContext`** um `agentId`/`targetNumber` erweitert (transportneutral, keine ARI-Objekte).
- **Tests** (`test/toolset.test.ts`, 10 Fälle gegen lokalen HTTP-Server): Envelope, GET-Query,
  `${ENV:}`-Auflösung, Text-Antwort, 5xx, Timeout, Ergebnis-Kappung, Merge/Kollision/disabled,
  werfender Handler, unbekanntes Tool/kaputtes JSON. Plus Lifecycle-Test: `toolset.close()`
  läuft im Teardown.
- `docs/tools.md`: Endpoint-Kontrakt, Secrets, Dead-Air-Hinweis, Beispiel-Endpoint.

### Changed
- **callHandler** nutzt das per-Call-Toolset statt der globalen Registry-Dispatch-Funktionen
  (`buildFunctionDefinitions`/`dispatchTool` entfallen); Registry enthält nur noch die
  Built-ins (`registerTool`/`getTool`/`listTools`).

### Fixed
- **Function-Call-Status**: fehlgeschlagene Tool-Aufrufe werden jetzt mit `status: "error"`
  protokolliert (vorher immer `"ok"`); das Anruf-Detail im Admin-UI zeigt Fehler damit korrekt an.

## [0.6.0] – 2026-07-20

Voice-Provider-Abstraktion als Fundament für weitere Agent-Plattformen (ElevenLabs, OpenAI
Realtime, xAI Grok, eigene `NativeSession`-Kaskade) + Flux-Auswahl in der Admin-UI +
Call-Lifecycle-Tests.

### Added
- **Provider-Abstraktion `VoiceAgentSession`** (`src/voice/types.ts`) + Factory
  (`src/voice/factory.ts`): der `callHandler` spricht nur noch gegen das neutrale Interface;
  die Deepgram-`AgentSession` ist der erste Adapter. Neue Provider = neuer Adapter + ein
  case in der Factory — ohne Änderung am Call-Pfad.
- **Agent-Feld `voiceProvider`** (Enum, Default `deepgram`; Nichtimplementiertes wird schon
  beim Speichern abgewiesen) end-to-end: Mongoose-Schema, `ResolvedAgent`, Resolver,
  Formular-Select in der Admin-UI.
- **Admin-UI: STT-Modell-Auswahl** `nova-3` / `flux-general-multi` / `flux-general-en` als
  Select im Agent-Formular; bei Flux erscheinen die Felder `eot_threshold` /
  `eot_timeout_ms` (modellintegrierte End-of-Turn-Erkennung). Flux ist damit ohne
  Code-Änderung pro Agent aktivierbar (A/B gegen nova-3 pro DDI).
- **Call-Lifecycle-Tests** (`test/callLifecycle.test.ts`, 14 Fälle): Doppel-INVITE-Dedup
  (sipgate-Regression), Unknown-DDI-Reject, Audio-Bridging, Barge-in, Transkript-Reihenfolge,
  FunctionCall-Korrelation, end_call-Drain (Mock-Timer), Transfer connected/failed/Klingelphase,
  Cleanup-Idempotenz, Session-Fehlerpfade — komplett gegen Fakes (`test/helpers/`), ohne
  Asterisk/Cloud/DB. Dazu ein WS-Loopback-Test des Deepgram-Adapters und Factory-Tests.
- **DI-Naht im callHandler** (`CallHandlerDeps`, optionaler 4. Parameter von
  `handleStasisStart`) + transportneutrales `CallMedia`-Interface — zugleich die dokumentierte
  Andockstelle für einen künftigen WebRTC-Ingress (siehe docs/architecture.md „Zwei Nähte").

### Changed
- **Session-Lifecycle:** WS-Connect aus dem `AgentSession`-Konstruktor in ein explizites
  `await session.start()` **nach** der Event-Verdrahtung verschoben. Schlägt der Connect fehl,
  endet der Anruf jetzt sauber mit `cleanup("failed")` + Hangup (vorher: stummes Hängen).
- `eot_threshold`/`eot_timeout_ms` werden nur noch bei `flux-*`-Modellen an Deepgram gesendet
  (nova-3 lehnt die Felder ab — schützt per API befüllte Altdaten).
- `FunctionDefinition` ist provider-neutral nach `src/voice/types.ts` umgezogen
  (`deepgram/events.ts` re-exportiert).

### Fixed
- **Flux-Settings an die aktuelle API-Spec angepasst** (empirisch gegen die Live-API
  verifiziert): Flux verlangt `version: "v2"` im listen-Provider und lehnt `language`/
  `smart_format` mit „Error parsing client message" ab; `language_hints` nur beim
  multilingualen Modell. `eot_threshold`/`eot_timeout_ms` werden akzeptiert. Ohne den Fix
  wäre jeder über die neue GUI-Auswahl aktivierte Flux-Agent beim Anruf gescheitert.
- **Admin-UI verlor beim Speichern Subdokument-Felder:** PATCH ersetzt `listen`/`speak`
  komplett; das Formular schrieb bisher nur `speak.model` zurück → `speak.provider`,
  `speak.voice`, `listen.keyterms` u. a. fielen bei jedem UI-Save auf Defaults zurück.
  Jetzt werden beide Subdokumente vollständig gemergt zurückgeschrieben.

## [0.5.8] – 2026-06-29

Sicherheits-Härtung gegen SIP-Scanner + sauberes Verhalten bei unbekannter Rufnummer.

### Security
- **Kein anonymer SIP-Zutritt mehr.** SIP-Scanner (sipvicious & Co.) klopfen den öffentlichen
  `5060/udp` permanent ab; bisher waren die **fest ins Image gebackenen Dev-Softphones**
  (`softphone`/`softphone`, `101`/`101`) immer aktiv und über erratbare Logins brute-force-bar →
  eingeschleuste Anrufe lösten KI-Sessions aus (Kosten + volllaufendes Anruflog). Jetzt:
  - Dev-Softphones werden nur noch bei **`DEV_SOFTPHONE_ENABLED=true`** (Default **aus**) vom
    entrypoint als `pjsip_local.conf` erzeugt (Passwörter via `DEV_SOFTPHONE_PASSWORD` /
    `DEV_SOFTPHONE_101_PASSWORD`). Auf einer öffentlichen Appliance existiert **kein** ratbarer
    Endpoint mehr; Inbound läuft ausschließlich über den IP-gebundenen Trunk (`identify`).
  - `[global]`-Härtung in der pjsip.conf; **kein** `anonymous`-Endpoint → unidentifizierte INVITEs
    werden mit `401` abgewiesen.

### Added
- **`UNKNOWN_NUMBER_BEHAVIOR`** (Default `reject`): Verhalten, wenn eine DDI **keinem** Agent
  zugeordnet ist — `reject` (vor dem Answer mit `404 unallocated` ablehnen → Anrufer-Netz spielt
  „kein Anschluss"; **0 Kosten, kein Logeintrag**), `announce` (Ansage `UNKNOWN_NUMBER_ANNOUNCEMENT`
  abspielen + auflegen, kein LLM) oder `agent` (Default-Agent — nur Dev). Der Default-Agent ist damit
  **kein** stiller Catch-all mehr.

### Changed
- Dialplan `[inbound]`: **kein `Answer()`** mehr — der Anruf wird erst in der Stasis-App angenommen,
  sobald ein Agent passt (ermöglicht das Pre-Answer-`reject`). `agentResolver` liefert bei Miss `null`;
  der callHandler entscheidet anhand von `UNKNOWN_NUMBER_BEHAVIOR`.
- `docs/configuration.md` + `.env.example`: neue ENV-Parameter, Abschnitt „Unbekannte Rufnummer",
  erweiterte „Sicherheit / Härtung".

## [0.5.7] – 2026-06-28

Freie Trunk-Provider-Wahl (ein Trunk pro Appliance) + Doku.

### Added
- **Trunk-Anbindungsmodus** `TRUNK_AUTH_MODE` = `register` (SIP-Registrierung) **oder** `ip`
  (statische IP-Auth, keine Registrierung) — deckt sipgate/easybell/Placetel ebenso ab wie
  Telekom CompanyFlex/Twilio/Telnyx. Neu: `TRUNK_MATCH` (identify-IPs), `TRUNK_FROM_USER`,
  `TRUNK_CLIP_HEADER` (`ppi`/`pai`). Defaults erhalten das bestehende sipgate-Verhalten.
- **[docs/trunks.md](docs/trunks.md)**: Anbieter-Übersicht (DACH) mit Modus/CLIP/ENV je Provider
  und Beispiel-Konstellationen; in README verlinkt.

### Changed
- README (EN/DE): Telefonie als **provider-agnostisch** beschrieben (nicht nur sipgate) + Verweis
  auf docs/trunks.md. Markenschreibweise durchgängig **sipgate** (klein).

### Ops (nicht im Image)
- Auf dem Live-Host ein systemd-Watcher (`voh-ports.service`), der die Host-Mode-SIP/RTP-Ports nach
  jedem EasyPanel-Redeploy automatisch neu publiziert (kein manuelles `voh-ports.sh` mehr).

## [0.5.6] – 2026-06-28

### Fixed
- **Agent ohne Tools leitete nie weiter:** Über die Admin-UI angelegte Agents hatten `tools: []`,
  womit das LLM weder `transfer_call` noch `end_call` kannte (Agent „redete" über Weiterleiten,
  löste es aber nie aus). Jetzt: (a) der Resolver behandelt leere/fehlende `tools` als Default
  `["transfer_call","end_call"]`, (b) das Agent-Formular hat ein **Tools-Feld** (Komma-getrennt,
  Default `transfer_call, end_call`).

## [0.5.5] – 2026-06-28

### Fixed
- **DDI-Matching vereinheitlicht:** `normalizePhone` entfernt jetzt den internationalen Präfix
  (`+` **oder** `00`), sodass `+49236298381975`, `0049236298381975` und `49236298381975` (so liefert
  der Trunk die DDI) auf dieselbe Form matchen. Vorher matchte ein gespeichertes `+49…` nicht gegen
  die vom Trunk gelieferte `49…`. Ausgehende Wahl nutzt weiterhin garantiertes E.164 mit `+`.

## [0.5.4] – 2026-06-28

Ausgehende Anrufe / externer Transfer über den Trunk.

### Added
- **Externer Transfer über den SIP-Trunk:** `transfer_call` erkennt externe Ziele (PSTN/Mobil) und
  wählt über `PJSIP/<e164>@TRUNK_OUTBOUND_ENDPOINT` raus; interne Durchwahlen bleiben wie bisher.
- **Absender-Rufnummer (CLIP) steuerbar:** SIP-Header `P-Preferred-Identity` (sipgate-Format `49…`).
  Installations-ENV **`TRUNK_CLIP_NO_SCREENING`** + Agent-Feld **`useTransferCallerId`** (Admin-UI-Toggle):
  an + erlaubt ⇒ Original-Anrufernummer (transparente Weiterleitung), sonst eigene Agent-Nummer
  (`targetNumbers[0]`, Fallback **`OUTBOUND_CALLER_ID`**). Neuer ENV `TRUNK_OUTBOUND_ENDPOINT`.
- `util/phone.ts`: `looksExternal()` + `toSipgateCli()` (analog sipgate-`dialhook`), mit Tests.

### Changed
- `docs/configuration.md`: Abschnitt „Ausgehende Anrufe / externer Transfer" + neue ENV-Parameter.

## [0.5.3] – 2026-06-28

Live-Trunk-Härtung (erster echter sipgate-Anruf auf der Appliance).

### Added
- **NAT hinter Docker:** `PUBLIC_IP` (+ `LOCAL_NETS`) — der entrypoint annonciert die öffentliche
  IP via `external_media_address`/`external_signaling_address` und setzt `rtp_symmetric`/`force_rport`/
  `rewrite_contact` am Trunk-Endpoint. Verhindert einseitiges/stummes RTP hinter Container-NAT.
  Best-effort-Auto-Erkennung, wenn leer und Trunk aktiv.
- **`CALL_DEDUP_WINDOW_MS`** (Default 4000): verwirft Doppel-INVITEs mancher Trunks (sipgate stellt
  einen Anruf als zwei parallele Dialoge zu) → keine doppelten Sessions/Requests/Summaries mehr.

### Changed
- `docs/configuration.md`: neue ENV-Parameter, Abschnitt „NAT hinter Docker" (inkl. Host-Modus-Ports
  bei Swarm/EasyPanel) und Hinweis auf die `#`-Falle in ENV-Editoren beim Admin-Passwort.

## [0.5.2] – 2026-06-28

### Changed
- README: Feature-Liste (Emojis), Admin-UI-Screenshots (4-spaltig), **B2B-Positionierung**
  (Anwendungsfälle, Self-hosted-vs-SaaS-Vergleich, Kontakt → Jungherz GmbH), **MonaHilft** verlinkt.
- README **zweisprachig**: englische `README.md` als Default (international) + deutsche
  `README.de.md`, mit gegenseitigem 🇬🇧/🇩🇪-Sprach-Umschalter.
- GitHub-Repo-Beschreibung + Topics gesetzt (Auffindbarkeit/SEO).

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
