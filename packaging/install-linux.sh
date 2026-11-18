#!/usr/bin/env bash
# Instala o Orquestra para o seu usuário (sem sudo): binário em ~/.local/bin e atalho no menu de aplicativos.
set -e
cd "$(dirname "$0")"
mkdir -p ~/.local/bin ~/.local/share/applications
install -m 755 orquestra ~/.local/bin/orquestra
sed "s|__BIN__|$HOME/.local/bin/orquestra|" orquestra.desktop > ~/.local/share/applications/orquestra.desktop
echo "Instalado. Procure por 'Orquestra' no menu, ou rode: orquestra"
echo "Requer libwebkit2gtk-4.1 (Debian/Ubuntu: sudo apt install libwebkit2gtk-4.1-0)."
