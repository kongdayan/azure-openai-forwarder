#!/usr/bin/env bash
set -euo pipefail

BASE_URL="${1:-http://127.0.0.1:8787}"

curl -sS "${BASE_URL}/v1/chat/completions"   -H 'content-type: application/json'   -d '{
    "model": "gpt-5-mini",
    "messages": [
      {"role": "user", "content": "Hello"}
    ],
    "temperature": 0.7
  }' | python3 -m json.tool
