#!/usr/bin/env bash
# Shadowfetch Voice Studio — diagnostics for humans. Never uses sudo, never installs anything.
#
#   scripts/doctor.sh            runtime checks (what the app needs to run)
#   scripts/doctor.sh --dev      also treat build prerequisites (Tauri system libs, node, cargo) as hard failures
#   scripts/doctor.sh --json     print a machine-readable summary at the end
#
# Exit status: 0 = ok (warnings allowed), 1 = at least one hard failure.
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"
DEV=0; JSON=0
for a in "$@"; do case "$a" in --dev) DEV=1;; --json) JSON=1;; -h|--help) sed -n '2,9p' "$0"; exit 0;; esac; done

FAILS=0; WARNS=0; declare -a SUMMARY=()
bold() { printf '\n\033[1m%s\033[0m\n' "$*"; }
ok()   { printf '  \033[32m✔\033[0m %s\n' "$*"; SUMMARY+=("ok|$*"); }
warn() { printf '  \033[33m!\033[0m %s\n' "$*"; WARNS=$((WARNS+1)); SUMMARY+=("warn|$*"); }
fail() { printf '  \033[31m✖\033[0m %s\n' "$*"; FAILS=$((FAILS+1)); SUMMARY+=("fail|$*"); }
have() { command -v "$1" >/dev/null 2>&1; }
devfail() { if [[ $DEV == 1 ]]; then fail "$@"; else warn "$@ (needed only to build the desktop app; run with --dev to enforce)"; fi; }

APP_DATA="${XDG_DATA_HOME:-$HOME/.local/share}/shadowfetch-voice-studio"
SETTINGS="${XDG_CONFIG_HOME:-$HOME/.config}/shadowfetch-voice-studio/settings.json"
MODELS_DIR="$APP_DATA/models"
if [[ -f "$SETTINGS" ]] && have python3; then
  custom="$(python3 -c "import json,sys; print(json.load(open(sys.argv[1])).get('models_dir',''))" "$SETTINGS" 2>/dev/null || true)"
  [[ -n "$custom" ]] && MODELS_DIR="$custom"
fi
HF_CACHE="$MODELS_DIR/hf"
RUNTIME_DIR="${SFVS_RUNTIME_DIR:-$APP_DATA/runtime}"

# ---------------------------------------------------------------- OS / hardware
bold "System"
if [[ -r /etc/os-release ]]; then . /etc/os-release; ok "OS: ${PRETTY_NAME:-unknown} ($(uname -r), $(uname -m))"; else ok "OS: $(uname -srm)"; fi
ok "Session: ${XDG_SESSION_TYPE:-?} / ${XDG_CURRENT_DESKTOP:-?}"
mem_kb=$(awk '/MemTotal/{print $2}' /proc/meminfo 2>/dev/null || echo 0)
ok "RAM: $((mem_kb/1024/1024)) GB total, $(( $(awk '/MemAvailable/{print $2}' /proc/meminfo 2>/dev/null || echo 0)/1024/1024 )) GB available"
ok "CPU: $(grep -m1 'model name' /proc/cpuinfo 2>/dev/null | cut -d: -f2- | sed 's/^ //') ($(nproc) threads)"

bold "GPU"
GPU_PRESENT=0
if have nvidia-smi; then
  line="$(nvidia-smi --query-gpu=name,driver_version,memory.total,memory.used,compute_cap --format=csv,noheader,nounits 2>/dev/null | head -1)"
  if [[ -n "$line" ]]; then
    GPU_PRESENT=1
    IFS=',' read -r gname gdrv gtot gused gcap <<<"$line"
    ok "NVIDIA GPU: ${gname## } — driver ${gdrv## }, VRAM $(( ${gtot## } / 1024 )) GB total ($(( ${gused## } / 1024 )) GB in use), compute capability ${gcap## }"
    drv_major=${gdrv%%.*}
    if (( drv_major < 570 )); then fail "Driver $gdrv is older than 570 — CUDA 12.8 wheels (torch 2.11 cu128) need driver ≥ 570"; fi
    case "${gcap## }" in 12.*) ok "Blackwell (sm_120) detected: bf16 only, no flash-attn, expect a one-time JIT delay for CTranslate2";; esac
  else
    warn "nvidia-smi is installed but returned no GPU (driver loaded? run 'nvidia-smi')"
  fi
else
  warn "nvidia-smi not found — no NVIDIA driver; engines will run on the CPU (very slow)"
fi

# ---------------------------------------------------------------- tools
bold "Tools"
have python3 && ok "python3: $(python3 --version 2>&1) ($(command -v python3))" || fail "python3 not found"
if have uv; then ok "uv: $(uv --version 2>&1)"; elif [[ -x "$HOME/.local/bin/uv" ]]; then ok "uv: $("$HOME/.local/bin/uv" --version) (~/.local/bin, not on PATH)"; else warn "uv not found — scripts/bootstrap.sh can install it into ~/.local/bin"; fi
if have ffmpeg; then ok "ffmpeg: $(ffmpeg -version 2>/dev/null | head -1 | cut -d' ' -f1-3) ($(command -v ffmpeg))"; else fail "ffmpeg not found (apt install ffmpeg) — required for import/export/transcription"; fi
if have ffprobe; then ok "ffprobe: $(ffprobe -version 2>/dev/null | head -1 | cut -d' ' -f1-3)"; else fail "ffprobe not found (comes with ffmpeg)"; fi
if ffmpeg -hide_banner -filters 2>/dev/null | grep -E ' loudnorm +A->A' >/dev/null; then ok "ffmpeg has loudnorm/ebur128 (loudness export)"; else warn "ffmpeg lacks the loudnorm filter — loudness-normalised export unavailable"; fi
have espeak-ng && ok "espeak-ng: present (used only by the real-model tests as a synthetic reference)" || true

bold "Audio (recording)"
if ldconfig -p 2>/dev/null | grep -c 'libportaudio\.so' | grep -v '^0$' >/dev/null; then
  ok "PortAudio: $(ldconfig -p | grep -m1 'libportaudio\.so' | awk '{print $NF}')"
else
  warn "libportaudio.so not found (apt install libportaudio2) — recording falls back to ffmpeg/PulseAudio capture"
fi
if have pactl; then ok "PulseAudio/PipeWire: $(pactl info 2>/dev/null | grep -m1 'Server Name' | cut -d: -f2- | sed 's/^ //')"; else warn "pactl not found — cannot query the audio server"; fi

bold "Desktop shell prerequisites (Tauri 2)"
if have pkg-config; then
  for lib in webkit2gtk-4.1 gtk+-3.0 libsoup-3.0 javascriptcoregtk-4.1; do
    if pkg-config --exists "$lib" 2>/dev/null; then ok "$lib $(pkg-config --modversion "$lib")"; else devfail "$lib not found (apt install libwebkit2gtk-4.1-dev libgtk-3-dev libsoup-3.0-dev)"; fi
  done
else
  devfail "pkg-config not found — cannot check Tauri system libraries"
fi
for t in node npm cargo rustc; do
  if have "$t"; then ok "$t: $("$t" --version 2>&1 | head -1)"; else devfail "$t not found"; fi
done

# ---------------------------------------------------------------- python environments
bold "Python environments"
MAIN_PY=""; CB_PY=""
for c in "$RUNTIME_DIR/envs/main/bin/python" "$ROOT/backend/.venv/bin/python"; do [[ -x "$c" ]] && { MAIN_PY="$c"; break; }; done
for c in "${SFVS_ENV_CHATTERBOX_PYTHON:-}" "$RUNTIME_DIR/envs/chatterbox/bin/python" "$ROOT/backend/envs/chatterbox/bin/python"; do [[ -n "$c" && -x "$c" ]] && { CB_PY="$c"; break; }; done

check_env() {  # name python hard(1/0)
  local name="$1" py="$2" hard="$3"
  if [[ -z "$py" ]]; then
    if [[ "$hard" == 1 ]]; then fail "$name environment not found — run scripts/bootstrap.sh"; else warn "$name environment not installed (optional; scripts/bootstrap.sh --with-chatterbox)"; fi
    return
  fi
  local out
  out="$("$py" - <<'PY' 2>&1
import json, sys, time
r = {"python": sys.version.split()[0]}
try:
    import torch
    r["torch"] = torch.__version__; r["cuda"] = torch.version.cuda; r["available"] = torch.cuda.is_available()
    if torch.cuda.is_available():
        r["device"] = torch.cuda.get_device_name(0); r["cap"] = ".".join(map(str, torch.cuda.get_device_capability(0)))
        a = torch.randn(2048, 2048, device="cuda", dtype=torch.bfloat16); b = torch.randn(2048, 2048, device="cuda", dtype=torch.bfloat16)
        torch.cuda.synchronize(); t = time.time(); c = (a @ b).float().sum().item(); torch.cuda.synchronize()
        r["matmul_ms"] = round((time.time() - t) * 1000, 1); r["matmul_ok"] = c == c
        r["arch_list"] = torch.cuda.get_arch_list()
except Exception as e:
    r["torch_error"] = str(e)[:300]
import importlib.metadata as md
for m, dist in (("qwen_tts", "qwen-tts"), ("chatterbox", "chatterbox-tts"), ("faster_whisper", "faster-whisper"), ("ctranslate2", "ctranslate2"),
                ("sounddevice", "sounddevice"), ("soundfile", "soundfile")):
    try:
        __import__(m)
        try: r[m] = md.version(dist)
        except md.PackageNotFoundError: r[m] = "ok"
    except Exception:
        r[m] = None
print("JSON:" + json.dumps(r))
PY
)"
  local js; js="$(printf '%s\n' "$out" | grep '^JSON:' | tail -1 | cut -c6-)"
  if [[ -z "$js" ]]; then fail "$name env at $py: python failed to run ($(printf '%s' "$out" | tail -1))"; return; fi
  local pyv torch cuda avail dev cap ms mok terr
  pyv=$(jq -r .python <<<"$js" 2>/dev/null || python3 -c "import json,sys;print(json.load(sys.stdin)['python'])" <<<"$js")
  get() { python3 -c "import json,sys; v=json.load(sys.stdin).get('$1'); print('' if v is None else v)" <<<"$js"; }
  torch=$(get torch); cuda=$(get cuda); avail=$(get available); dev=$(get device); cap=$(get cap); ms=$(get matmul_ms); mok=$(get matmul_ok); terr=$(get torch_error)
  ok "$name env: $py (Python $pyv)"
  if [[ -n "$terr" ]]; then fail "  torch import failed: $terr"; return; fi
  ok "  torch $torch (CUDA $cuda)"
  if [[ "$avail" == "True" ]]; then
    if [[ "$mok" == "True" ]]; then ok "  CUDA matmul OK on $dev (sm_${cap/./}) in ${ms} ms"; else fail "  CUDA matmul FAILED on $dev — check driver/torch build"; fi
  else
    if [[ $GPU_PRESENT == 1 ]]; then fail "  torch.cuda.is_available() is False although a GPU is present (driver/torch mismatch?)"; else warn "  no CUDA — CPU only"; fi
  fi
  for m in qwen_tts chatterbox faster_whisper ctranslate2 sounddevice soundfile; do
    v=$(get $m); [[ -n "$v" ]] && ok "  $m $v" || { case "$name:$m" in main:qwen_tts|main:faster_whisper|main:soundfile) fail "  $m missing in the $name env";; chatterbox:chatterbox) fail "  chatterbox missing in the chatterbox env";; *) : ;; esac; }
  done
}
check_env main "$MAIN_PY" 1
check_env chatterbox "$CB_PY" 0

# ---------------------------------------------------------------- models
bold "Models ($HF_CACHE)"
if [[ -n "$MAIN_PY" ]] && [[ -d "$ROOT/backend/shadowfetch_worker" ]]; then
  PYTHONPATH="$ROOT/backend" "$MAIN_PY" - "$HF_CACHE" <<'PY' 2>/dev/null || warn "could not query the model registry"
import sys
from pathlib import Path
from shadowfetch_worker.models.registry import MODELS
from shadowfetch_worker.models.verify import verify_hf_snapshot
hf = Path(sys.argv[1])
for mid, spec in MODELS.items():
    vr = verify_hf_snapshot(hf, spec["repo"], spec["revision"], spec["required_files"])
    if vr.ok:
        print(f"  \033[32m✔\033[0m {mid}: installed ({vr.size_bytes/1e9:.2f} GB, rev {str(vr.revision)[:12]})")
    elif vr.path is None:
        print(f"  \033[33m!\033[0m {mid}: not installed ({spec['approx_size_bytes']/1e9:.1f} GB, {spec['license']}) — download from Settings")
    else:
        print(f"  \033[31m✖\033[0m {mid}: incomplete — {'; '.join(vr.errors + ['missing ' + f for f in vr.missing_files])}")
PY
else
  if [[ -d "$HF_CACHE" ]]; then for d in "$HF_CACHE"/models--*; do [[ -d "$d" ]] && ok "$(basename "$d") ($(du -sh "$d" 2>/dev/null | cut -f1))"; done; else warn "no HF cache yet at $HF_CACHE"; fi
fi
[[ -f "$SETTINGS" ]] && python3 -c "import json,sys; print('  offline mode:', json.load(open(sys.argv[1])).get('offline', False))" "$SETTINGS" 2>/dev/null

bold "Disk"
for d in "$APP_DATA" "$MODELS_DIR"; do
  [[ -d "$d" ]] || continue
  free_gb=$(df -BG --output=avail "$d" 2>/dev/null | tail -1 | tr -dc '0-9')
  if (( free_gb < 5 )); then fail "$d: only ${free_gb} GB free (models need ~5 GB for Qwen3-TTS, ~3 GB for Chatterbox)"; elif (( free_gb < 15 )); then warn "$d: ${free_gb} GB free"; else ok "$d: ${free_gb} GB free"; fi
done

# ---------------------------------------------------------------- summary
bold "Summary"
if (( FAILS > 0 )); then printf '  \033[31m%d hard failure(s)\033[0m, %d warning(s)\n' "$FAILS" "$WARNS"; else printf '  \033[32mno hard failures\033[0m, %d warning(s)\n' "$WARNS"; fi
if [[ $JSON == 1 ]]; then
  printf '{"failures":%d,"warnings":%d,"items":[' "$FAILS" "$WARNS"
  first=1; for s in "${SUMMARY[@]}"; do [[ $first == 1 ]] || printf ','; first=0; printf '{"level":"%s","message":%s}' "${s%%|*}" "$(python3 -c 'import json,sys; print(json.dumps(sys.argv[1]))' "${s#*|}")"; done
  printf ']}\n'
fi
(( FAILS == 0 ))
