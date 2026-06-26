# syntax=docker/dockerfile:1

# ─────────────────────────────────────────────────────────────────────────────
# Single-Container-Appliance: Node-Telefonie-Kern + MongoDB + (optional) Asterisk
#   + Python-Admin-UI, orchestriert von supervisord.
# Dasselbe Image läuft lokal (OrbStack) wie in Produktion — Unterschied nur via .env.
# ─────────────────────────────────────────────────────────────────────────────

# --- Build-Stage: TypeScript kompilieren -------------------------------------
FROM node:20-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm install
COPY tsconfig.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

# --- Runtime-Stage: Node + MongoDB + Asterisk + Python + supervisord ---------
# Basis: Ubuntu 24.04 (noble) — enthält Asterisk (universe); Debian bookworm liefert
# Asterisk nicht mehr. MongoDB 8.0 + Node 20 über die offiziellen Repos.
FROM ubuntu:24.04 AS runtime
ENV DEBIAN_FRONTEND=noninteractive \
    NODE_ENV=production

# Basis-Pakete: Asterisk, Python 3, supervisor
RUN apt-get update && apt-get install -y --no-install-recommends \
        ca-certificates curl gnupg supervisor \
        python3 python3-pip python3-venv \
        asterisk \
    # Node 20 (NodeSource)
    && curl -fsSL https://deb.nodesource.com/setup_20.x | bash - \
    && apt-get install -y --no-install-recommends nodejs \
    # MongoDB 8.0 (Ubuntu noble)
    && curl -fsSL https://www.mongodb.org/static/pgp/server-8.0.asc | gpg -o /usr/share/keyrings/mongodb-server-8.0.gpg --dearmor \
    && echo "deb [ signed-by=/usr/share/keyrings/mongodb-server-8.0.gpg ] https://repo.mongodb.org/apt/ubuntu noble/mongodb-org/8.0 multiverse" > /etc/apt/sources.list.d/mongodb-org-8.0.list \
    && apt-get update && apt-get install -y --no-install-recommends mongodb-org \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Node-App (kompiliert + Prod-deps)
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./

# Python-Admin-UI
COPY admin ./admin
RUN pip3 install --no-cache-dir --break-system-packages -r admin/requirements.txt

# Asterisk-Konfiguration: unsere Dateien überschreiben die Paket-Defaults
# (ari.conf, http.conf, pjsip.conf, extensions.conf, rtp.conf, modules.conf).
COPY docker/asterisk/ /etc/asterisk/

# Prozess-Orchestrierung + Entrypoint
COPY docker/supervisord.conf /etc/supervisor/conf.d/voiceagent.conf
COPY docker/entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh \
    && mkdir -p /data/db /data/recordings

# Ports: SIP (UDP), RTP-Range, Admin-UI. ARI(8088)/Media bleiben intern.
EXPOSE 5060/udp 10000-10100/udp 8080/tcp

ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
CMD ["supervisord", "-c", "/etc/supervisor/conf.d/voiceagent.conf", "-n"]
