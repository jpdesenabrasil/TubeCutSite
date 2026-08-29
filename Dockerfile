FROM node:22-bookworm-slim

WORKDIR /app

# Runtime + build dependencies for FFmpeg, yt-dlp EJS and the PO Token provider.
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
       ffmpeg python3 python3-pip ca-certificates git \
       fonts-dejavu-core make g++ libcairo2-dev libpango1.0-dev \
       libjpeg62-turbo-dev libgif-dev librsvg2-dev \
    && python3 -m pip install --no-cache-dir --break-system-packages -U \
       "yt-dlp[default]" "bgutil-ytdlp-pot-provider==1.3.1" \
    && git clone --depth 1 --branch 1.3.1 \
       https://github.com/Brainicism/bgutil-ytdlp-pot-provider.git /opt/bgutil \
    && cd /opt/bgutil/server \
    && npm ci --omit=dev=false --no-audit --no-fund \
    && npx tsc \
    && rm -rf /root/.cache /var/lib/apt/lists/*

COPY package*.json ./
RUN npm install --omit=dev --no-audit --no-fund

COPY . .
RUN chmod +x /app/start.sh

ENV NODE_ENV=production \
    TUBECUT_FONT_FILE=/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf

EXPOSE 3000
CMD ["/app/start.sh"]
