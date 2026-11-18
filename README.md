# Orquestra

Orquestrador de terminais para trabalhar com IA. Uma área de trabalho onde terminais (Claude, Codex, Gemini, shell ou qualquer CLI) abrem, se movem e se redimensionam, com um **chat central — o orquestrador — que abre e controla os outros chats** para você fazer várias coisas ao mesmo tempo.

Backend em **Rust** (axum, portable-pty, vt100) · front em TypeScript puro + xterm.js (WebGL) · janela nativa via `wry` (WebView2 / WKWebView / WebKitGTK).

## Instalar

Baixe o arquivo da sua plataforma em [Releases](https://github.com/Dhonathancampos/orquestra/releases/latest):

| Sistema | Arquivo | Como abrir |
|---|---|---|
| Linux | `orquestra-vX.Y.Z-linux-x86_64.tar.gz` | extraia e rode `./install-linux.sh` (precisa de `libwebkit2gtk-4.1-0`) |
| Windows | `orquestra-vX.Y.Z-windows-x86_64.zip` | extraia e abra `orquestra.exe` (precisa do WebView2, já incluso no Win 10/11) |
| macOS (Apple Silicon) | `orquestra-vX.Y.Z-macos-aarch64.zip` | extraia e abra `Orquestra.app` |
| macOS (Intel) | `orquestra-vX.Y.Z-macos-x86_64.zip` | idem |

> Os apps ainda **não são assinados**: no macOS use *botão direito → Abrir* na primeira vez; no Windows o SmartScreen pede *Mais informações → Executar assim mesmo*.

Para os chats de IA funcionarem, instale as CLIs que quiser usar (ex.: [Claude Code](https://claude.com/claude-code)).

## Usar

1. **◉ Orquestrador** abre o chat central. Nenhum outro chat existe sem ele.
2. **＋ Claude / Codex / Gemini / Shell** abrem chats filhos (ou peça ao orquestrador: *"abra 3 agentes, um por módulo…"*).
3. Arraste pelo título, redimensione pelo canto, **scroll dá zoom** (Ctrl+scroll sempre), **⤢** enquadra tudo, **Ctrl+K** abre a paleta.
4. **🧹** limpa o contexto de um chat com segurança: o agente escreve um checkpoint, ele é gravado no ai-memory e reinjetado depois do `/clear`.
5. O seletor de IA em cada janela troca o chat de Claude para Codex etc. (reinicia a conversa).

### Configuração das IAs (⚙ IAs)
Arquivo `providers.json` (Linux `~/.config/orquestra/`, Windows `%APPDATA%\orquestra\`, macOS `~/Library/Application Support/orquestra/`). Cada IA é um atalho:

```json
{"id":"aider","name":"Aider","command":"aider","clear":"/clear","bypass_flag":"--yes-always"}
```

Chaves globais: `default_provider`, `workspace_dir` (pasta segura onde os chats abrem), `auto_trust_workspace`, `memory`, `orchestrator_can_bypass` (deixa o orquestrador abrir chats **sem pedir permissões** — desligado por padrão) e `check_updates`.

## Versão e atualizações
A versão vive no `Cargo.toml` e aparece na barra (`v0.1.0`). **Ao abrir, o app consulta o último release no GitHub** e mostra um aviso se houver versão mais nova (clique na versão para checar na hora). Desative com `"check_updates": false` ou `ORQUESTRA_NO_UPDATE_CHECK=1`.

Publicar uma versão nova:

```bash
scripts/release.sh 0.2.0   # atualiza Cargo.toml, cria a tag v0.2.0 e envia; o Actions compila e publica
```

## Compilar do código-fonte
Requer Rust, Node 20+ e, no Linux, `libwebkit2gtk-4.1-dev libgtk-3-dev libsoup-3.0-dev` (para a janela nativa; sem eles roda no navegador).

```bash
./run.sh                 # front + backend + janela
# ou manualmente
cd web && npm ci && npm run build && cd ..
cargo run --release --features gui
```

Variáveis: `ORQUESTRA_PORT` (7777), `ORQUESTRA_BROWSER=1` (força navegador), `ORQUESTRA_SHELL` (shell dos terminais).

## Segurança
Escuta só em `127.0.0.1` e rejeita `Host`/`Origin` diferentes (anti DNS-rebinding/CSRF). Quem controla o app controla seus terminais: não exponha a porta na rede.
