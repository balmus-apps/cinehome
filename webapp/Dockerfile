# ---- CineHome: application image ----
FROM node:22-alpine

# ffmpeg/ffprobe: probing, poster frames, on-the-fly conversion
RUN apk add --no-cache ffmpeg

ENV NODE_ENV=production \
    PORT=8080 \
    MEDIA_ROOT=/media \
    DATA_DIR=/data
WORKDIR /app

# Install dependencies first (better layer caching)
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY src ./src
COPY public ./public

# State and caches live in a volume mounted here; it inherits this ownership on first use
RUN mkdir -p /data && chown node:node /data

# Run as the unprivileged "node" user
USER node
EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD wget -qO- http://127.0.0.1:8080/healthz || exit 1

CMD ["node", "src/server.js"]
