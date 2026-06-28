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

# NAT: Läuft Asterisk hinter Docker-/Host-NAT (z. B. Container mit öffentlichem Host),
# muss es seine ÖFFENTLICHE IP in SDP/Contact annoncieren — sonst schickt die Gegenstelle
# RTP an die interne Container-IP (einseitiges/stummes Audio). PUBLIC_IP explizit setzen
# (empfohlen) oder bei aktivem Trunk best-effort automatisch ermitteln. local_net hält
# interne Subnetze vom Rewrite aus. Bei externer PBX (EMBED_ASTERISK=false) irrelevant.
if [[ "${EMBED_ASTERISK:-true}" == "true" ]]; then
  PUBLIC_IP="${PUBLIC_IP:-${EXTERNAL_IP:-}}"
  if [[ -z "${PUBLIC_IP}" && "${TRUNK_ENABLED:-false}" == "true" ]]; then
    PUBLIC_IP="$(curl -fsS --max-time 3 https://api.ipify.org 2>/dev/null || true)"
    [[ -n "${PUBLIC_IP}" ]] && echo "entrypoint: PUBLIC_IP automatisch ermittelt: ${PUBLIC_IP}"
  fi
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
