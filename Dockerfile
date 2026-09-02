# Build the BgUtils PO-token provider once, then copy it into the final image.
FROM node:22-bookworm-slim AS pot-builder
RUN apt-get update \
    && apt-get install -y --no-install-recommends git ca-certificates \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /src
RUN git clone --depth 1 --branch 1.3.1 https://github.com/Brainicism/bgutil-ytdlp-pot-provider.git .
WORKDIR /src/server
RUN npm ci --no-audit --no-fund && npx tsc

FROM node:22-bookworm-slim

ENV NODE_ENV=production \
    YTDLP_BIN=yt-dlp \
    FFMPEG_BIN=ffmpeg \
    FFMPEG_FONTFILE=/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf \
    MAX_CONCURRENT_JOBS=2 \
    FFMPEG_THREADS=2 \
    YTDLP_JS_RUNTIME=node \
    YTDLP_PO_PROVIDER=bgutil

RUN apt-get update \
    && apt-get install -y --no-install-recommends ffmpeg python3 python3-venv ca-certificates fonts-dejavu-core \
    && python3 -m venv /opt/yt-dlp \
    && /opt/yt-dlp/bin/pip install --no-cache-dir --upgrade pip \
    && /opt/yt-dlp/bin/pip install --no-cache-dir --upgrade "yt-dlp[default]" bgutil-ytdlp-pot-provider \
    && ln -s /opt/yt-dlp/bin/yt-dlp /usr/local/bin/yt-dlp \
    && rm -rf /var/lib/apt/lists/*

# Local PO-token HTTP provider. The yt-dlp plugin defaults to 127.0.0.1:4416.
COPY --from=pot-builder /src/server /opt/bgutil

WORKDIR /app
COPY package*.json ./
RUN npm install --omit=dev
COPY . .
RUN mkdir -p /app/temp && chmod +x /app/start.sh

EXPOSE 3000
CMD ["/app/start.sh"]
