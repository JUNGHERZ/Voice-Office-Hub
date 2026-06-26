# Asterisk-Anbindung & SIPGate Trunking

Diese Komponente erwartet, dass **Asterisk** eingehende Anrufe per **ARI** an die Stasis-App
`voice-agent` übergibt. Asterisk kann **im selben Container** laufen (`EMBED_ASTERISK=true`,
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
 same = n,Stasis(voice-agent,${EXTEN},${CALLERID(num)})
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

### Netzwerk/NAT

- Nach außen nur **SIP (UDP 5060)** + **RTP-Portrange** öffnen.
- Bei NAT die externe Adresse/Portrange in Asterisk-Transport bzw. via `external_media_address`
  korrekt setzen.
- ARI (8088) und der externalMedia-UDP-Port bleiben **intern**.

> Quellen: sipgate Hilfecenter „Asterisk für sipgate trunking", sipgate Trunking-Produktseite.
