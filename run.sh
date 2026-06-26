#!/usr/bin/env bash
set -euo pipefail

# Komfort-Wrapper für `docker run` — dasselbe Image lokal wie in Prod.
# Kein docker-compose nötig: alles läuft in EINEM Container.
#
#   ./run.sh build     Image bauen
#   ./run.sh up        Container starten (liest .env)
#   ./run.sh down      Container stoppen/entfernen
#   ./run.sh logs      Logs folgen
#   ./run.sh shell     Shell im laufenden Container

IMAGE="deepgram-voice-agent:local"
NAME="voice-agent"
ENV_FILE=".env"

cmd="${1:-up}"

case "$cmd" in
  build)
    docker build -t "$IMAGE" .
    ;;
  up)
    [[ -f "$ENV_FILE" ]] || { echo "Fehlt: $ENV_FILE (kopiere .env.example)"; exit 1; }
    docker run -d --name "$NAME" \
      --env-file "$ENV_FILE" \
      -p 5060:5060/udp \
      -p 10000-10100:10000-10100/udp \
      -p 8080:8080/tcp \
      -v "$(pwd)/data/db:/data/db" \
      -v "$(pwd)/data/recordings:/data/recordings" \
      "$IMAGE"
    echo "Gestartet: $NAME"
    ;;
  down)
    docker rm -f "$NAME" 2>/dev/null || true
    ;;
  logs)
    docker logs -f "$NAME"
    ;;
  shell)
    docker exec -it "$NAME" bash
    ;;
  *)
    echo "Usage: ./run.sh {build|up|down|logs|shell}"; exit 1
    ;;
esac
