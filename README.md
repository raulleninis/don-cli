# orquestra

O Claude (Opus) orquestra; o Codex (OpenAI) e o Antigravity/`agy` (Google) executam. Cada
tarefa delegada roda numa **worktree git descartável**, com uma trava de caminhos sensíveis que
vale para todos os agentes. O orquestrador recebe de volta só um **relatório curto**, sem o
transcript.

O objetivo é gastar menos cota e menos limite do Claude. O modelo caro fica com o que exige
julgamento: entender o pedido, dividir o trabalho, revisar o diff e decidir. Execução, reescrita
mecânica, leitura ampla e trabalho paralelo vão para modelos mais baratos, ou para a cota de
outros fornecedores.

> Testado no Windows 11 com Node 24, Codex CLI 0.171 e agy 1.5.13 (novembro de 2026). Os nomes de
> modelo mudam com o tempo; ajuste em `.githooks/orquestra.json` e na skill.

---

## Como funciona

```
 Claude (Opus) ── escreve o briefing ──► orquestra delegar --motor codex|agy
                                              │
                    ┌─────────────────────────┴─────────────────────────┐
                    │ 1. git worktree add ../<projeto>-agentes/<slug>   │
                    │    branch agente/<slug>, a partir do HEAD         │
                    │ 2. dependências por junction (node_modules, .venv)│
                    │ 3. worker roda com sandbox + hook + preâmbulo     │
                    │ 4. git add -A; diff contra a base                 │
                    │    └─ toca área reservada? → REJEITADO            │
                    │ 5. verificação do orquestra.json (só o que mudou) │
                    │ 6. commit na branch do agente                     │
                    │ 7. registro em .agentes/registro.jsonl            │
                    └─────────────────────────┬─────────────────────────┘
                                              │
 Claude ◄── relatório de ~15 linhas: status, resumo, dúvidas, diffstat, verificação
   │
   └─ revisa git diff → git merge --squash agente/<slug> → commit → orquestra limpar <slug>
```

O worker responde num JSON fixo (`status`, `resumo`, `arquivos`, `testes`, `duvidas`), pedido
com `--output-schema` no Codex e `--json-schema` no agy. O log completo fica em
`.agentes/saidas/<slug>/` (fora do git) e só entra no contexto do Claude se ele for ler.

## Camadas de proteção

Quando o Claude chama `codex` ou `agy` pelo shell, **os hooks e permissões do Claude não valem**:
eles só vigiam as ferramentas do próprio Claude. Por isso a orquestra empilha camadas
independentes:

| Camada | Onde | O que faz | Provado em teste real |
|---|---|---|---|
| Worktree descartável | `delegar` | O worker nunca escreve na sua árvore; sem `.env` (não versionado) | sim |
| Preâmbulo do worker | `delegar` + `AGENTS.md` | Diz o que não editar e manda parar na dúvida | sim (modelos bons obedecem; o barato nem sempre) |
| Perfil de permissões do Codex | `.codex/config.toml` | Áreas reservadas só leitura, segredos negados, sem rede | sim: `Set-Content` em área protegida → acesso negado |
| Hook do agy | `.agents/hooks.json` | Nega escrita em área reservada e fora da worktree; nos workers, só roda comando de `agy.comandos` | sim, inclusive nos workers de um `/swarm` |
| Checagem do diff | `delegar` | Qualquer arquivo reservado no diff → `REJEITADO`, nada a integrar | sim: pegou o Codex Luna escrevendo pelo shell |
| Pre-commit do git | `.githooks/` | Recusa commit em caminho protegido, de agente ou de gente | sim (testes do pacote) |
| Permissões do Claude | `.claude/settings.json` | Proíbe `--no-verify`, a liberação humana e as opções `--dangerously*` | sim |

**Protegido** é o que nenhum commit leva sem liberação humana (`LIBERA_CAMINHO_PROTEGIDO=1 git
commit`). **Reservado** é o que agente externo nunca toca: inclui os protegidos e, por padrão,
`.claude/`, `.codex/`, `.agents/`, `AGENTS.md`, `CLAUDE.md` e `.gitignore`.

---

## Requisitos

- Node.js 20 ou mais novo e git.
- Claude Code no projeto.
- Codex CLI (`npm i -g @openai/codex`) e/ou Antigravity CLI (`agy`), autenticados.
- No Windows, criar junction não precisa de administrador.

## Instalar num projeto

```bash
# 1. Copia hooks, configuração, skill e agente para o projeto (não sobrescreve o que existe)
node E:/Projetos/dev/orquestra/bin/orquestra.mjs instalar <pasta-do-projeto>
```

Para usar `orquestra` como comando, rode `npm link` na pasta do pacote. O resto deste README usa
`orquestra` para encurtar.

O `instalar` cria:

| Arquivo | Para quê |
|---|---|
| `.githooks/orquestra.json` | **Configuração do projeto** (nunca sobrescrita) |
| `.githooks/caminhos.mjs` | Lê a configuração; lista única usada por todas as camadas |
| `.githooks/pre-commit`, `pre-commit.mjs` | Trava do git |
| `.agents/hooks.json`, `.agents/hooks/guarda.mjs` | Hook do agy (mescla com hooks que já existam) |
| `.claude/skills/delegar/SKILL.md` | Ensina o Claude a delegar (quem faz o quê, briefing, ciclo) |
| `.claude/agents/explorador.md` | Subagente Haiku para buscas baratas |
| `.gitignore` (+ `.agentes/`), `.gitattributes` (LF nos hooks) | |

Depois, siga os passos que o `instalar` imprime:

1. **Revise `.githooks/orquestra.json`** (veja abaixo): o que é protegido e reservado, a verificação.
2. **Perfil do Codex:** `orquestra perfil-codex >> .codex/config.toml` (ou cole à mão).
3. **Confiança do Codex:** o Codex só carrega o `.codex/config.toml` de projeto confiável. Abra
   `codex` uma vez na pasta e aceite, ou acrescente em `~/.codex/config.toml`:
   ```toml
   [projects.'E:\caminho\do\projeto']
   trust_level = "trusted"
   ```
   As worktrees herdam a confiança do repositório principal. Sem ela, o `delegar` recusa rodar o
   Codex em escrita, e o próprio Codex aborta (falha fechada).
4. **Regras:** junte ao `AGENTS.md` o trecho de `modelos/trechos/AGENTS.md` e faça o `CLAUDE.md`
   importá-lo (`@AGENTS.md` numa linha). Codex e agy leem o `AGENTS.md`; o Claude, o `CLAUDE.md`.
5. **Permissões do Claude:** mescle `modelos/trechos/claude-settings.json` (o `instalar` já imprime
   com o caminho certo) no `.claude/settings.json`.
6. **Commit.** O pre-commit ainda não está ativo, então este commit passa.
7. **Uma pessoa ativa a trava:** `git config core.hooksPath .githooks`. O Claude é proibido de
   rodar isso, de propósito.
8. `orquestra checar` deve mostrar tudo `ok`.

## Configuração (`.githooks/orquestra.json`)

```jsonc
{
  "projeto": "meu-app",
  "protegidos": { "src/crypto/": "Congelado até liberação." },   // commit só com liberação humana
  "reservados": { "api/": "Território sensível.", "package.json": "Dependências: só humano." },
  "liberados":  ["docs/rascunhos/livre.md"],                     // exceções, valem antes de tudo
  "segredos":   ["**/.env", "**/.env.*", "**/*.pem", "**/*.key"], // Codex: leitura negada
  "worktrees":  "../{projeto}-agentes",                           // onde ficam as worktrees
  "links":      ["node_modules"],                                 // junctions para a worktree
  "verificacao": [
    { "nome": "lint", "comando": ["node", "node_modules/eslint/bin/eslint.js", "{arquivos}"],
      "extensoes": [".ts", ".tsx"] },
    { "nome": "test", "comando": ["node", "node_modules/vitest/vitest.mjs", "run", "--changed", "{base}"] }
  ],
  "codex": { "modelo": "gpt-6.2-sol", "esforco": "high", "perfil": "orquestra" },
  "agy":   { "modelo": "gemini-3.8-flash-high", "comandos": ["pnpm test", "pnpm exec", "git diff"] },
  "preambulo": ["Textos de interface em português coloquial."]
}
```

| Campo | Detalhe |
|---|---|
| Padrões | Globs relativos à raiz. `pasta/` casa a pasta e tudo dentro; `*` não cruza `/`; `**/` casa qualquer profundidade; sem distinção de maiúsculas. |
| Embutidos | Sempre protegidos: `.env*`, `.githooks/`, os hooks de `.claude`, `.codex` e `.agents`. Sempre reservados: `.claude/`, `.codex/`, `.agents/`, `AGENTS.md`, `CLAUDE.md`, `GEMINI.md`, `.gitignore`. `.env.example` é liberado. |
| `verificacao` | Roda na worktree depois do worker. `{arquivos}` vira os arquivos alterados (filtrados por `extensoes`; a etapa é pulada se não sobrar nenhum); `{base}` vira o commit base. `node` é o Node atual; caminho com `/` é relativo à worktree. **Prefira verificar só o que mudou**: se o projeto já tem dívida de lint, verificar tudo marca toda delegação como falha. |
| `links` | Pastas pesadas reaproveitadas por junction em vez de instalar. Só funciona se a base tiver o mesmo lockfile que o `HEAD` (o `delegar` confere). |
| `codex.perfil` | Nome do perfil no `.codex/config.toml`. `null` roda com `-s workspace-write` e só a checagem do diff protege: não recomendado. |
| `agy.comandos` | Prefixos de comando que um worker do agy pode rodar (testes, lint). Fora deles, e qualquer encadeamento (`;`, `&&`, `\|`, `>`, `$(`), o hook nega. |

Há modelos prontos para Node (`orquestra.node.json`), Python (`orquestra.python.json`) e vazio. O
`instalar` escolhe pelo que encontra no projeto, ou use `--tipo`.

## Uso

```bash
orquestra delegar --motor codex --briefing .agentes/briefings/tela-x.md
orquestra delegar --motor codex --modelo gpt-6.2-astra --briefing .agentes/briefings/bug-y.md
orquestra delegar --motor agy --modo leitura --briefing .agentes/briefings/mapa-do-modulo.md
orquestra delegar --motor agy --swarm --minutos 60 --briefing .agentes/briefings/tres-telas.md
orquestra listar | orquestra limpar <slug> | orquestra relatorio | orquestra checar
```

Opções de `delegar`: `--modo escrita|leitura`, `--modelo`, `--esforco`, `--slug`, `--base`
(padrão `HEAD`), `--minutos` (30; swarm 60), `--swarm`, `--sem-verificacao`.

**A base é o `HEAD`.** Faça commit do que o worker precisa ver antes de delegar. Mudanças não
commitadas não vão para a worktree.

### Briefing

O worker começa frio: não vê a sua conversa. Um bom briefing tem:

```markdown
# <título>
Objetivo: <uma frase> (ref.: <issue/requisito/spec>)
Arquivos permitidos: src/telas/x.tsx, tests/x.test.tsx
Aceite: <critérios>; fora do escopo: <...>
Verificar: pnpm exec vitest run tests/x.test.tsx
Contexto: <o que ele não acharia sozinho>
```

A orquestra acrescenta sozinha as regras de worker: sem commit, sem dependências, áreas
reservadas, parar na dúvida, resposta em JSON.

### Depois da delegação

1. `REJEITADO`: o worker mexeu em área reservada. Não integre; `orquestra limpar <slug>`.
2. Leia as dúvidas do worker. Elas valem como dúvidas da tarefa.
3. `git diff <base>..agente/<slug>`. **O aceite é do orquestrador.**
4. `git merge --squash agente/<slug>`, verificação completa do projeto, commit, `orquestra limpar <slug>`.

## Quem faz o quê

| Trabalho | Quem |
|---|---|
| Entender, dividir, revisar, decidir, integrar | Claude Opus (sessão principal) |
| Tarefa de minutos, ou que depende do contexto da conversa | O próprio Claude ou um subagente Sonnet |
| Achar onde está algo | `explorador` (Haiku) |
| Feature bem especificada | Codex `gpt-6.2-sol` (melhor equilíbrio) |
| Bug difícil, refatoração grande, segunda opinião | Codex `gpt-6.2-astra` (máxima capacidade) |
| Ajuste visual a partir de screenshot | Codex `gpt-6.1-terra` |
| Lote mecânico, classificar, extrair | Codex `gpt-6-luna` ou agy `gemini-3.8-flash-*` |
| Leitura ampla, resumo de muitos arquivos | agy `gemini-3.8-flash-high` em `--modo leitura` |
| Partes independentes em paralelo | agy `/swarm` |
| Território sensível (crypto, auth, dinheiro...) | Fica com o Claude |

O agy também oferece `claude-sonnet-4-6` e `claude-opus-4-6-thinking`, que gastam a cota do
Google e não a da Anthropic.

**Delegar também custa.** Briefing, relatório e revisão do diff consomem tokens do orquestrador.
Delegue quando a execução for bem maior que a explicação.

## Swarm (agy)

`--swarm` manda `/swarm <briefing>` ao agy. O agente vira coordenador, cria workers (cada um numa
conversa própria) e eles se falam por um quadro de mensagens. Testado headless, com o quadro
auditável em `~/.gemini/antigravity-cli/brain/<conversa>/.system_generated/swarm/board.jsonl`:
3 workers, 6 posts, 40 s, e o hook do projeto valeu para cada worker.

- É **preview** e gasta muita cota: cada worker é um agente.
- Só para trabalho paralelo de verdade e **sem arquivos em comum**: 2 a 4 workers, uma área por
  worker. Escreva a divisão no briefing (`@nome: arquivos e tarefa`) e o modelo dos workers.
- Verifier, monitor e narrator **não aparecem sozinhos**; só se você pedir.
- Todos os workers trabalham na mesma worktree. A verificação final é a do `delegar`, e a revisão
  é a sua.

## Armadilhas já encontradas

Cada uma destas aconteceu nos testes e está tratada no código:

1. **`-s workspace-write` anula o perfil do Codex.** O sandbox explícito passa por cima do
   `default_permissions`, e o Codex Luna, instruído a não fazer, escreveu em área protegida pelo
   shell. A orquestra usa `-c default_permissions="<perfil>"`.
2. **O pnpm 11 quase apagou o `node_modules` do projeto.** Antes de cada script ele confere as
   dependências; estranhando a junction, tenta apagar a pasta de módulos para reinstalar. Pela
   junction, apagaria a do projeto. Só não apagou por falta de TTY. A orquestra desliga
   `verify-deps-before-run` em todo processo que inicia, roda a verificação pelo Node direto e
   **desfaz as junctions antes de remover qualquer worktree**. Nunca rode `pnpm install` numa
   worktree de agente, e remova só com `orquestra limpar`.
3. **Instalar dependências na worktree travou.** Com o store do pnpm no C: e o projeto no E:,
   não há hardlink e o pnpm copia tudo; ficou 10 minutos parado. Daí as junctions.
4. **O agy em `-p` nega sozinho todo comando que pediria permissão**, e o worker termina **sem
   resposta final**. As regras de `--settings` só casaram o comando exato ou `command(*)` (o
   prefixo não). A orquestra libera `command(*)` e quem filtra é o hook, com a lista
   `agy.comandos`.
5. **O envelope JSON do agy repete o esquema pedido** (`json_schema.properties.status`...), o que
   engana um leitor ingênuo. A resposta real vem em `structured_output`.
6. **A verificação do projeto inteiro reprova tudo** quando o projeto já tem dívida de lint.
   Verifique o que mudou (`{arquivos}`, `--changed {base}`).
7. **Junction e `.gitignore`:** `node_modules/` (com barra) só casa diretório, e a junction poderia
   entrar no commit do worker. A orquestra acrescenta `/node_modules` ao `.git/info/exclude`.

## Solução de problemas

| Sintoma | Causa e saída |
|---|---|
| `O worker não devolveu o JSON esperado` + `no output produced ... headless mode` | Um comando do worker do agy foi negado. Veja `.agentes/saidas/<slug>/guarda.log`; se ele precisa daquele comando, acrescente o prefixo em `agy.comandos`. |
| `default_permissions requires a [permissions] table` | O Codex não carregou o `.codex/config.toml`: projeto não confiável (passo 3) ou perfil não colado (passo 2). |
| `A base tem outro lockfile` | `--base` aponta para um commit com outras dependências; delegue a partir do `HEAD`. |
| Toda delegação com `verificação FALHOU` | Rode o comando da etapa na worktree (`orquestra listar`) e veja se a falha já existia na base. |
| `Commit recusado: caminho protegido` | Era para recusar. Se a mudança foi liberada, uma pessoa faz `LIBERA_CAMINHO_PROTEGIDO=1 git commit`. |
| Worktree órfã | `orquestra listar` e `orquestra limpar <slug>`. Evite `git worktree remove` direto quando houver junctions. |

## Desinstalar

`git config --unset core.hooksPath`. Depois remova `.githooks/`, `.agents/hooks*`,
`.claude/skills/delegar/`, `.claude/agents/explorador.md`, o perfil do `.codex/config.toml`, o
trecho do `AGENTS.md` e as permissões no `.claude/settings.json`. Remova as worktrees abertas com
`orquestra limpar`.

## Limitações

- Testado de verdade só no Windows. No macOS e no Linux o `symlink` "junction" vira link
  simbólico de diretório; deve funcionar, mas não foi provado.
- O hook do agy reconhece ferramentas pelo nome (`read*`, `view*`, `list*`... são leitura) e
  caminhos por chaves com `path`/`file`/`uri`/`dir`. Ferramenta nova com outro formato passa por
  ele; a checagem do diff continua valendo.
- O `relatorio` é um resumo simples do `registro.jsonl`; não mede tokens.
- Não há suporte a outros agentes externos (Gemini CLI, Aider...), mas `lib/delegar.mjs` tem um
  ponto só por motor.

## Desenvolvimento

```
bin/orquestra.mjs      CLI
lib/                   delegar, instalar, processo (spawn seguro), resposta (JSON), codex (confiança)
modelos/               o que o instalar copia para o projeto
test/                  node --test (31 testes: globs, hook, pre-commit, perfil, resposta, confiança)
```

`npm test` roda tudo, sem dependências.
