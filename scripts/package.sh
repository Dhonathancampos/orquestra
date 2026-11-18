#!/usr/bin/env bash
# Uso: package.sh <nome-plataforma> <target-triple>   (roda no CI depois do cargo build)
set -euo pipefail
NAME="$1"; TARGET="$2"
VER=$(grep -m1 '^version' Cargo.toml | cut -d'"' -f2)
BASE="orquestra-v${VER}-${NAME}"
BIN="target/${TARGET}/release/orquestra"
rm -rf dist stage && mkdir -p dist "stage/${BASE}"

case "$NAME" in
  linux-*)
    cp "$BIN" "stage/${BASE}/orquestra"
    cp packaging/install-linux.sh packaging/orquestra.desktop README.md "stage/${BASE}/"
    tar -C stage -czf "dist/${BASE}.tar.gz" "$BASE" ;;
  windows-*)
    cp "${BIN}.exe" "stage/${BASE}/orquestra.exe"
    cp README.md "stage/${BASE}/"
    (cd stage && 7z a -tzip "../dist/${BASE}.zip" "$BASE" >/dev/null) ;;
  macos-*)
    APP="stage/Orquestra.app/Contents"
    mkdir -p "$APP/MacOS" "$APP/Resources"
    cp "$BIN" "$APP/MacOS/orquestra"
    sed "s/__VERSION__/${VER}/g" packaging/Info.plist > "$APP/Info.plist"
    (cd stage && ditto -c -k --sequesterRsrc --keepParent Orquestra.app "../dist/${BASE}.zip") ;;
esac
ls -la dist
