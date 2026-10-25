# Director: event server + MCP seats. Runs next to phase-server (see deploy/compose.yaml).
# The same image runs the Hub (packages/hub) with `command: node --import tsx packages/hub/src/main.ts`.
# What goes in is the .dockerignore allow-list (the only list; CI checks the image holds every file the code reads).
# Base image pinned by digest (Dependabot proposes updates).
FROM node:22-slim@sha256:de170b39439eb0e5a3444ad7d60b015614a381e10fecae2e30ec9e735122f38d
# Runtime user `app`, uid/gid 999 (the hosted stack runs as it: deploy/compose.yaml `user:`). 999 is also phase-server's
# own user, and its card data (card-data.json, draft-pools.json) is mode 600 in the shared read-only phase-data volume.
# The image keeps root as its default user only for self-hosting (deploy/compose.local.yaml): the Director writes the
# generated admin token into a bind-mounted .bench/ owned by the host user.
RUN groupadd --system --gid 999 app && useradd --system --uid 999 --gid 999 --home-dir /home/app --create-home --shell /usr/sbin/nologin app
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/director/package.json packages/director/
COPY packages/site/package.json packages/site/
COPY packages/hub/package.json packages/hub/
COPY packages/registry/package.json packages/registry/
RUN npm ci --no-audit --no-fund && npm cache clean --force
# Everything the .dockerignore allow-list lets through: packages, registry (canonical model and harness names), sets,
# prompts, engine (the pin), deps (the Hub accepts engine builds pinned earlier), scripts, docs/METHODOLOGY.md (the
# report export ships it next to the numbers), highlights (hand-curated highlights the export resolves).
# Code stays owned by root, read-only for the app user.
COPY . .
# Writable state, owned by the app user (a new named volume mounted on one of these starts with this owner; /phase-data:
# the card-data stage of deploy/compose.yaml is the first to mount phase-server's volume, and writes into it). /app/var
# holds the Director's report export (SITE_DATA_DIR=/app/var/site-data on the hosted stack): it swaps in a sibling
# temp directory, so its parent must be writable, and /app itself stays read-only.
RUN mkdir -p /app/runs /app/cache /app/var /hub-data /phase-data && chown 999:999 /app/runs /app/cache /app/var /hub-data /phase-data
# The build's version (deploy/deploy.sh passes the git sha, -dirty for uncommitted image inputs). /health reports it.
ARG DIRECTOR_TAG=local
ENV HOST=0.0.0.0 PORT=8787 DATA_DIR=/phase-data CACHE_DIR=/app/cache RUNS_DIR=/app/runs DIRECTOR_TAG=$DIRECTOR_TAG
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=5s --start-period=120s CMD node -e "fetch('http://127.0.0.1:8787/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
# phase-server downloads card data into its volume on first boot; wait for it.
# `exec node` (not npx): the Director is the container's main process and gets SIGTERM itself, so a redeploy
# checkpoints live events and they resume at the next start (packages/director/src/durable.ts).
CMD ["sh", "-c", "until [ -s \"$DATA_DIR/draft-pools.json\" ] && [ -s \"$DATA_DIR/card-data.json\" ]; do echo 'waiting for phase-server card data…'; sleep 3; done; exec node --import tsx packages/director/src/main.ts --serve"]
