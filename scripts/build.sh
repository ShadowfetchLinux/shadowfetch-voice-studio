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

# Tauri names generated desktop files and hicolor PNGs after productName and/or
# the binary. The launcher uses Icon=com.shadowfetch.voicestudio, so restamp both.
install_hicolor_icons() {
  local pkg="$1"
  local svg="$ROOT/src-tauri/icons/app-icon.svg"
  local hicolor="$pkg/usr/share/icons/hicolor"
  [[ -f "$svg" ]] || { echo "note: $svg missing — leaving bundled icons"; return 0; }
  local names=(com.shadowfetch.voicestudio shadowfetch-voice-studio)
  local size
  if command -v rsvg-convert >/dev/null; then
    for size in 16 22 24 32 48 64 96 128 256 512; do
      install -d "$hicolor/${size}x${size}/apps"
      rsvg-convert -w "$size" -h "$size" "$svg" \
        -o "$hicolor/${size}x${size}/apps/com.shadowfetch.voicestudio.png"
      install -m 644 "$hicolor/${size}x${size}/apps/com.shadowfetch.voicestudio.png" \
        "$hicolor/${size}x${size}/apps/shadowfetch-voice-studio.png"
    done
  else
    echo "note: rsvg-convert missing — copying PNG icons only"
    install -d "$hicolor/32x32/apps" "$hicolor/64x64/apps" "$hicolor/128x128/apps" \
      "$hicolor/256x256/apps" "$hicolor/512x512/apps"
    local src_png dest_size
    for dest_size in 32 64 128 256 512; do
      case "$dest_size" in
        32) src_png="$ROOT/src-tauri/icons/32x32.png" ;;
        64) src_png="$ROOT/src-tauri/icons/64x64.png" ;;
        128) src_png="$ROOT/src-tauri/icons/128x128.png" ;;
        256) src_png="$ROOT/src-tauri/icons/256x256.png" ;;
        512) src_png="$ROOT/src-tauri/icons/icon.png" ;;
      esac
      local name
      for name in "${names[@]}"; do
        install -m 644 "$src_png" "$hicolor/${dest_size}x${dest_size}/apps/${name}.png"
      done
    done
  fi
  install -d "$hicolor/scalable/apps"
  local name
  for name in "${names[@]}"; do
    install -m 644 "$svg" "$hicolor/scalable/apps/${name}.svg"
  done
}

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
  install_hicolor_icons "$tmp"
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
command -v gtk-update-icon-cache >/dev/null && gtk-update-icon-cache -f -q /usr/share/icons/hicolor || true
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
