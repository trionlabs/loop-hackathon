#!/usr/bin/env bash
set -euo pipefail

# Boot the SignalCMO stack for a local demo: the write-server (sole credential
# holder), the runner (health, telegram poller, scheduler), and the dashboard.
# Env is loaded from config/.env and exported so every child inherits it.
# Ctrl-C stops all three.

cd "$(dirname "$0")/.."

if [ -f config/.env ]; then
  set -a
  . config/.env
  set +a
fi

: "${WRITEGUARD_TOKEN:?set WRITEGUARD_TOKEN in config/.env (openssl rand -hex 32)}"

pids=()
pnpm exec tsx mcp-write-server/index.ts & pids+=($!)
pnpm exec tsx runner/index.ts & pids+=($!)
pnpm exec tsx web/server.ts & pids+=($!)

trap 'kill "${pids[@]}" 2>/dev/null || true' INT TERM EXIT

echo "write-server :${WRITE_SERVER_PORT:-8787}  runner :${PORT:-3000}  dashboard :${UI_PORT:-4000}"
wait
