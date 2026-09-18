#!/usr/bin/env bash
# Development launch: Vite dev server + Tauri window + worker from backend/.venv.
#   scripts/dev.sh            full desktop app (tauri dev)
#   scripts/dev.sh --web      frontend only in the browser with the PREVIEW MOCK (no worker)
#   scripts/dev.sh --worker   run the Python worker alone on stdin/stdout (protocol debugging)
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
die() { printf '\033[31m✖\033[0m %s\n' "$*" >&2; exit 1; }

case "${1:-}" in
  --web)
    cd "$ROOT/frontend" && [[ -d node_modules ]] || npm install
    exec npm run dev ;;
  --worker)
    [[ -x "$ROOT/backend/.venv/bin/python" ]] || die "backend/.venv missing — run scripts/bootstrap.sh"
    cd "$ROOT/backend" && exec .venv/bin/python -m shadowfetch_worker "${@:2}" ;;
esac

[[ -x "$ROOT/backend/.venv/bin/python" ]] || die "backend/.venv missing — run scripts/bootstrap.sh first"
command -v cargo >/dev/null || die "cargo (Rust) is required"
pkg-config --exists webkit2gtk-4.1 gtk+-3.0 2>/dev/null || die "Tauri system libraries missing — see scripts/doctor.sh (libwebkit2gtk-4.1-dev, libgtk-3-dev …)"
cd "$ROOT/frontend" && { [[ -d node_modules ]] || npm install; }
cd "$ROOT/src-tauri"
export SFVS_WORKER_PYTHON="$ROOT/backend/.venv/bin/python"
export RUST_LOG="${RUST_LOG:-info}"
exec npx --yes @tauri-apps/cli@^2 dev "${@}"
