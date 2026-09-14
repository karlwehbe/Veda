#!/usr/bin/env bash
# Rebuild + restart the backend after a code change. Never touches the db.
#   ./redeploy.sh          rebuild api
#   ./redeploy.sh --logs   follow api logs afterwards
set -euo pipefail
cd "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

LOGS=false
for a in "$@"; do case "$a" in
  --logs) LOGS=true ;;
  -h|--help) sed -n '2,4p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
  *) echo "Unknown option: $a (try --help)" >&2; exit 1 ;;
esac; done

docker info >/dev/null 2>&1 || { echo "Docker isn't running"; exit 1; }

# Catch syntax errors before spending a build on them.
if command -v python3 >/dev/null 2>&1; then
  python3 -m compileall -q server/app >/dev/null || {
    python3 -m compileall -q server/app; echo "Syntax error above"; exit 1; }
fi

SERVICES=(api)
# --no-deps keeps compose from recreating db as a dependency.
docker compose up -d --build --no-deps "${SERVICES[@]}"

for _ in $(seq 1 45); do
  curl -sf http://localhost:8000/health >/dev/null 2>&1 && READY=1 && break
  sleep 1
done
[ "${READY:-}" ] || { docker compose logs --tail=40 api; echo "API didn't start"; exit 1; }

# Prove the running code is your code — a cached layer can fake success.
RUNNING=$(docker compose exec -T api python -c "import hashlib,pathlib;print(hashlib.sha256(pathlib.Path('app/services/notes_graph.py').read_bytes()).hexdigest())" 2>/dev/null | tr -d '\r\n')
LOCAL=$(shasum -a 256 server/app/services/notes_graph.py | cut -d' ' -f1)
if [ "$RUNNING" = "$LOCAL" ]; then
  echo "✓ container matches source"
else
  echo "! STALE — build used a cached layer"
  echo "  docker compose build --no-cache api && ./redeploy.sh"
fi

docker compose exec -T db psql -U postgres -d ai_note_taker -tAc \
  "SELECT (SELECT count(*) FROM conversations)||' conversations, '||
          (SELECT count(*) FROM messages)||' messages'" 2>/dev/null \
  | sed 's/^/✓ data intact: /'

[ "$LOGS" = true ] && exec docker compose logs -f api
echo "✓ redeployed"