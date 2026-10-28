#!/usr/bin/env bash
# Starts (or restarts) an isolated test stack: fake OpenAI on :8094 and the real Express app on :8093 with the MOCK assessment engine,
# a throw-away DATA_DIR, passcode "devpass", and no real keys. Never touches the :8080 instance or app/.env keys.
# Also starts the DEV-ONLY fixture wrapper on :8095 (adds wordStatus / words-to-practise / drill on top of :8093; see fixture-backend.mjs).
# Usage: bash start-test-stack.sh [start|stop]
cd "$(dirname "$0")/../.."   # -> app/
stop() { for port in 8093 8094 8095; do for pid in $(ss -ltnp 2>/dev/null | grep ":$port " | grep -o 'pid=[0-9]*' | cut -d= -f2); do kill "$pid" 2>/dev/null; done; done; }
stop
[ "$1" = "stop" ] && exit 0
rm -rf /tmp/mc-data && mkdir -p /tmp/mc-data
nohup node public-dev-notes/dev-tools/fake-openai.mjs 8094 > /tmp/fake-openai.log 2>&1 &
PORT=8093 APP_PASSCODE=devpass DATA_DIR=/tmp/mc-data ASSESSMENT_ENGINE=mock TONEPERFECT_API_KEY= OPENAI_API_KEY=fake \
  OPENAI_BASE_URL=http://127.0.0.1:8094/v1 AZURE_SPEECH_KEY= AZURE_SPEECH_REGION= ${MOCK_FORCE:+MOCK_FORCE=$MOCK_FORCE} \
  nohup node server/index.js > /tmp/mc-8093.log 2>&1 &
nohup node public-dev-notes/dev-tools/fixture-backend.mjs 8095 8093 > /tmp/fixture-8095.log 2>&1 &
sleep 2; curl -s localhost:8093/api/health; echo
