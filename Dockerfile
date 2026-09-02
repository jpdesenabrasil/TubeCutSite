FROM node:22-bookworm-slim

ENV NODE_ENV=production \
    YTDLP_BIN=yt-dlp \
    FFMPEG_BIN=ffmpeg \
    FFMPEG_FONTFILE=/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf \
    MAX_CONCURRENT_JOBS=2

RUN apt-get update \
    && apt-get install -y --no-install-recommends ffmpeg python3 python3-venv ca-certificates fonts-dejavu-core \
    && python3 -m venv /opt/yt-dlp \
    && /opt/yt-dlp/bin/pip install --no-cache-dir --upgrade pip yt-dlp \
    && ln -s /opt/yt-dlp/bin/yt-dlp /usr/local/bin/yt-dlp \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package*.json ./
RUN npm install --omit=dev
COPY . .
RUN mkdir -p /app/temp

EXPOSE 3000
CMD ["npm", "start"]
