#!/usr/bin/env bash
# Package the desktop app: .deb (primary) and AppImage (if the tooling works).
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
cd "$ROOT/frontend" && { [[ -d node_modules ]] || npm install; }
cd "$ROOT/src-tauri"
BUNDLES="deb,appimage"; [[ "${1:-}" == "--deb-only" ]] && BUNDLES="deb"
npx --yes @tauri-apps/cli@^2 build --bundles "$BUNDLES" "${@:2}"
echo
echo "Artifacts:"; find "$ROOT/src-tauri/target/release/bundle" -maxdepth 2 -type f \( -name '*.deb' -o -name '*.AppImage' \) -exec ls -la {} \;
