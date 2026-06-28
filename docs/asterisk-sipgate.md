# Asterisk-Anbindung & SIPGate Trunking

Diese Komponente erwartet, dass **Asterisk** eingehende Anrufe per **ARI** an die Stasis-App
`voice-office-hub` übergibt. Asterisk kann **im selben Container** laufen (`EMBED_ASTERISK=true`,
Default für Dev/Appliance) oder **extern** als PBX (`EMBED_ASTERISK=false`).

Beispielkonfiguration liegt unter [docker/asterisk/](../docker/asterisk/) und wird beim
Container-Start nach `/etc/asterisk/` eingespielt, falls dort noch keine Config existiert.

## 1. Voraussetzungen in Asterisk

- **HTTP/ARI aktiv** ([http.conf](../docker/asterisk/http.conf), [ari.conf](../docker/asterisk/ari.conf)).
  ARI-User/Passwort müssen zu `ARI_USERNAME`/`ARI_PASSWORD` in der `.env` passen.
  ARI nur intern (localhost) erreichbar machen — **nicht** nach außen exponieren.
- **RTP-Portbereich** ([rtp.conf](../docker/asterisk/rtp.conf)) passend zu den im Container
  exponierten UDP-Ports (Default 10000–10100).
- **`direct_media = no`** auf dem Endpoint/Trunk — Pflicht, damit `externalMedia` greift
  (Medien müssen über Asterisk laufen).

## 2. Eingehende Anrufe an die Stasis-App übergeben

[extensions.conf](../docker/asterisk/extensions.conf):

```ini
[inbound]
exten = _X.,1,NoOp(Eingehender Anruf an ${EXTEN} von ${CALLERID(num)})
 same = n,Answer()
 same = n,Stasis(voice-office-hub,${EXTEN},${CALLERID(num)})
 same = n,Hangup()
```

`${EXTEN}` (volle E.164-Zielrufnummer/DDI) und `${CALLERID(num)}` werden als Stasis-Argumente
übergeben. Der Node-Kern nutzt die DDI für das **Agent-Routing**
(siehe [docs/configuration.md](configuration.md)) und legt Anrufer/Ziel im `requests`-Dokument ab.

## 3. Lokal testen ohne PSTN (SIP-Softphone)

Im Dev-Image ist ein lokaler PJSIP-Endpoint vorbereitet ([pjsip.conf](../docker/asterisk/pjsip.conf)):

- Endpoint/User: `softphone`, Passwort: `softphone`
- Im Softphone (Zoiper/Linphone) den Container-Host als SIP-Server (Port 5060) eintragen,
  als User `softphone` registrieren, dann die Test-Durchwahl **`100`** anrufen.

## 4. Produktion: SIPGate Trunking (DE)

SIPGate Trunking buchen, dem Trunk **Rufnummern (DDI)** zuordnen. Eingehende Anrufe werden mit
der vollen **E.164-Nummer in der Request-URI** signalisiert → pro Nummer im Dialplan / über
Agents routbar.

### 4a. Empfohlen: ENV-gesteuerter Trunk (Appliance)

Für die eingebettete Appliance (`EMBED_ASTERISK=true`) ist der **ENV-gesteuerte Trunk** der
empfohlene Weg — **kein manuelles Editieren der `pjsip.conf` nötig**. Die `TRUNK_*`-Variablen werden
beim Start vom [entrypoint](../docker/entrypoint.sh) zu `/etc/asterisk/pjsip_trunk.conf` generiert,
das [pjsip.conf](../docker/asterisk/pjsip.conf) per `#include pjsip_trunk.conf` lädt; bei
`TRUNK_ENABLED!=true` bleibt die Datei leer (kein Trunk). Details + ENV-Tabelle:
[configuration.md → SIP-Trunk (Appliance)](configuration.md#sip-trunk-appliance).

```bash
TRUNK_ENABLED=true
TRUNK_SIP_ID=<SIP-ID>
TRUNK_SIP_PASSWORD=<SIP-Passwort>
TRUNK_SERVER=sipconnect.sipgate.de      # Default
TRUNK_CODECS=!all,g722,alaw,ulaw        # Default
```

Der generierte Endpoint nutzt `context = inbound` → eingehende Anrufe laufen direkt in den Dialplan
(Abschnitt 2) und damit in die Stasis-App / das DDI-Agent-Routing.

### 4b. Manuelle Vorlage (Fallback / Referenz)

Die folgende Vorlage ist nur noch **manuelle Referenz** (z. B. für eine externe PBX oder zum
Verständnis dessen, was der entrypoint generiert). Für die Appliance Abschnitt 4a verwenden.

In [pjsip.conf](../docker/asterisk/pjsip.conf) die SIPGate-Vorlage aktivieren und `#SIPID#` /
`#SIPPASSWORD#` aus dem Trunk-Account einsetzen:

```ini
[sipgateregister]
type = registration
server_uri = sip:#SIPID#@sipconnect.sipgate.de
client_uri = sip:#SIPID#@sipconnect.sipgate.de
contact_user = inbound-calls
outbound_auth = sipgateauthreg

[sipgateauthreg]
type = auth
auth_type = userpass
username = #SIPID#
password = #SIPPASSWORD#

[sipgateauth]
type = auth
auth_type = userpass
username = #SIPID#
password = #SIPPASSWORD#

[sipgateendpoint]
type = endpoint
aors = sipgateaor
context = inbound
outbound_auth = sipgateauth
from_domain = sipconnect.sipgate.de
from_user = #SIPID#
allow = !all,g722,alaw,ulaw
direct_media = no
transport = transport-udp

[sipgateaor]
type = aor
contact = sip:sipconnect.sipgate.de

[sipgateidentify]
type = identify
match = sipconnect.sipgate.de
match = 217.10.68.150:5060
endpoint = sipgateendpoint
```

### Netzwerk/NAT & Härtung

- Nach außen nur **SIP (UDP 5060)** + **RTP-Portrange** (Default 10000–10100/udp) öffnen.
- Bei NAT die externe Adresse/Portrange in Asterisk-Transport bzw. via `external_media_address`
  korrekt setzen.
- **ARI (8088)** und der **Media-/externalMedia-Port (8090)** bleiben **intern** — nicht nach außen
  mappen.
- ARI-Zugang absichern: `ARI_PASSWORD` setzen (der entrypoint warnt bei leerem/Default-Wert
  `changeme`).
- Vollständige Härtungs-Leitlinien (Ports, Mongo-Mapping nur Dev, `ADMIN_API_KEY`/`x-api-key`,
  DSGVO): [configuration.md → Sicherheit / Härtung](configuration.md#sicherheit--härtung).

### Variante: externe PBX (`EMBED_ASTERISK=false`)

Läuft Asterisk **außerhalb** des Containers (bestehende PBX), dann `EMBED_ASTERISK=false` setzen.
Der Container startet dann **kein** eigenes Asterisk und die `TRUNK_*`-Variablen sind **ohne Wirkung**
(Trunk/Registrierung verwaltet die externe PBX). Dort manuell sicherstellen: Dialplan übergibt an die
Stasis-App `voice-office-hub` (Abschnitt 2), `direct_media=no`, ARI-User/Passwort passend zu
`ARI_USERNAME`/`ARI_PASSWORD`, und der Container erreicht die externe ARI-URL (`ARI_URL`) bzw. die
externe PBX erreicht `EXTERNAL_MEDIA_HOST/PORT`.

> Quellen: sipgate Hilfecenter „Asterisk für sipgate trunking", sipgate Trunking-Produktseite.
