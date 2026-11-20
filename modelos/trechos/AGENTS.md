## Agentes neste projeto (don)

Este arquivo é a fonte única das regras para Claude Code, Codex e Antigravity (`agy`). O
`CLAUDE.md` só o importa (`@AGENTS.md`) e acrescenta o que é do Claude.

Caminhos que nenhum agente externo toca e que o git recusa no commit sem liberação humana estão
em `.githooks/don.json` (ativo com `git config core.hooksPath .githooks`).

### Claude Code

- Orquestra: entende o pedido, divide o trabalho, delega, revisa o diff e faz o commit. Delegação
  para Codex e `agy` passa pela skill `don`, nunca por chamada solta.
- Nunca use `--no-verify` nem `LIBERA_CAMINHO_PROTEGIDO`: a liberação é humana.

### Codex

- Rode com o perfil de permissões `don` de `.codex/config.toml` (gerado por
  `don perfil-codex`): áreas reservadas só leitura, segredos negados, sem rede.
- Nunca passe `-s workspace-write`: o sandbox explícito passa por cima do perfil.

### Antigravity (`agy`)

- O hook `.agents/hooks.json` bloqueia escrita nas áreas reservadas e fora da área de trabalho,
  também para os workers de um `/swarm`. Rode sempre com `--sandbox`; nunca com
  `--dangerously-skip-permissions`.
- `/swarm` só em worktree própria, com tarefas que não dividem arquivos.

### Quando você é um worker delegado

Se o seu prompt começa com "Você é um worker delegado", você está numa worktree descartável:
não faça commit nem push, não mexa em dependências e não edite áreas reservadas. Na dúvida, pare e
devolva status `bloqueado` com a pergunta. O orquestrador revisa e integra.
