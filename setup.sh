#!/usr/bin/env bash
#
# One-command setup for AI Note Taker.
#
#   ./setup.sh          set up everything, then print how to start
#   ./setup.sh --start  ...and start the dev servers when done
#   ./setup.sh --reset  wipe the database volume first (destroys local data)
#
# Safe to re-run: every step checks the current state before changing
# anything, so this doubles as a "get me back to a working state" script.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$REPO_ROOT"

START_AFTER=false
RESET_DB=false
for arg in "$@"; do
  case "$arg" in
    --start) START_AFTER=true ;;
    --reset) RESET_DB=true ;;
    -h|--help) sed -n '2,12p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "Unknown option: $arg (try --help)" >&2; exit 1 ;;
  esac
done

# ---------------------------------------------------------------------------
# Output helpers
# ---------------------------------------------------------------------------
if [ -t 1 ]; then
  BOLD=$'\033[1m'; DIM=$'\033[2m'; RED=$'\033[31m'; GREEN=$'\033[32m'
  YELLOW=$'\033[33m'; BLUE=$'\033[34m'; RESET=$'\033[0m'
else
  BOLD=""; DIM=""; RED=""; GREEN=""; YELLOW=""; BLUE=""; RESET=""
fi

step()  { echo; echo "${BOLD}${BLUE}==>${RESET} ${BOLD}$*${RESET}"; }
ok()    { echo "  ${GREEN}✓${RESET} $*"; }
warn()  { echo "  ${YELLOW}!${RESET} $*"; }
fail()  { echo "  ${RED}✗${RESET} $*" >&2; }
info()  { echo "  ${DIM}$*${RESET}"; }

die() { fail "$*"; exit 1; }

# ---------------------------------------------------------------------------
# 1. Prerequisites
# ---------------------------------------------------------------------------
step "Checking prerequisites"

MISSING=0
need() {
  # need <command> <human name> <install hint>
  if command -v "$1" >/dev/null 2>&1; then
    ok "$2 $(eval "${4:-$1 --version}" 2>/dev/null | head -1)"
  else
    fail "$2 not found — $3"
    MISSING=1
  fi
}

need docker "Docker"  "install Docker Desktop: https://docs.docker.com/get-docker/"
need node   "Node.js" "install Node 20+: https://nodejs.org"
need npm    "npm"     "ships with Node.js"

# Docker Compose is a subcommand now, not its own binary.
if docker compose version >/dev/null 2>&1; then
  ok "Docker Compose $(docker compose version --short 2>/dev/null)"
else
  fail "'docker compose' unavailable — update Docker Desktop, or install the Compose plugin"
  MISSING=1
fi

[ "$MISSING" -eq 0 ] || die "Install the missing prerequisites above, then re-run."

# The daemon has to actually be running, not just installed.
if ! docker info >/dev/null 2>&1; then
  die "Docker is installed but not running — start Docker Desktop and re-run."
fi
ok "Docker daemon is running"

# ---------------------------------------------------------------------------
# 2. Environment file
# ---------------------------------------------------------------------------
step "Setting up .env"

if [ -f .env ]; then
  ok ".env already exists (leaving it alone)"
else
  [ -f .env.example ] || die ".env.example is missing — can't generate .env"
  cp .env.example .env
  ok "Created .env from .env.example"
fi

# Read a KEY=value from .env, ignoring comments.
env_value() { grep -E "^$1=" .env 2>/dev/null | head -1 | cut -d= -f2- | tr -d '"'"'"' '; }

MISSING_KEYS=()
[ -n "$(env_value DEEPGRAM_API_KEY)" ] || MISSING_KEYS+=("DEEPGRAM_API_KEY   (console.deepgram.com — needed for transcription)")
[ -n "$(env_value OPENAI_API_KEY)" ]   || MISSING_KEYS+=("OPENAI_API_KEY     (platform.openai.com — needed to generate notes)")

if [ ${#MISSING_KEYS[@]} -gt 0 ]; then
  warn "These keys are empty in .env:"
  for k in "${MISSING_KEYS[@]}"; do echo "      $k"; done
  info "Setup will continue — the app starts fine, but recording and note"
  info "generation return errors until these are filled in."
else
  ok "API keys present"
fi

# ---------------------------------------------------------------------------
# 3. Backend (Docker)
# ---------------------------------------------------------------------------
if [ "$RESET_DB" = true ]; then
  step "Resetting database volume"
  docker compose down -v >/dev/null 2>&1 || true
  ok "Removed containers and the pgdata volume"
fi

step "Building and starting backend containers"
info "First run pulls images and builds — this can take a few minutes."
docker compose up -d --build
ok "Containers started (db, api)"

step "Waiting for the API to be ready"
# init_db() runs at startup: creates tables and applies additive migrations,
# so "healthy" here also means the schema is in place.
READY=false
for _ in $(seq 1 60); do
  if curl -sf http://localhost:8000/health >/dev/null 2>&1; then READY=true; break; fi
  sleep 1
done

if [ "$READY" = true ]; then
  DB_STATUS=$(curl -s http://localhost:8000/health | sed -n 's/.*"db":"\([^"]*\)".*/\1/p')
  if [ "$DB_STATUS" = "ok" ]; then
    ok "API is up at http://localhost:8000 (database connected)"
  else
    warn "API is up but reports db=$DB_STATUS — check: docker compose logs db"
  fi
else
  fail "API didn't come up within 60s"
  info "Check what happened with: docker compose logs api"
  exit 1
fi

TABLES=$(docker compose exec -T db psql -U postgres -d ai_note_taker -tAc \
  "SELECT count(*) FROM pg_tables WHERE schemaname='public'" 2>/dev/null | tr -d '[:space:]')
[ -n "$TABLES" ] && ok "Database schema ready ($TABLES tables)"

# ---------------------------------------------------------------------------
# 4. Frontend
# ---------------------------------------------------------------------------
step "Installing frontend dependencies"
if [ -d client/node_modules ] && [ client/node_modules -nt client/package.json ]; then
  ok "node_modules already up to date"
else
  (cd client && npm install --no-fund --no-audit)
  ok "Installed client dependencies"
fi

# ---------------------------------------------------------------------------
# 5. Optional: local Python venv (only needed to run tests outside Docker)
# ---------------------------------------------------------------------------
step "Setting up the server venv (optional, for running tests locally)"
if command -v python3 >/dev/null 2>&1; then
  if [ -d server/.venv ]; then
    ok "server/.venv already exists"
  else
    if (cd server && python3 -m venv .venv >/dev/null 2>&1); then
      # Quiet because this duplicates what's already installed in the API
      # image — it exists only so `pytest` can run on the host.
      (cd server && .venv/bin/pip install -q --upgrade pip && .venv/bin/pip install -q -e ".[dev]") \
        && ok "Created server/.venv and installed dev dependencies" \
        || warn "venv created but dependency install failed (not fatal — Docker has everything)"
    else
      warn "Couldn't create a venv (not fatal — Docker has everything)"
    fi
  fi
else
  warn "python3 not found — skipping venv (not fatal, Docker has everything)"
fi

# ---------------------------------------------------------------------------
# Done
# ---------------------------------------------------------------------------
echo
echo "${BOLD}${GREEN}Setup complete.${RESET}"
echo
echo "  ${BOLD}Backend${RESET}  http://localhost:8000    ${DIM}(running in Docker)${RESET}"
echo "  ${BOLD}API docs${RESET} http://localhost:8000/docs"
echo "  ${BOLD}Frontend${RESET} http://localhost:5173    ${DIM}(start it below)${RESET}"
echo
if [ ${#MISSING_KEYS[@]} -gt 0 ]; then
  echo "  ${YELLOW}Before recording or generating notes, fill in your API keys in .env,${RESET}"
  echo "  ${YELLOW}then run: docker compose up -d${RESET}"
  echo
fi
echo "  ${DIM}Useful commands:${RESET}"
echo "    cd client && npm run dev      start the frontend"
echo "    docker compose logs -f api    follow backend logs"
echo "    docker compose down           stop the backend"
echo "    ./setup.sh --reset            wipe the database and start fresh"
echo

if [ "$START_AFTER" = true ]; then
  step "Starting the frontend (Ctrl+C to stop)"
  cd client && exec npm run dev
fi
