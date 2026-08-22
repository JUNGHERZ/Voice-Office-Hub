# WebRTC-Web-Widget (einbettbares Browser-Softphone)

Seit 0.6.9 kann jeder Agent zusätzlich zu seinen Rufnummern über ein **einbettbares Web-Widget** angerufen werden: Website-Besucher klicken einen Button, der Browser baut per **SIP over WebSocket** (chan_pjsip) einen Anruf zu Asterisk auf, und ab da läuft **exakt der bestehende Telefonie-Pfad** — Stasis → Engine → Voice-Session, inklusive Live-Ansicht, Transkript, Aufnahme, Summary und Metriken. Die Engine wurde dafür nicht angefasst (einzige Ausnahme: das optionale Transkript-Token, s. u.).

## Architektur

```
Kunden-Website                     Appliance
┌──────────────────────┐            ┌──────────────────────────────────────────┐
│ <script widget.js>   │            │ TLS-Proxy (EasyPanel/Traefik, OrbStack …)│
│  └─ Button + iframe ─┼─ https ───▶│   └─ ALLES → Admin-Server (8080)         │
│      /widget/<key>   │            │        ├─ UI / API / Widget-Seiten       │
│                      │── wss ────▶│        └─ /ws ──proxy──▶ Asterisk :8088  │
│  SIP.js (im iframe)  │            │             (loopback, trägt auch ARI)   │
│                      │◀─ SRTP ───▶│ Asterisk: transport-ws → [webrtc-inbound]│
└──────────────────────┘  (ICE,     │  └─ _XXX → Stasis → Engine (unverändert) │
                      10000-10100)  └──────────────────────────────────────────┘
```

**Ein einziger öffentlicher Port (8080) trägt alles** — UI, API, Widget und den SIP-WebSocket: der Admin-Server proxyt `/ws` loopback-intern an Asterisks HTTP-Server durch. Dadurch funktioniert jeder simple TLS-Proxy davor ohne Pfad-Sonderrouten (EasyPanel-Domain, OrbStack-`*.orb.local`, nginx …), und Asterisks HTTP-Server (der auch ARI trägt) bleibt auf `127.0.0.1` gehärtet.

- **Route:** Der Browser wählt die **Pseudo-Durchwahl** des Agenten (`widget.exten`, z. B. `120`). Sie muss auch in `targetNumbers` stehen — dann greift das normale DDI-Routing. Seit 0.6.12 verwaltet der Server beides automatisch: Beim Aktivieren des Widgets wird eine freie 3-stellige Nummer vergeben (bzw. eine vorhandene 3-stellige DDI mitgenutzt) und in `targetNumbers` ergänzt; API-Clients können weiterhin explizit eine `exten` setzen.
- **Eigener Dialplan-Context `[webrtc-inbound]`:** Web-Anrufer können NUR 3-stellige Pseudo-DDIs wählen (kein Echo-Test, keine E.164-Nummern) — begrenzt den Missbrauchsradius. Die Caller-ID wird pro Anruf eindeutig gesetzt (`web-<uniqueid>`): kollidiert nie mit dem Doppel-INVITE-Dedup und ist in der Anrufliste als „Web" erkennbar.
- **Medien:** WebRTC (DTLS-SRTP, ICE) über die **bestehende RTP-Range 10000–10100/udp**; Codecs `opus,ulaw,alaw` (Ubuntu-Asterisk bringt `codec_opus_open_source` mit; Fallback G.711 ist in jedem Browser Pflicht). `WEBRTC_CODECS` übersteuert.

## Aktivierung

1. `.env`: `WEBRTC_ENABLED=true` (Kill-Switch; Default aus — dann existiert weder Transport noch Endpoint, und alle Widget-Endpoints liefern 404).
2. Agent-Formular → Sektion **„Web-Widget"**: aktivieren, erlaubte Websites eintragen, speichern → **Widget-Key** und **Pseudo-Durchwahl** werden server-seitig vergeben (die Durchwahl erscheint danach automatisch unter den Zielrufnummern).
3. Snippet auf der Kunden-Website einbinden (Button unten rechts):

```html
<script src="https://<appliance-domain>/widget.js" data-widget-key="<KEY>" async></script>
```

Optional: `data-position="bottom-left"`. Zum Testen ohne fremde Website: `https://<appliance-domain>/widget-demo.html?key=<KEY>`.

## Sicherheitsmodell (Threat-Model)

Zwei getrennte Schutzschichten — wichtig zum Verständnis:

1. **Wer darf einbetten? → `widget.allowedOrigins`** wird als `Content-Security-Policy: frame-ancestors` auf der iframe-Seite (`GET /widget/<key>`) durchgesetzt. Fremde Websites können das Widget **nicht** einbetten; die Appliance-Domain (`'self'`, Demo-Seite) ist immer erlaubt.
2. **Wer bekommt SIP-Zugangsdaten? → `POST /api/widget/session`** (öffentlich, aber): Kill-Switch, gültiger + aktivierter Key, Origin-Prüfung, Rate-Limits pro IP und pro Key, Deckel für gleichzeitige Web-Anrufe (`WIDGET_MAX_CONCURRENT`). Erst dann liefert er WS-URL + SIP-Credentials.

3. **Wird der Anruf zugelassen? → das Anruf-Token** (0.11.0). `POST /api/widget/session` prägt je Anruf ein Token (`callToken`), merkt sich `Token → Agent` mit kurzer Frist und gibt es zurück; der Client setzt es als SIP-Header `X-Widget-Token`. Beim `StasisStart` löst die Engine es ein: unbekannt, abgelaufen, schon verbraucht oder für einen **anderen** Agenten ausgestellt → der Anruf endet **vor** dem Answer, ohne Gesprächsdatensatz und ohne Kosten. Eine `info`-Zeile nennt den Grund (`missing`, `unknown`, `expired`, `consumed`, `foreign-agent`) — ohne sie sähe ein falsch konfiguriertes Widget aus wie „Anrufer legen sofort auf".

**Dieselbe Liste gilt für beides** (seit 0.10.2). Der Fetch aus einem eingebetteten iframe trägt die Origin der **einbettenden** Seite — ohne diese Kopplung ließe sich das Widget nur auf der Appliance selbst betreiben. Erlaubt sind also die Appliance-Domain und die Einträge aus `widget.allowedOrigins`; alles andere bleibt bei 403. **Leere Liste = unverändertes Verhalten** (nur die Appliance selbst). Die Einträge werden für beide Zwecke gleich gelesen (CSP-Semantik): `https://*.kunde.de` deckt Unterdomänen ab, **nicht** `https://kunde.de` selbst; Schema und Port müssen übereinstimmen. Ein Eintrag, der die Einbettung erlaubt, erlaubt damit auch die Session — und umgekehrt.

Beachte, was das Freischalten bedeutet: Eine gelistete Seite darf SIP-Zugangsdaten abholen, also mit dem Agenten sprechen. Das ist dieselbe Exposure-Klasse wie unten beschrieben — begrenzt durch Rate-Limits, Concurrent-Deckel und Kill-Switch, nicht durch die Liste.

Das SIP-Passwort ist ein **Deployment-Secret** (`WIDGET_SIP_PASSWORD`, sonst pro Container-Start frisch generiert). Seit 0.11.0 reicht es allein aber nicht mehr: Ohne eingelöste Sitzung endet ein Web-INVITE vor dem Answer. **Worst Case bei Leak:** abgewiesene INVITEs — kein Gespräch, keine API-Kosten, kein Datensatz. Echte ephemere SIP-Zugangsdaten je Sitzung wären der direktere Weg, setzen aber dynamische PJSIP-Konfiguration voraus (Realtime oder ein Reload je Sitzung); die Appliance schreibt `pjsip_webrtc.conf` einmal beim Containerstart. Das Anruf-Token erreicht dasselbe Schutzziel ohne dieses Gerüst.

**Wenn `WIDGET_REQUIRE_SESSION=false` gesetzt ist**, gilt der Absatz oben nicht: Dann ist das SIP-Passwort wieder das einzige Merkmal, und ein Angreifer kann mit dem KI-Agenten sprechen (API-Kosten) — dieselbe Exposure-Klasse wie die öffentliche Rufnummer des Agenten. Er kann **nicht** über den Trunk raustelefonieren (der Context kennt keine E.164-Ziele). Gegenmittel: Kill-Switch, Rate-Limits, Container-Neustart (neues Passwort), „Schlüssel rotieren" im Agent-Formular (macht geleakte Embed-Keys wertlos).

**Restrisiko, bis 0.10.x:** Mit den SIP-Credentials waren alle 3-stelligen Extens im `[webrtc-inbound]`-Context wählbar — also auch andere Agents. Wo je Agent abgerechnet wird, war das eine Kostenverschiebung zwischen Mandanten. Die Sitzungsbindung schließt das: Ein Token gilt für **den** Agenten, für den es ausgestellt wurde. Mit `WIDGET_REQUIRE_SESSION=false` besteht das Restrisiko fort — Passthrough-Agents (deren ausgehendes Bein Geld kostet) sollten dann keine 3-stellige Exten tragen, solange das Widget aktiv ist.

### Sitzung über einen Vermittler statt aus dem Browser

Wird die Sitzung serverseitig geholt — damit der Widget-Schlüssel den Browser nie erreicht —, zählt `WIDGET_SESSION_RATE_IP` nicht mehr Besucher, sondern Worker: Aus „10 pro Minute und Besucher" wird „10 pro Minute für die ganze Appliance". Deshalb wertet `POST /api/widget/session` optional den Header `x-api-key` aus (derselbe Schlüssel wie für die Management-API). Stimmt er, **entfällt die IP-Prüfung** — ein authentifizierter Aufrufer ist ein Vermittler, kein Besucher, und bringt sein eigenes Gate mit.

Was **bleibt**: der Deckel je Widget-Schlüssel (`WIDGET_SESSION_RATE_KEY`, wirkt je Agent und ist damit die passende Größe für einen Vermittler), `WIDGET_MAX_CONCURRENT`, der Kill-Switch, die Origin-Prüfung und die Sitzungsbindung. Ohne den Header ändert sich nichts; ein **falscher** Header steht wie gar keiner.

Zwei Punkte dazu:

- Ein Server-zu-Server-Aufruf schickt keinen `Origin`, und ohne diesen Header lässt der Endpunkt seit jeher durch — ein Vermittler braucht also **keinen** Eintrag in `allowedOrigins`. Schickt sein HTTP-Client doch einen, muss der Wert gelistet sein (sonst 403, und der Fehler wird beim Schlüssel gesucht).
- `ADMIN_API_KEY` ist der volle Management-Schlüssel. Ein eigener, schmalerer wäre sauberer, wäre hier aber Fassade: Wer Agenten samt `widget.allowedOrigins` über die API anlegt, hält ihn ohnehin. Ein zweites Geheimnis brächte keine Trennung, nur eine zweite Rotationspflicht.

## Live-Transkript im Widget (optional)

Das Widget kann das Gespräch live mitschreiben (einklappbares Panel „Transkript anzeigen"), abschaltbar pro Agent (`widget.showTranscript`). Mechanik: Das Widget generiert pro Anruf ein 128-bit-Token und sendet es als SIP-Header `X-Widget-Token`; der Dialplan reicht es als drittes Stasis-Argument durch, die Engine speichert es am Request. `GET /api/widget/call/<token>` liefert dann Status + Transkript-Turns (Polling alle 2 s) — nur für laufende Anrufe plus 120 s Nachlauf, rate-limitiert, Token nie erratbar.

## Sprech-Animation

Der „Orb" im Widget pulsiert **echt pegelgesteuert**: ein Web-Audio-`AnalyserNode` misst das Agent-Audio (ein zweiter dezent das eigene Mikrofon — kleiner Punkt). Der schwebende Button der Kundenseite erhält per postMessage nur grobe Zustände (`idle/connecting/in-call/agent-speaking`) — nie Audio oder Inhalte. `prefers-reduced-motion` wird respektiert.

## Betrieb

### Lokal (OrbStack)

`WEBRTC_ENABLED=true` in der `.env`, Container neu bauen/starten — mehr nicht: `/ws` läuft über den normalen Admin-Port 8080. Demo per `http://localhost:8080/widget-demo.html?key=<KEY>` (Chrome erlaubt Mikrofon auf localhost) **oder** über die OrbStack-HTTPS-Domain `https://voh-appliance.orb.local/widget-demo.html?key=<KEY>` — dank Single-Port-Design funktioniert auch dieses TLS-Tunneling ohne Zusatzkonfiguration.

### Produktion (EasyPanel/Traefik, arm2-Muster)

- **Kein neuer Host-Port, keine Sonderroute.** Die bestehende Domain (→ interner Port 8080) reicht — `/ws` proxyt der Admin-Server selbst. `/ari` bleibt komplett intern (Asterisks HTTP-Server hört weiter nur auf 127.0.0.1).
- **Medien:** Die RTP-Range 10000–10100/udp ist für den Trunk bereits **host-mode** publiziert — WebRTC nutzt dieselbe Range. `PUBLIC_IP` muss gesetzt sein (ICE/SDP), sonst droht einseitiges Audio.
- **Verifikation nach Redeploy:** `pjsip show transports` (transport-ws), `http show status` (/ws-Handler), `curl -i https://<domain>/ws` → 426; Browser-Test mit `chrome://webrtc-internals` (Candidate-Pair = `PUBLIC_IP:10000-10100`).

### Grenzen / Ausbaustufen

- **TURN:** Besucher hinter symmetrischem NAT/UDP-blockenden Firewalls (~5–10 %) scheitern ohne TURN-Server. V1 nutzt STUN (`WIDGET_STUN_SERVER`); ein TURN-Eintrag ist eine dokumentierte Ausbaustufe (die `iceServers`-Liste der Session-Antwort ist der Andockpunkt).
- **Ephemere SIP-Credentials** (statt Deployment-Passwort) und ein Engine-seitiges Admission-Control pro Agent sind spätere Härtungsstufen.

## ENV-Referenz

| Variable | Default | Zweck |
| --- | --- | --- |
| `WEBRTC_ENABLED` | `false` | Kill-Switch für Transport, Endpoint und alle Widget-Endpoints. |
| `WIDGET_SIP_PASSWORD` | *(generiert)* | Deployment-SIP-Passwort des Widget-Endpoints; leer = pro Container-Start frisch. |
| `WIDGET_SIP_USER` | `webwidget` | SIP-Benutzer des Widget-Endpoints. |
| `WEBRTC_CODECS` | `!all,opus,ulaw,alaw` | Codec-Liste des Endpoints (bei Opus-Problemen: `!all,ulaw,alaw`). |
| `WIDGET_STUN_SERVER` | Google-STUN | ICE-Server für den Browser. |
| `WIDGET_WS_URL` | *(leer)* | Feste WS-URL (Sonder-Proxys); leer = aus dem Request-Host abgeleitet. |
| `WIDGET_MAX_CONCURRENT` | `5` | Max. gleichzeitige Web-Anrufe. |
| `WIDGET_SESSION_RATE_IP` / `_KEY` | `10` / `30` | Session-Anfragen pro Minute (IP / Key). Der IP-Deckel entfällt bei gültigem `x-api-key` (siehe „Sitzung über einen Vermittler"). |
| `WIDGET_REQUIRE_SESSION` *(0.11.0)* | `true` | Web-Anruf nur mit eingelöster Sitzung. `false` = Verhalten vor 0.11.0 (Notausgang für einen Fremdclient, der das Anruf-Token noch nicht mitschickt). |
| `WIDGET_SESSION_TTL_SEC` *(0.11.0)* | `300` | Wie lange eine ausgestellte Sitzung auf ihr INVITE warten darf. Zwischen beidem liegt die Mikrofon-Freigabe des Browsers — knapper anzusetzen lässt echte Anrufe an der Nachfrage scheitern. |
