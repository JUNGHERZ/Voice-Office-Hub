# SIP-Trunk-Anbieter (DACH) & Anbindung

Voice-Office-Hub bindet **einen** SIP-Trunk pro Appliance an — der **Anbieter ist aber frei wählbar**.
Die Anbindung wird vollständig über `TRUNK_*`-ENV-Variablen gesteuert; der
[entrypoint](../docker/entrypoint.sh) erzeugt daraus die PJSIP-Trunk-Config. Details zu allen
Variablen: [configuration.md](configuration.md#env-variablen).

> Mehrere Trunks gleichzeitig (Failover/Multi-Provider) sind bewusst **nicht** Teil dieser Stufe —
> eine Appliance = ein Trunk. Siehe [backlog.md](backlog.md).

## Die zwei Anbindungs-Modi

Welcher Modus gilt, steuert **`TRUNK_AUTH_MODE`**:

| Modus | Wann | Was der entrypoint erzeugt |
|---|---|---|
| **`register`** (Default) | Provider verlangt SIP-**Registrierung** mit Benutzer/Passwort | `registration` + `auth` + `endpoint` + `identify` |
| **`ip`** | Provider authentifiziert per **statischer IP** (kein Login) | nur `endpoint` + `identify` (Zuordnung über `TRUNK_MATCH`); `auth` nur, falls Credentials gesetzt |

**Absender-Rufnummer (CLIP)** bei ausgehenden Anrufen/Transfers steuert **`TRUNK_CLIP_HEADER`**
(`ppi` = `P-Preferred-Identity`, Default; `pai` = `P-Asserted-Identity`) zusammen mit
`OUTBOUND_CALLER_ID` bzw. dem Agent-Feld `useTransferCallerId` (siehe
[configuration.md → Ausgehende Anrufe](configuration.md#ausgehende-anrufe--externer-transfer)).
Wichtig: Viele Provider verlangen, dass die Absendernummer dem Account gehört **und** eine
**Fallback-/Standard-Absendernummer** im Provider-Portal hinterlegt ist (bei sipgate Pflicht-
Voraussetzung), sonst erscheint „unbekannt".

## Anbieter-Übersicht

| Anbieter | Region | `TRUNK_AUTH_MODE` | CLIP (`TRUNK_CLIP_HEADER`) | Hinweise |
|---|---|---|---|---|
| **sipgate** (sipconnect) | DE | `register` | `ppi` | Getestet/produktiv. Fallback-Absenderrufnummer im Trunk Pflicht für CLIP. `TRUNK_SERVER=sipconnect.sipgate.de` |
| **easybell** | DE | `register` | `ppi`/`from` | Sehr Asterisk-freundlich, günstig |
| **Placetel** (Cisco) | DE | `register` | `ppi` | Ausführliche PJSIP-Doku, viele Hersteller getestet |
| **fonial** | DE | `register` | `ppi` | KMU-Fokus |
| **Telekom CompanyFlex** | DE | `register` **oder** `ip` | `pai`/`from` | Löst DeutschlandLAN ab; Enterprise, eigene CLIP-Regeln; `TRUNK_MATCH` im IP-Modus |
| **Vodafone Anlagen-Anschluss** | DE | `ip` (meist) | `pai` | Enterprise |
| **1&1 Versatel** | DE | `ip` (meist) | `pai` | |
| **NFON / q.beyond / ecotel / toplink** | DE | gemischt | `pai`/`ppi` | Carrier/Enterprise |
| **Peoplefone** | DE/AT/CH | `register` | `ppi` | DACH-weit |
| **sipcall / Swisscom** | CH | `register`/`ip` | `ppi`/`pai` | |
| **A1 / Magenta** | AT | `ip` (meist) | `pai` | |
| **Twilio Elastic SIP / Telnyx / Vonage** | global | `ip` | `pai`/`from` | CPaaS, ideal für Voice-Agents; IP-ACL + optional Credentials, SRTP optional, E.164 |

> Die Spalten `TRUNK_AUTH_MODE`/`TRUNK_CLIP_HEADER` sind **Richtwerte** — die genauen Anforderungen
> stehen in der jeweiligen Provider-Doku. Im Zweifel beim Provider die SBC-/Gateway-IPs (für
> `TRUNK_MATCH`) und die geforderte CLIP-Methode erfragen.

## Beispiel-Konstellationen

### sipgate (Registrierung, Default)

```bash
TRUNK_ENABLED=true
TRUNK_AUTH_MODE=register
TRUNK_SIP_ID=<sipgate-SIP-ID>
TRUNK_SIP_PASSWORD=<sipgate-Passwort>
TRUNK_SERVER=sipconnect.sipgate.de
TRUNK_CLIP_HEADER=ppi
# CLIP-Voraussetzung: im sipgate-Trunk eine Fallback-Absenderrufnummer setzen.
OUTBOUND_CALLER_ID=<deine-DID-E164>     # z. B. 49236298381975 (ohne +/0)
```

### IP-basierter Trunk (z. B. Twilio Elastic SIP / Telekom CompanyFlex IP)

```bash
TRUNK_ENABLED=true
TRUNK_AUTH_MODE=ip
TRUNK_SERVER=<provider-sbc-host>            # Ziel für ausgehende INVITEs
TRUNK_MATCH=<sbc-ip-1>,<sbc-ip-2>          # Inbound-Zuordnung (identify) per IP
TRUNK_FROM_USER=<deine-rufnummer>          # falls Provider die Nummer im From erwartet
TRUNK_CLIP_HEADER=pai
# Optional, falls der Provider zusätzlich Credentials für Outbound verlangt:
TRUNK_SIP_ID=<id>
TRUNK_SIP_PASSWORD=<pw>
```

## NAT & Ports (providerunabhängig)

Hinter Docker-/Host-NAT immer `PUBLIC_IP` setzen (siehe
[configuration.md → NAT hinter Docker](configuration.md#nat-hinter-docker)). Nach außen nur
`5060/udp` + die RTP-Range freigeben; bei Orchestratoren (Swarm/EasyPanel) im **Host-Modus**.
