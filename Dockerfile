FROM node:22-alpine

WORKDIR /app

# Install postgres client for migration script + curl for healthcheck
RUN apk add --no-cache postgresql-client curl

# Install deps
COPY package.json ./
RUN npm install --omit=dev

# Copy app
COPY . .

# Non-root user
RUN addgroup -S hookline && adduser -S hookline -G hookline && chown -R hookline:hookline /app
USER hookline

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD curl -fsS http://localhost:8080/healthz || exit 1

CMD ["node", "bot.js"]
