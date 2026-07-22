#!/usr/bin/env bash
set -euo pipefail

# Übersetzt fachliche ENV-Flags in supervisor-Schalter und bereitet Asterisk vor.
# So steuert eine einzige .env, welche Prozesse im Container laufen.

# UI-Port-Default
export UI_PORT="${UI_PORT:-8080}"

# Lokales MongoDB nur starten, wenn gewünscht (sonst externes MONGO_URI nutzen)
if [[ "${USE_LOCAL_MONGO:-true}" == "true" ]]; then
  export SUPERVISOR_MONGOD=true
else
  export SUPERVISOR_MONGOD=false
fi

# Asterisk nur im Appliance-/Dev-Modus starten (sonst externe PBX)
if [[ "${EMBED_ASTERISK:-true}" == "true" ]]; then
  export SUPERVISOR_ASTERISK=true
  # Härtung: vor leerem/Default-ARI-Passwort warnen (ARI ist nur intern, trotzdem setzen).
  if [[ -z "${ARI_PASSWORD:-}" || "${ARI_PASSWORD}" == "changeme" ]]; then
    echo "WARNUNG: ARI_PASSWORD ist leer oder Default ('changeme') — in Produktion unbedingt setzen!"
  fi
  # ARI-Passwort aus der .env in die ari.conf injizieren (single source of truth).
  if [[ -n "${ARI_PASSWORD:-}" && -f /etc/asterisk/ari.conf ]]; then
    sed -i "s/^password = .*/password = ${ARI_PASSWORD}/" /etc/asterisk/ari.conf
  fi
else
  export SUPERVISOR_ASTERISK=false
fi

# Admin-UI nur starten, wenn ein Passwort gesetzt ist
if [[ -n "${ADMIN_PASSWORD:-}" ]]; then
  export SUPERVISOR_ADMIN=true
else
  export SUPERVISOR_ADMIN=false
fi

# Öffentliche IP FRÜH auflösen — sie wird sowohl vom NAT-Rewrite (unten) als auch von der
# WebRTC-Transport-Generierung gebraucht. Explizit setzen (PUBLIC_IP, empfohlen) oder bei
# aktivem Trunk/WebRTC best-effort automatisch ermitteln.
PUBLIC_IP="${PUBLIC_IP:-${EXTERNAL_IP:-}}"
# Merken, ob die IP explizit konfiguriert wurde: Nur dann werden unten ICE-Host-Kandidaten
# umgeschrieben (auto-erkannte IP = vermutlich Direktrouting wie OrbStack; Umschreiben
# würde dort den funktionierenden lokalen Medienpfad durch Hairpin-NAT ersetzen).
PUBLIC_IP_EXPLICIT="false"; [[ -n "${PUBLIC_IP}" ]] && PUBLIC_IP_EXPLICIT="true"
if [[ "${EMBED_ASTERISK:-true}" == "true" && -z "${PUBLIC_IP}" ]] \
   && [[ "${TRUNK_ENABLED:-false}" == "true" || "${WEBRTC_ENABLED:-false}" == "true" ]]; then
  PUBLIC_IP="$(curl -fsS --max-time 3 https://api.ipify.org 2>/dev/null || true)"
  [[ -n "${PUBLIC_IP}" ]] && echo "entrypoint: PUBLIC_IP automatisch ermittelt: ${PUBLIC_IP}"
fi

# SIP-Trunk (Appliance, ENV-gesteuert). Erzeugt /etc/asterisk/pjsip_trunk.conf, das pjsip.conf
# per #include lädt. Leer, wenn TRUNK_ENABLED!=true. Mehrere Trunks / Admin-UI-Verwaltung später
# (Datenmodell N-Trunk-fähig vorgesehen) — siehe docs/backlog.md.
TRUNK_FILE=/etc/asterisk/pjsip_trunk.conf
if [[ "${EMBED_ASTERISK:-true}" == "true" && "${TRUNK_ENABLED:-false}" == "true" ]]; then
  TRUNK_SERVER="${TRUNK_SERVER:-sipconnect.sipgate.de}"
  TRUNK_CODECS="${TRUNK_CODECS:-!all,g722,alaw,ulaw}"
  # Anbindungsmodus: "register" (Provider verlangt SIP-Registrierung, z. B. sipgate/easybell/
  # Placetel) oder "ip" (statische IP-Authentifizierung, z. B. Telekom CompanyFlex/Twilio).
  TRUNK_AUTH_MODE="${TRUNK_AUTH_MODE:-register}"
  # Provider-Hosts/IPs für die Inbound-Zuordnung (identify), Komma-getrennt. Default = Server.
  TRUNK_MATCH="${TRUNK_MATCH:-$TRUNK_SERVER}"
  # Absender-User im From-Header (Default = SIP-ID). Manche Provider wollen hier die Rufnummer.
  TRUNK_FROM_USER="${TRUNK_FROM_USER:-${TRUNK_SIP_ID:-}}"

  if [[ "$TRUNK_AUTH_MODE" == "register" ]]; then
    : "${TRUNK_SIP_ID:?register-Modus erfordert TRUNK_SIP_ID}"
    : "${TRUNK_SIP_PASSWORD:?register-Modus erfordert TRUNK_SIP_PASSWORD}"
  fi
  # Outbound-Auth einbinden, sobald Credentials vorhanden (auch IP-Trunks brauchen oft Auth).
  HAS_AUTH=false; [[ -n "${TRUNK_SIP_PASSWORD:-}" ]] && HAS_AUTH=true

  echo "; AUTO-GENERIERT vom entrypoint aus ENV (TRUNK_*). Nicht manuell editieren." > "$TRUNK_FILE"

  if [[ "$TRUNK_AUTH_MODE" == "register" ]]; then
    cat >> "$TRUNK_FILE" <<EOF

[trunk-reg]
type = registration
server_uri = sip:${TRUNK_SIP_ID}@${TRUNK_SERVER}
client_uri = sip:${TRUNK_SIP_ID}@${TRUNK_SERVER}
contact_user = inbound-calls
outbound_auth = trunk-auth-reg

[trunk-auth-reg]
type = auth
auth_type = userpass
username = ${TRUNK_SIP_ID}
password = ${TRUNK_SIP_PASSWORD}
EOF
  fi

  if [[ "$HAS_AUTH" == "true" ]]; then
    cat >> "$TRUNK_FILE" <<EOF

[trunk-auth]
type = auth
auth_type = userpass
username = ${TRUNK_SIP_ID}
password = ${TRUNK_SIP_PASSWORD}
EOF
  fi

  cat >> "$TRUNK_FILE" <<EOF

[trunk-endpoint]
type = endpoint
aors = trunk-aor
context = inbound
from_domain = ${TRUNK_SERVER}
from_user = ${TRUNK_FROM_USER}
allow = ${TRUNK_CODECS}
direct_media = no
transport = transport-udp
; NAT-Traversal (Asterisk hinter Docker-/Host-NAT): RTP auf die tatsächliche
; Gegenstelle zurücklatchen und Antworten an den sichtbaren Absender schicken.
rtp_symmetric = yes
force_rport = yes
rewrite_contact = yes
EOF
  [[ "$HAS_AUTH" == "true" ]] && echo "outbound_auth = trunk-auth" >> "$TRUNK_FILE"

  cat >> "$TRUNK_FILE" <<EOF

[trunk-aor]
type = aor
contact = sip:${TRUNK_SERVER}

[trunk-identify]
type = identify
endpoint = trunk-endpoint
EOF
  IFS=',' read -ra _matches <<< "$TRUNK_MATCH"
  for m in "${_matches[@]}"; do m="${m// /}"; [[ -n "$m" ]] && echo "match = ${m}" >> "$TRUNK_FILE"; done

  echo "entrypoint: SIP-Trunk aktiviert (Modus ${TRUNK_AUTH_MODE}, Server ${TRUNK_SERVER})"
else
  echo "; Kein Trunk aktiv (TRUNK_ENABLED!=true)." > "$TRUNK_FILE"
fi

# Lokale Dev-Softphones (Zoiper/Linphone). Standard AUS — sonst läge auf einer öffentlich
# erreichbaren Appliance ein ratbarer SIP-Account am offenen 5060/udp, den SIP-Scanner
# brute-forcen und damit Anrufe in unsere Stasis-App einschleusen könnten. Nur lokal aktivieren.
LOCAL_FILE=/etc/asterisk/pjsip_local.conf
if [[ "${EMBED_ASTERISK:-true}" == "true" && "${DEV_SOFTPHONE_ENABLED:-false}" == "true" ]]; then
  SP_PASS="${DEV_SOFTPHONE_PASSWORD:-softphone}"
  SP101_PASS="${DEV_SOFTPHONE_101_PASSWORD:-101}"
  echo "WARNUNG: DEV_SOFTPHONE_ENABLED=true — lokale SIP-Testkonten (softphone/101) aktiv."
  echo "         NIEMALS auf einem öffentlich erreichbaren Host aktivieren (5060/udp wird gescannt)!"
  cat > "$LOCAL_FILE" <<EOF
; AUTO-GENERIERT vom entrypoint (DEV_SOFTPHONE_ENABLED=true). NUR für lokale Tests.
; Kurze Registrierungs-Gültigkeit (AOR *_expiration unten): Ein Container-Neustart wirft
; alle Registrierungen weg; bis das Softphone von sich aus neu registriert, scheitert
; AUSGEHENDE Wahl an es ("invalid URI … Is endpoint registered?"), z. B. transfer_call → 101.
; Eingehend fällt das nie auf (INVITE + Digest-Auth braucht keine Registrierung) — deshalb
; klemmt nach einem Rebuild scheinbar "nur der Transfer". Mit expiry ≤ 60 s registrieren
; Clients im Minutentakt neu → das Fenster ist praktisch weg.
[softphone]
type = endpoint
context = inbound
disallow = all
allow = ulaw,alaw,g722,slin16
auth = softphone-auth
aors = softphone
direct_media = no

[softphone-auth]
type = auth
auth_type = userpass
username = softphone
password = ${SP_PASS}

[softphone]
type = aor
max_contacts = 1
minimum_expiration = 30
default_expiration = 60
maximum_expiration = 90

; Zweites Softphone als Transfer-Ziel: registriert sich als User "101".
[101]
type = endpoint
context = inbound
disallow = all
allow = ulaw,alaw,g722,slin16
auth = 101-auth
aors = 101
direct_media = no

[101-auth]
type = auth
auth_type = userpass
username = 101
password = ${SP101_PASS}

[101]
type = aor
max_contacts = 1
minimum_expiration = 30
default_expiration = 60
maximum_expiration = 90
EOF
  echo "entrypoint: lokale Dev-Softphones aktiviert (softphone, 101)"
else
  echo "; Keine lokalen Softphones (DEV_SOFTPHONE_ENABLED!=true)." > "$LOCAL_FILE"
fi

# WebRTC-Web-Widget (0.6.9): SIP-over-WebSocket-Transport + Endpoint für das Browser-
# Softphone. Das SIP-Passwort ist ein Deployment-Secret: aus der ENV oder pro
# Container-Start frisch generiert; der export macht es dem Admin-Prozess sichtbar,
# der es NUR über den key-geschützten Session-Endpoint ausliefert.
WEBRTC_FILE=/etc/asterisk/pjsip_webrtc.conf
if [[ "${EMBED_ASTERISK:-true}" == "true" && "${WEBRTC_ENABLED:-false}" == "true" ]]; then
  export WIDGET_SIP_PASSWORD="${WIDGET_SIP_PASSWORD:-$(od -An -N16 -tx1 /dev/urandom | tr -d ' \n')}"
  WEBRTC_CODECS="${WEBRTC_CODECS:-!all,opus,ulaw,alaw}"

  {
    echo "; AUTO-GENERIERT vom entrypoint (WEBRTC_ENABLED=true)."
    echo "; Browser verbinden sich über wss://<domain>/ws (Traefik terminiert TLS) bzw."
    echo "; lokal über ws://localhost:8088/ws — hier kommt der Hop als plain ws an."
    echo "[transport-ws]"
    echo "type = transport"
    echo "protocol = ws"
    echo "bind = 0.0.0.0"
    if [[ -n "${PUBLIC_IP}" ]]; then
      echo "external_media_address = ${PUBLIC_IP}"
      echo "external_signaling_address = ${PUBLIC_IP}"
      IFS=',' read -ra _wnets <<< "${LOCAL_NETS:-10.0.0.0/8,172.16.0.0/12,192.168.0.0/16}"
      for n in "${_wnets[@]}"; do echo "local_net = ${n}"; done
    fi
  } > "$WEBRTC_FILE"

  cat >> "$WEBRTC_FILE" <<EOF

; webrtc=yes impliziert: use_avpf, ice_support, media_encryption=dtls, rtcp_mux,
; dtls_verify=fingerprint. Eigener Context begrenzt, was ein Web-Anrufer wählen kann.
[webwidget]
type = endpoint
context = webrtc-inbound
disallow = all
allow = ${WEBRTC_CODECS}
webrtc = yes
dtls_auto_generate_cert = yes
auth = webwidget-auth
aors = webwidget
direct_media = no
rtp_symmetric = yes
force_rport = yes
rewrite_contact = yes
callerid = Web-Widget <web>

[webwidget-auth]
type = auth
auth_type = userpass
username = ${WIDGET_SIP_USER:-webwidget}
password = ${WIDGET_SIP_PASSWORD}

[webwidget]
type = aor
max_contacts = 1
EOF

  # Asterisks HTTP-Server bleibt bewusst auf 127.0.0.1 (Härtung, trägt auch ARI):
  # den /ws-Endpoint proxyt der Admin-Server (Port 8080) loopback-intern durch.
  grep -q websocket_write_timeout /etc/asterisk/http.conf || \
    echo "websocket_write_timeout = 10000" >> /etc/asterisk/http.conf
  # ICE für WebRTC-Medien (Browser <-> Asterisk über die bestehende RTP-Range).
  grep -q icesupport /etc/asterisk/rtp.conf || \
    printf 'icesupport = yes\n' >> /etc/asterisk/rtp.conf
  # Hinter Docker-NAT (Swarm/EasyPanel) annonciert Asterisk sonst nur container-interne
  # ICE-Host-Kandidaten (172.18.x/10.x) — vom Browser unerreichbar => null Media in beide
  # Richtungen trotz sauberer Signalisierung. Bei EXPLIZIT gesetzter PUBLIC_IP wird der
  # Kandidat der Default-Route auf die öffentliche IP umgeschrieben (RTP-Ports sind
  # host-publiziert). Idempotent über Marker-Block (Restart mit neuer Container-IP).
  sed -i '/^; VOH-ICE-BEGIN/,/^; VOH-ICE-END/d' /etc/asterisk/rtp.conf
  if [[ "${PUBLIC_IP_EXPLICIT}" == "true" && -n "${PUBLIC_IP}" ]]; then
    # Alle Container-IPs mappen (Swarm hat mehrere Overlays; iproute2 fehlt im Image,
    # und welches Interface die Default-Route trägt, ist damit egal).
    ICE_LOCAL_IPS="$(hostname -I 2>/dev/null || true)"
    if [[ -n "${ICE_LOCAL_IPS// /}" ]]; then
      {
        echo "; VOH-ICE-BEGIN (auto-generiert: Docker-NAT -> öffentlicher ICE-Kandidat)"
        echo "[ice_host_candidates]"
        for LIP in ${ICE_LOCAL_IPS}; do
          echo "${LIP} => ${PUBLIC_IP}"
        done
        echo "; VOH-ICE-END"
      } >> /etc/asterisk/rtp.conf
      echo "entrypoint: ICE-Host-Kandidaten (${ICE_LOCAL_IPS% }) -> ${PUBLIC_IP} (rtp.conf)"
    fi
  else
    echo "entrypoint: PUBLIC_IP nicht explizit gesetzt — ICE behält lokale Kandidaten (Direktrouting, z. B. OrbStack)."
  fi
  if [[ -z "${PUBLIC_IP}" ]]; then
    echo "WARNUNG: WEBRTC_ENABLED=true ohne PUBLIC_IP — hinter NAT droht einseitiges Audio (lokal via OrbStack ok)."
  fi
  echo "entrypoint: WebRTC-Widget aktiviert (Endpoint webwidget; /ws kommt via Admin-Proxy :8080)"
else
  echo "; Kein WebRTC (WEBRTC_ENABLED!=true)." > "$WEBRTC_FILE"
fi

# NAT: Läuft Asterisk hinter Docker-/Host-NAT (z. B. Container mit öffentlichem Host),
# muss es seine ÖFFENTLICHE IP in SDP/Contact annoncieren — sonst schickt die Gegenstelle
# RTP an die interne Container-IP (einseitiges/stummes Audio). PUBLIC_IP wurde oben
# aufgelöst; das sed unten ankert bewusst NUR den UDP-Transport in pjsip.conf (der
# WebRTC-ws-Transport bekommt seine external-Adressen direkt bei der Generierung).
# local_net hält interne Subnetze vom Rewrite aus. Bei externer PBX irrelevant.
if [[ "${EMBED_ASTERISK:-true}" == "true" ]]; then
  if [[ -n "${PUBLIC_IP}" ]] && ! grep -q external_media_address /etc/asterisk/pjsip.conf; then
    LOCAL_NETS="${LOCAL_NETS:-10.0.0.0/8,172.16.0.0/12,192.168.0.0/16}"
    NAT_LINES="external_media_address = ${PUBLIC_IP}\nexternal_signaling_address = ${PUBLIC_IP}"
    IFS=',' read -ra _nets <<< "${LOCAL_NETS}"
    for n in "${_nets[@]}"; do NAT_LINES="${NAT_LINES}\nlocal_net = ${n}"; done
    sed -i "/^bind = 0.0.0.0$/a ${NAT_LINES}" /etc/asterisk/pjsip.conf
    echo "entrypoint: NAT aktiviert — external addr ${PUBLIC_IP}, local_net ${LOCAL_NETS}"
  elif [[ -z "${PUBLIC_IP}" && "${TRUNK_ENABLED:-false}" == "true" ]]; then
    echo "WARNUNG: TRUNK aktiv, aber PUBLIC_IP nicht gesetzt/ermittelbar — RTP-Audio kann hinter NAT einseitig sein. PUBLIC_IP in der .env setzen."
  fi
fi

mkdir -p /data/db "${RECORDING_PATH:-/data/recordings}"

exec "$@"
