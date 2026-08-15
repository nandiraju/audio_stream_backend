# Stage 1: build the React web UI
FROM node:22-alpine AS ui-build
WORKDIR /app/webapp
COPY webapp/package*.json ./
RUN npm ci
COPY webapp/ ./
RUN npm run build
# vite outputs to ../public (see webapp/vite.config.js)

# Stage 2: whisper.cpp + models
# Static link (BUILD_SHARED_LIBS=OFF) so the runtime image needs one binary
# instead of a scatter of libggml*.so. Pin WHISPER_REF to a tag for repeatable
# builds — the default tracks master and will drift.
FROM debian:bookworm-slim AS whisper-build
ARG WHISPER_REF=master
# Multilingual — an English-only model turns non-English speech into confident
# English nonsense. q5_0 keeps this at ~570 MB. Override to base-q5_1 (~60 MB,
# ~5x faster) if every device records English and throughput matters more.
ARG WHISPER_MODEL_NAME=large-v3-turbo-q5_0
ARG WHISPER_VAD_NAME=silero-v5.1.2
RUN apt-get update && apt-get install -y --no-install-recommends \
      git cmake g++ make ca-certificates wget \
 && rm -rf /var/lib/apt/lists/*
RUN git clone --depth 1 --branch ${WHISPER_REF} https://github.com/ggml-org/whisper.cpp /src
WORKDIR /src
RUN cmake -B build -DCMAKE_BUILD_TYPE=Release -DBUILD_SHARED_LIBS=OFF \
      -DWHISPER_BUILD_TESTS=OFF -DWHISPER_BUILD_SERVER=OFF \
 && cmake --build build -j"$(nproc)" --target whisper-cli
RUN mkdir -p /models \
 && sh models/download-ggml-model.sh ${WHISPER_MODEL_NAME} /models \
 && sh models/download-vad-model.sh ${WHISPER_VAD_NAME} /models \
 && ls -l /models

# Stage 3: runtime
FROM node:22-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production
# ffmpeg decodes Opus → 16 kHz mono WAV for whisper (and backs the web UI's
# playback transcode); libgomp1 is whisper.cpp's OpenMP runtime.
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg libgomp1 \
 && rm -rf /var/lib/apt/lists/*
COPY --from=whisper-build /src/build/bin/whisper-cli /usr/local/bin/whisper-cli
COPY --from=whisper-build /models /models
COPY package*.json ./
RUN npm ci --omit=dev
COPY server.js oggopus.js pipeline.js ./
COPY --from=ui-build /app/public ./public
RUN mkdir -p /app/recordings && chown node:node /app/recordings
ENV WHISPER_MODEL=/models/ggml-large-v3-turbo-q5_0.bin \
    WHISPER_VAD_MODEL=/models/ggml-silero-v5.1.2.bin \
    WHISPER_THREADS=2
# Stamped at build time so /api/version can prove which build is live.
ARG BUILD_SHA=dev
ENV BUILD_SHA=${BUILD_SHA}
EXPOSE 8080
USER node
CMD ["node", "server.js"]
