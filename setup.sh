#!/usr/bin/env bash
# One-step setup for macOS / Linux:  ./setup.sh
# Creates .env (with generated secrets), asks for the free Pexels key and starts everything with Docker.
set -euo pipefail
cd "$(dirname "$0")"

NO_START=0
[ "${1:-}" = "--no-start" ] && NO_START=1

if [ "$NO_START" = 0 ] && ! command -v docker >/dev/null 2>&1; then
  echo "Docker is not installed. Install Docker Desktop: https://www.docker.com/products/docker-desktop"
  exit 1
fi
if [ "$NO_START" = 0 ] && ! docker info >/dev/null 2>&1; then
  echo "Docker is not running. Start Docker Desktop, wait until it is ready, then run ./setup.sh again."
  exit 1
fi

[ -f .env ] || cp .env.example .env

get_var() { grep -E "^$1=" .env | head -n 1 | cut -d= -f2- | tr -d '\r'; }
set_var() {
  local tmp
  tmp="$(mktemp)"
  if grep -qE "^$1=" .env; then
    awk -v k="$1" -v v="$2" 'index($0, k"=") == 1 { print k"="v; next } { print }' .env > "$tmp"
  else
    cat .env > "$tmp"
    echo "$1=$2" >> "$tmp"
  fi
  mv "$tmp" .env
}
secret() { openssl rand -base64 "$1" | tr -d '\n'; }

[ -n "$(get_var AUTH_SECRET)" ] || set_var AUTH_SECRET "$(secret 48)"
[ -n "$(get_var ENCRYPTION_KEY)" ] || set_var ENCRYPTION_KEY "$(secret 32)"

if [ -z "$(get_var PEXELS_API_KEY)" ]; then
  if [ -n "${PEXELS_API_KEY:-}" ]; then
    set_var PEXELS_API_KEY "$PEXELS_API_KEY"
  elif [ -t 0 ]; then
    read -r -p "Paste your free Pexels API key (https://www.pexels.com/api/), or press Enter to add it later: " key
    [ -z "$key" ] || set_var PEXELS_API_KEY "$key"
  fi
fi
echo ".env is ready."

if [ "$NO_START" = 1 ]; then exit 0; fi

echo "Starting Shorts Factory (the first start downloads about 6 GB, this can take a while)..."
docker compose up -d --build
echo
echo "Done. Open http://localhost:3000 in your browser and create your account."
echo "The AI model keeps downloading in the background: docker compose logs -f ollama-pull"
