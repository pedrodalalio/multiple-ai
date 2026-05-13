#!/usr/bin/env bash
# Dispara uma pergunta pro endpoint /chat e imprime o JSON formatado.
# Uso: ./scripts/smoke.sh "sua pergunta aqui"

set -euo pipefail

PROMPT="${1:-Explique em uma frase o que é entropia.}"
BASE_URL="${BASE_URL:-http://localhost:3000}"

BODY=$(python3 -c "
import json, sys
print(json.dumps({'prompt': '''$PROMPT'''}))
")

curl -sS -X POST "$BASE_URL/chat" \
  -H 'Content-Type: application/json' \
  -d "$BODY" | python3 -m json.tool
