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
  # Beispielkonfiguration einspielen, falls noch keine vorhanden / leer gemountet
  if [[ ! -f /etc/asterisk/ari.conf ]]; then
    cp -rn /etc/asterisk-sample/. /etc/asterisk/ 2>/dev/null || true
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

mkdir -p /data/db "${RECORDING_PATH:-/data/recordings}"

exec "$@"
