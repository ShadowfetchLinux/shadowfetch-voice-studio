#!/usr/bin/env bash
# Test runner.
#   scripts/test.sh              backend unit tests (mocked; no models) + frontend tests + rust tests if compilable
#   scripts/test.sh --real       also run real-model integration tests (needs bootstrap + downloaded models; uses the GPU)
#   scripts/test.sh --backend | --frontend | --rust
set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REAL=0; ONLY=""
for a in "$@"; do case "$a" in --real) REAL=1;; --backend|--frontend|--rust) ONLY="${a#--}";; esac; done
status=0
run() { printf '\n\033[1m== %s\033[0m\n' "$1"; shift; "$@" || status=1; }

if [[ -z "$ONLY" || "$ONLY" == backend ]]; then
  PY="$ROOT/backend/.venv/bin/python"; [[ -x "$PY" ]] || PY="$ROOT/backend/.venv-spine/bin/python"
  [[ -x "$PY" ]] || { echo "no backend environment — run scripts/bootstrap.sh"; status=1; }
  if [[ -x "$PY" ]]; then
    "$PY" -c "import pytest" 2>/dev/null || uv pip install -q --python "$PY" -r "$ROOT/backend/requirements/dev.txt"
    if [[ "$REAL" == 1 ]]; then
      run "backend (unit + real models)" env SFVS_REAL_MODELS=1 "$PY" -m pytest "$ROOT/backend/tests" -q -p no:cacheprovider
    else
      run "backend (unit, mocked engines)" "$PY" -m pytest "$ROOT/backend/tests" -q -p no:cacheprovider -m "not realmodel"
    fi
  fi
fi
if [[ -z "$ONLY" || "$ONLY" == frontend ]]; then
  if [[ -d "$ROOT/frontend" ]]; then
    cd "$ROOT/frontend" && { [[ -d node_modules ]] || npm install --silent; }
    run "frontend (vitest)" npm test -- --run
    run "frontend (typecheck + build)" npm run build
  fi
fi
if [[ -z "$ONLY" || "$ONLY" == rust ]]; then
  if pkg-config --exists webkit2gtk-4.1 gtk+-3.0 2>/dev/null; then
    cd "$ROOT/src-tauri" && run "rust (cargo test)" cargo test --quiet
  else
    echo "rust: skipped (Tauri system libraries not installed)"
  fi
fi
exit $status
