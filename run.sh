#!/usr/bin/env bash
# Compila e abre o Orquestra a partir do código-fonte. Uso: ./run.sh   (ORQUESTRA_PORT=7777 por padrão)
set -e
cd "$(dirname "$0")"
export PATH="$HOME/.cargo/bin:$PATH"
[ -d web/node_modules ] || (cd web && npm install)
(cd web && npm run build)
FEATURES=""
# Janela nativa: no Linux precisa do WebKitGTK; sem ele, abre no navegador.
if [ "$(uname)" != "Linux" ] || pkg-config --exists webkit2gtk-4.1 2>/dev/null; then FEATURES="--features gui"; fi
cargo build --release $FEATURES
exec ./target/release/orquestra
