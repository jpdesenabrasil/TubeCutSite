#!/bin/sh
set -eu

# Local PO Token provider. The yt-dlp plugin auto-discovers it at 127.0.0.1:4416.
node /opt/bgutil/server/build/main.js &
POT_PID=$!

cleanup() {
  kill "$POT_PID" 2>/dev/null || true
}
trap cleanup EXIT INT TERM

exec npm start
