#!/usr/bin/env bash
# Uso: scripts/release.sh 0.2.0   → atualiza a versão, commita, cria a tag v0.2.0 e envia.
# O GitHub Actions compila Linux/Windows/Mac e publica o release; os apps instalados passam a avisar da nova versão.
set -euo pipefail
cd "$(dirname "$0")/.."
NEW="${1:?uso: scripts/release.sh X.Y.Z}"
[[ "$NEW" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || { echo "versão inválida: $NEW"; exit 1; }
[ -z "$(git status --porcelain)" ] || { echo "há mudanças não commitadas; commite antes"; exit 1; }
[ "$(git branch --show-current)" = "main" ] || { echo "faça o release a partir da branch main"; exit 1; }
CUR=$(grep -m1 '^version' Cargo.toml | cut -d'"' -f2)
echo "versão atual: $CUR → nova: $NEW"
sed -i.bak "0,/^version = \"$CUR\"/s//version = \"$NEW\"/" Cargo.toml && rm -f Cargo.toml.bak
cargo update -w >/dev/null 2>&1 || true
git add Cargo.toml Cargo.lock
git commit -m "release v$NEW"
git tag -a "v$NEW" -m "v$NEW"
git push origin main "v$NEW"
echo "Tag v$NEW enviada. Acompanhe: gh run watch"
