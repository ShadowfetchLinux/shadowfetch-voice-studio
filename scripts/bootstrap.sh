#!/usr/bin/env bash
# Shadowfetch Voice Studio — isolated environment setup (no sudo, never touches system Python).
#
#   scripts/bootstrap.sh                      dev layout: backend/.venv (main) [+ backend/envs/chatterbox]
#   scripts/bootstrap.sh --runtime-dir DIR    managed layout: DIR/envs/main [+ DIR/envs/chatterbox] (packaged app)
#   options: --with-chatterbox | --without-chatterbox   --python 3.12   --torch-backend cu128   --dev (pytest/ruff)
#
# Downloads: PyTorch CUDA 12.8 stack (~3.9 GB compressed, shared by both envs via the uv cache), qwen-tts,
# faster-whisper, and optionally chatterbox-tts. Model weights are NOT downloaded here (the app does that
# after showing size + license).
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"
REQ="$ROOT/backend/requirements"
[[ -d "$REQ" ]] || REQ="$(dirname "$HERE")/backend/requirements"   # packaged layout: resources/{backend,scripts}

RUNTIME_DIR=""; WITH_CB="ask"; PY="3.12"; TORCH_BACKEND="cu128"; DEV=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --runtime-dir) RUNTIME_DIR="$2"; shift 2;;
    --with-chatterbox) WITH_CB=1; shift;;
    --without-chatterbox) WITH_CB=0; shift;;
    --python) PY="$2"; shift 2;;
    --torch-backend) TORCH_BACKEND="$2"; shift 2;;
    --dev) DEV=1; shift;;
    -h|--help) sed -n '2,12p' "$0"; exit 0;;
    *) echo "unknown option: $1" >&2; exit 2;;
  esac
done

bold() { printf '\033[1m%s\033[0m\n' "$*"; }
ok()   { printf '  \033[32m✔\033[0m %s\n' "$*"; }
warn() { printf '  \033[33m!\033[0m %s\n' "$*"; }
die()  { printf '  \033[31m✖\033[0m %s\n' "$*" >&2; exit 1; }

# A packaged install must own a real venv under --runtime-dir. A leftover symlink
# into the git checkout is how the old .deb silently stopped being standalone.
detach_checkout_link() {
  local dir="$1"
  [[ -n "$RUNTIME_DIR" && -L "$dir" ]] || return 0
  local target root
  target=$(readlink -f "$dir" 2>/dev/null || true)
  root=$(readlink -f "$RUNTIME_DIR")
  if [[ -z "$target" || ( "$target" != "$root" && "$target" != "$root"/* ) ]]; then
    warn "replacing checkout-linked environment $dir → ${target:-missing} with a standalone venv"
    rm -f "$dir"
  fi
}

if [[ -n "$RUNTIME_DIR" ]]; then
  MAIN_ENV="$RUNTIME_DIR/envs/main"; CB_ENV="$RUNTIME_DIR/envs/chatterbox"; mkdir -p "$RUNTIME_DIR/envs"
  detach_checkout_link "$MAIN_ENV"
  detach_checkout_link "$CB_ENV"
else
  MAIN_ENV="$ROOT/backend/.venv"; CB_ENV="$ROOT/backend/envs/chatterbox"; mkdir -p "$ROOT/backend/envs"
fi

write_lock() {
  local dest="$1" py="$2"
  local parent; parent=$(dirname "$dest")
  if [[ -d "$parent" && -w "$parent" ]]; then
    "$UV" pip freeze --python "$py" > "$dest"
    ok "lock: $dest"
  else
    warn "skipping lock file (not writable): $dest"
  fi
}

# ---- uv (fast, isolated, can fetch a managed CPython) --------------------------------------------
UV="$(command -v uv || true)"
[[ -z "$UV" && -x "$HOME/.local/bin/uv" ]] && UV="$HOME/.local/bin/uv"
if [[ -z "$UV" ]]; then
  warn "uv is not installed. It is the supported way to build the environments (single-user, no sudo)."
  if [[ -t 0 ]]; then
    read -r -p "  Install uv into ~/.local/bin now (downloads ~20 MB from astral.sh)? [y/N] " ans
    [[ "${ans,,}" == y* ]] || die "uv is required. Install it (https://docs.astral.sh/uv/) and re-run."
  else
    [[ "${SFVS_AUTO_INSTALL_UV:-0}" == "1" ]] || die "uv is required (set SFVS_AUTO_INSTALL_UV=1 to allow installing it)."
  fi
  curl -LsSf https://astral.sh/uv/install.sh | sh
  UV="$HOME/.local/bin/uv"
fi
ok "uv: $("$UV" --version)"

bold "Main environment → $MAIN_ENV"
if [[ ! -x "$MAIN_ENV/bin/python" ]]; then
  "$UV" venv -q -p "$PY" "$MAIN_ENV"
fi
"$UV" pip install -q --python "$MAIN_ENV/bin/python" --torch-backend="$TORCH_BACKEND" \
  --overrides "$REQ/overrides-main.txt" -r "$REQ/main.txt"
if [[ "$DEV" == 1 ]]; then "$UV" pip install -q --python "$MAIN_ENV/bin/python" -r "$REQ/dev.txt"; fi
write_lock "$REQ/main.lock.txt" "$MAIN_ENV/bin/python"
[[ -n "$RUNTIME_DIR" ]] && write_lock "$RUNTIME_DIR/main.lock.txt" "$MAIN_ENV/bin/python"
ok "main env ready"

# ---- CUDA smoke test: a real matmul, not just is_available() -------------------------------------
"$MAIN_ENV/bin/python" - <<'PY' || warn "CUDA smoke test failed — engines will run on CPU until this is fixed"
import torch, time
print(f"  torch {torch.__version__} cuda={torch.version.cuda} available={torch.cuda.is_available()}")
if torch.cuda.is_available():
    name = torch.cuda.get_device_name(0); cap = torch.cuda.get_device_capability(0)
    a = torch.randn(2048, 2048, device="cuda", dtype=torch.bfloat16); b = torch.randn(2048, 2048, device="cuda", dtype=torch.bfloat16)
    torch.cuda.synchronize(); t = time.time(); c = (a @ b).float().sum().item(); torch.cuda.synchronize()
    assert c == c, "NaN from matmul"
    print(f"  ✔ CUDA matmul OK on {name} (sm_{cap[0]}{cap[1]}), {(time.time()-t)*1000:.1f} ms, arch list {torch.cuda.get_arch_list()}")
else:
    raise SystemExit(1)
PY

# ---- optional Chatterbox env --------------------------------------------------------------------
if [[ "$WITH_CB" == "ask" ]]; then
  if [[ -t 0 ]]; then read -r -p "  Also set up the optional Chatterbox-Turbo engine environment (~150 MB extra download)? [y/N] " ans; [[ "${ans,,}" == y* ]] && WITH_CB=1 || WITH_CB=0
  else WITH_CB=0; fi
fi
if [[ "$WITH_CB" == 1 ]]; then
  bold "Chatterbox environment → $CB_ENV"
  [[ -x "$CB_ENV/bin/python" ]] || "$UV" venv -q -p "$PY" "$CB_ENV"
  "$UV" pip install -q --python "$CB_ENV/bin/python" --torch-backend="$TORCH_BACKEND" \
    --overrides "$REQ/overrides-chatterbox.txt" -r "$REQ/chatterbox.txt"
  write_lock "$REQ/chatterbox.lock.txt" "$CB_ENV/bin/python"
  [[ -n "$RUNTIME_DIR" ]] && write_lock "$RUNTIME_DIR/chatterbox.lock.txt" "$CB_ENV/bin/python"
  ok "chatterbox env ready"
fi

# ---- record what was built ------------------------------------------------------------------------
STAMP="${RUNTIME_DIR:-$ROOT/backend}/runtime.json"
"$MAIN_ENV/bin/python" - "$STAMP" "$MAIN_ENV" "$CB_ENV" <<'PY'
import json, sys, importlib.metadata as m, platform, time, os
stamp, main_env, cb_env = sys.argv[1:4]
def ver(p):
    try: return m.version(p)
    except m.PackageNotFoundError: return None
data = {"created_at": time.strftime("%Y-%m-%dT%H:%M:%S"), "python": platform.python_version(),
        "envs": {"main": {"path": main_env, "torch": ver("torch"), "qwen-tts": ver("qwen-tts"), "faster-whisper": ver("faster-whisper"), "transformers": ver("transformers")},
                 "chatterbox": {"path": cb_env, "installed": os.path.exists(os.path.join(cb_env, "bin", "python"))}}}
json.dump(data, open(stamp, "w"), indent=2); print(f"  runtime info → {stamp}")
PY
bold "Done."
