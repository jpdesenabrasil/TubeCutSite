FROM node:22-bookworm-slim

WORKDIR /app

RUN apt-get update \
    && apt-get install -y --no-install-recommends ffmpeg python3 python3-pip ca-certificates fonts-dejavu-core \
    && pip3 install --no-cache-dir --break-system-packages yt-dlp \
    && rm -rf /var/lib/apt/lists/*

COPY package*.json ./
RUN npm install --omit=dev

COPY . .

ENV NODE_ENV=production \
    TUBECUT_FONT_FILE=/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf

EXPOSE 3000
CMD ["npm", "start"]
