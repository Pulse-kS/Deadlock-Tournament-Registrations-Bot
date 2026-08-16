FROM node:20-alpine

WORKDIR /app

# Install deps first so this layer is cached unless package.json changes
COPY package.json package-lock.json* ./
RUN npm install --omit=dev

COPY src ./src
COPY scripts ./scripts

# sessions.json / sheets-snapshot.json / pending-writes.json / audit.log /
# bot.lock are written here at runtime (see src/utils/dataDir.js) - mount
# this as a volume so they survive container restarts/image updates.
ENV DATA_DIR=/app/data
RUN mkdir -p /app/data
VOLUME ["/app/data"]

CMD ["node", "src/index.js"]
