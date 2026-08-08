# Stage 1: build the React web UI
FROM node:22-alpine AS ui-build
WORKDIR /app/webapp
COPY webapp/package*.json ./
RUN npm ci
COPY webapp/ ./
RUN npm run build
# vite outputs to ../public (see webapp/vite.config.js)

# Stage 2: runtime
FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY package*.json ./
RUN npm ci --omit=dev
COPY server.js oggopus.js ./
COPY --from=ui-build /app/public ./public
RUN mkdir -p /app/recordings && chown node:node /app/recordings
EXPOSE 8080
USER node
CMD ["node", "server.js"]
