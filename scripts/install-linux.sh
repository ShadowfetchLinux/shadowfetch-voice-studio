#!/usr/bin/env bash
# Build (unless --skip-build) and replace the installed Linux desktop app.
#   scripts/install-linux.sh
#   scripts/install-linux.sh --skip-build
#   scripts/install-linux.sh --with-chatterbox
#
# The .deb is the menu/desktop install. The Python runtime lives under
# ~/.local/share/com.shadowfetch.voicestudio/runtime (created here if missing
# or still linked to the git checkout).
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SKIP_BUILD=0
WITH_CB=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --skip-build) SKIP_BUILD=1; shift;;
    --with-chatterbox) WITH_CB=1; shift;;
    -h|--help) sed -n '2,10p' "$0"; exit 0;;
    *) echo "unknown option: $1" >&2; exit 2;;
  esac
done

die() { printf '\033[31m✖\033[0m %s\n' "$*" >&2; exit 1; }
ok()  { printf '\033[32m✔\033[0m %s\n' "$*"; }

DATA="${XDG_DATA_HOME:-$HOME/.local/share}/com.shadowfetch.voicestudio"
RUNTIME="$DATA/runtime"

if [[ "$SKIP_BUILD" != 1 ]]; then
  "$ROOT/scripts/build.sh"
fi

DEB=$(find "$ROOT/src-tauri/target/release/bundle/deb" -maxdepth 2 -type f -name '*.deb' -printf '%T@ %p\n' 2>/dev/null | sort -n | tail -1 | cut -d' ' -f2-)
[[ -n "$DEB" && -f "$DEB" ]] || die "no .deb found — run without --skip-build"

ok "installing $(basename "$DEB")"
sudo dpkg -i "$DEB" || die "dpkg install failed"

# User-level Hidden stubs mask the system desktop file even after dpkg postinst
# if HOME was /root during sudo.
for f in \
  "$HOME/.local/share/applications/shadowfetch-voice-studio.desktop" \
  "$HOME/.local/share/applications/Shadowfetch Voice Studio.desktop"
do
  if [[ -f "$f" ]] && grep -Eq '^(Hidden|NoDisplay)=true' "$f"; then
    rm -f "$f"
    ok "removed menu stub $(basename "$f")"
  fi
done
rm -f /usr/share/applications/"Shadowfetch Voice Studio.desktop" \
      /usr/share/applications/shadowfetch-voice-studio.desktop 2>/dev/null || \
  sudo rm -f /usr/share/applications/"Shadowfetch Voice Studio.desktop" \
             /usr/share/applications/shadowfetch-voice-studio.desktop || true

if [[ -L "$RUNTIME/envs/main" ]] || [[ ! -x "$RUNTIME/envs/main/bin/python" ]]; then
  ok "creating a standalone engine runtime under $RUNTIME"
  args=(--runtime-dir "$RUNTIME" --python 3.12 --torch-backend cu128)
  if [[ "$WITH_CB" == 1 ]]; then args+=(--with-chatterbox); else args+=(--without-chatterbox); fi
  "$ROOT/scripts/bootstrap.sh" "${args[@]}"
else
  ok "standalone runtime already present: $RUNTIME/envs/main"
fi

command -v update-desktop-database >/dev/null && update-desktop-database -q "$HOME/.local/share/applications" || true
command -v gtk-update-icon-cache >/dev/null && gtk-update-icon-cache -q /usr/share/icons/hicolor || true

ok "Shadowfetch Voice Studio is installed as a standalone Linux app"
echo "  launcher: /usr/bin/shadowfetch-voice-studio"
echo "  desktop:  /usr/share/applications/com.shadowfetch.voicestudio.desktop"
echo "  runtime:  $RUNTIME/envs/main"
