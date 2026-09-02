#!/bin/sh
set -u

# Keep the provider private inside the Railway container.
node /opt/bgutil/build/main.js --port 4416 &
POT_PID=$!

# Give the provider a moment to boot. If it dies, the TubeCut still starts and
# the default/cookie strategies can continue working.
sleep 1
if kill -0 "$POT_PID" 2>/dev/null; then
  echo "PO Token provider: ativo em 127.0.0.1:4416"
else
  echo "AVISO: PO Token provider nao iniciou; usando fallbacks normais do yt-dlp." >&2
fi

exec node server.js
