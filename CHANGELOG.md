# Changelog

## Não lançado
- **Chat com mensagens de verdade:** para chats do Claude, a visão de chat deixa de adivinhar pela tela do terminal e lê o transcript estruturado da sessão (`~/.claude/projects/.../<sessão>.jsonl`). Mensagens separadas, markdown, cards de ferramenta recolhíveis (Bash com comando e saída; Edit/Write com diff; Read, Grep, Glob, tarefas e ferramentas MCP), faixa com título, modelo e custo, e botões de permissão. Outras IAs seguem na leitura antiga.
- O app abre o Claude com `--session-id` para ligar cada chat ao seu transcript (e segue a sessão nova após `/clear`). Só os tipos de evento usados pela interface saem do servidor: nada de prompts de sistema, hooks ou dados de conta.
- **Chats sobrevivem ao reinício:** a lista de chats (nome, IA, pasta, tema, vínculo com o orquestrador, sessão) é salva em disco e recriada ao abrir, com os mesmos ids, então posição, tamanho e temas voltam. Chats do Claude retomam a conversa com `--resume`; as outras IAs reabrem do zero.
- Visão de chat (primeira versão), temas por chat, controle de tamanho dos terminais, ajustes de entrada (acentos/IME) e `scripts/regression.py`.

## 0.1.0
- Área de trabalho com terminais móveis e redimensionáveis, zoom por scroll e linhas ligando o orquestrador aos chats.
- Orquestrador (chat central) que abre, controla, lê e fecha os outros chats via MCP.
- IAs configuráveis (Claude, Codex, Gemini, shell ou qualquer CLI) e troca de IA por chat.
- Limpeza de contexto com checkpoint salvo no ai-memory e retomada automática.
- Memória compartilhada (ai-memory), pasta de trabalho segura e opção de bypass de permissões.
- App nativo (Linux, Windows e macOS), verificação de versão ao abrir e releases automáticos.
