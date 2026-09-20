#!/usr/bin/env bash
# Package the desktop app: .deb (primary) and AppImage.
#   scripts/build.sh            → src-tauri/target/release/bundle/{deb,appimage}/
#   scripts/build.sh --deb-only
# The Python runtime and model weights are NOT inside the package: the app creates its runtime on first run
# (scripts/bootstrap.sh --runtime-dir, bundled as a resource) and downloads models after showing size + license.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
die() { printf '\033[31m✖\033[0m %s\n' "$*" >&2; exit 1; }
pkg-config --exists webkit2gtk-4.1 gtk+-3.0 2>/dev/null || die "Tauri system libraries missing (libwebkit2gtk-4.1-dev, libgtk-3-dev, librsvg2-dev, libayatana-appindicator3-dev, libxdo-dev, libssl-dev)"
command -v cargo >/dev/null || die "cargo (Rust) is required"
[[ -f "$ROOT/backend/requirements/main.lock.txt" ]] || echo "note: backend/requirements/main.lock.txt missing — run scripts/bootstrap.sh to generate locks"
find "$ROOT/backend/shadowfetch_worker" -name __pycache__ -type d -prune -exec rm -rf {} +   # keep bytecode out of the package
# linuxdeploy walks PATH and aborts if `node` is a symlink to an unreadable target
# (for example a root-only install). Skip those entries.
_sfvs_path=""
IFS=':' read -ra _sfvs_parts <<< "$PATH"
for _sfvs_d in "${_sfvs_parts[@]}"; do
  [[ -z "$_sfvs_d" ]] && continue
  if [[ -L "$_sfvs_d/node" ]]; then
    _sfvs_tgt=$(readlink -f "$_sfvs_d/node" 2>/dev/null || true)
    if [[ -z "$_sfvs_tgt" || ! -r "$_sfvs_tgt" ]]; then
      continue
    fi
  fi
  _sfvs_path="${_sfvs_path:+$_sfvs_path:}$_sfvs_d"
done
export PATH="$_sfvs_path"
unset _sfvs_path _sfvs_parts _sfvs_d _sfvs_tgt
cd "$ROOT/frontend" && { [[ -d node_modules ]] || npm install; }
cd "$ROOT/src-tauri"
# linuxdeploy (AppImage) is FUSE-sensitive; extract-and-run avoids /dev/fuse failures.
export APPIMAGE_EXTRACT_AND_RUN="${APPIMAGE_EXTRACT_AND_RUN:-1}"
BUNDLES="deb,appimage"; [[ "${1:-}" == "--deb-only" ]] && BUNDLES="deb"
set +e
npx --yes @tauri-apps/cli@^2 build --bundles "$BUNDLES" "${@:2}"
bundle_rc=$?
set -e
if [[ $bundle_rc -ne 0 && "$BUNDLES" == *appimage* && "$BUNDLES" == *deb* ]]; then
  echo "note: combined bundle failed (usually AppImage/linuxdeploy); building the .deb alone"
  npx --yes @tauri-apps/cli@^2 build --bundles deb "${@:2}"
fi

# Tauri names the generated desktop file after productName (spaces) and/or the
# binary. Keep a single Freedesktop id so the app menu shows one launcher.
fix_deb_desktop() {
  local deb="$1"
  command -v dpkg-deb >/dev/null || { echo "note: dpkg-deb missing — leaving $deb as bundled"; return 0; }
  local tmp
  tmp=$(mktemp -d)
  dpkg-deb -R "$deb" "$tmp"
  rm -f "$tmp/usr/share/applications/Shadowfetch Voice Studio.desktop" \
        "$tmp/usr/share/applications/shadowfetch-voice-studio.desktop"
  install -d "$tmp/usr/share/applications"
  install -m 644 "$ROOT/src-tauri/linux/com.shadowfetch.voicestudio.desktop" \
    "$tmp/usr/share/applications/com.shadowfetch.voicestudio.desktop"
  mkdir -p "$tmp/DEBIAN"
  cat > "$tmp/DEBIAN/postinst" << 'EOF'
#!/bin/sh
set -e
clean_hidden_stub() {
  f="$1"
  [ -f "$f" ] || return 0
  if grep -q '^Hidden=true' "$f" 2>/dev/null || grep -q '^NoDisplay=true' "$f" 2>/dev/null; then
    rm -f "$f"
  fi
}
homes="$HOME"
if [ -n "${SUDO_USER:-}" ] && [ "$SUDO_USER" != "root" ]; then
  uhome=$(getent passwd "$SUDO_USER" | cut -d: -f6 || true)
  [ -n "$uhome" ] && homes="$homes $uhome"
fi
for home in $homes; do
  clean_hidden_stub "$home/.local/share/applications/shadowfetch-voice-studio.desktop"
  clean_hidden_stub "$home/.local/share/applications/Shadowfetch Voice Studio.desktop"
done
command -v update-desktop-database >/dev/null && update-desktop-database -q /usr/share/applications || true
command -v gtk-update-icon-cache >/dev/null && gtk-update-icon-cache -q /usr/share/icons/hicolor || true
exit 0
EOF
  chmod 755 "$tmp/DEBIAN/postinst"
  dpkg-deb -b "$tmp" "$deb"
  rm -rf "$tmp"
}

while IFS= read -r -d '' deb; do
  fix_deb_desktop "$deb"
done < <(find "$ROOT/src-tauri/target/release/bundle/deb" -maxdepth 2 -type f -name '*.deb' -print0 2>/dev/null || true)

echo
echo "Artifacts:"; find "$ROOT/src-tauri/target/release/bundle" -maxdepth 2 -type f \( -name '*.deb' -o -name '*.AppImage' \) -exec ls -la {} \;
