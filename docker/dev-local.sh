#!/usr/bin/env sh
set -eu

project_root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
cd "$project_root"

if [ ! -f .env.local ]; then
  echo "Create .env.local from .env.example and configure Google OAuth before running make dev." >&2
  exit 1
fi

set -a
. ./.env.local
set +a

case "${DATABASE_URL:-}" in
  *127.0.0.1:54322*|*localhost:54322*)
    export DATABASE_URL_DOCKER="postgresql://invook:invook@db:5432/invook"
    ;;
  *)
    export DATABASE_URL_DOCKER="${DATABASE_URL:-postgresql://invook:invook@db:5432/invook}"
    ;;
esac

docker compose -f docker/compose.yml up --build
