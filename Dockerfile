# Rewind — image to run locally or on any host with Docker.
# No third-party npm dependencies: `npm install` only links the workspaces
# (@rewind/core, @rewind/retro, ...) so imports by package name resolve.
FROM node:22-alpine

ENV NODE_ENV=production \
    PORT=8787 \
    REWIND_DATA_FILE=/app/.data/rewind.json

WORKDIR /app

COPY --chown=node:node package.json ./
COPY --chown=node:node packages ./packages
COPY --chown=node:node modules ./modules
COPY --chown=node:node apps ./apps
COPY --chown=node:node scripts ./scripts
RUN npm install --no-audit --no-fund --offline && chown -R node:node node_modules

# Data folder writable by the unprivileged user (mounted as a volume)
RUN mkdir -p /app/.data && chown node:node /app/.data
VOLUME ["/app/.data"]

USER node
EXPOSE 8787

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s \
  CMD wget -qO- http://127.0.0.1:8787/api/config >/dev/null || exit 1

CMD ["node", "apps/api/node/server.js"]
