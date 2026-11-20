# don

**O don dá as ordens; os outros executam.** O Claude (Opus) é o don: entende o pedido, divide o
trabalho, decide e aceita. O Codex (OpenAI) e o Antigravity/`agy` (Google) são os **soldati**: cada
ordem roda numa **worktree git descartável**, com uma trava de caminhos sensíveis que vale para
todos, e volta ao don como um **relatório curto**, sem o transcript.

O objetivo é gastar menos cota e menos limite do Claude. O modelo caro fica com o que exige
julgamento; execução, reescrita mecânica, leitura ampla e trabalho paralelo vão para modelos mais
baratos, ou para a cota de outros fornecedores.

| Papel | Quem | O que faz |
|---|---|---|
| **don** | o Claude orquestrador, e este CLI (`don`) | dá a ordem, revisa, integra e responde por ela |
| **consigliere** | as funções que **informam** o don: `resumir`, `revisar`, `briefing`, a documentação local e o MCP `consigliere`, e o subagente `consigliere` (Haiku) | aconselha: lê muito, devolve pouco e diz onde está a fonte |
| **soldato** | cada worker (Codex ou agy) de uma delegação; branch `soldato/<slug>` | executa a ordem na sua worktree, sem commit e sem sair da área |
| **caporegime** | o coordenador de um `/swarm` do agy | distribui a ordem entre vários soldati |

> Testado no Windows 11 com Node 24, Codex CLI 0.171 e agy 1.5.13 (novembro de 2026). Os nomes de
> modelo mudam com o tempo; ajuste em `.githooks/don.json` e na skill `don`.

---

## Como funciona

```
 don (Claude) ─── escreve a ordem ─────► don delegar --motor codex|agy
                                              │
                    ┌─────────────────────────┴─────────────────────────┐
                    │ 1. git worktree add ../<projeto>-soldati/<slug>   │
                    │    branch soldato/<slug>, a partir do HEAD        │
                    │ 2. dependências por junction (node_modules, .venv)│
                    │ 3. soldato roda com sandbox + hook + preâmbulo    │
                    │ 4. git add -A; diff contra a base                 │
                    │    └─ toca área reservada? → REJEITADO            │
                    │ 5. verificação do don.json (só o que mudou)       │
                    │ 6. commit na branch do soldato                    │
                    │ 7. registro em .don/registro.jsonl                │
                    └─────────────────────────┬─────────────────────────┘
                                              │
 don ◄──── relatório de ~15 linhas: status, resumo, dúvidas, diffstat, verificação
   │
   └─ revisa git diff → git merge --squash soldato/<slug> → commit → don limpar <slug>
```

O worker responde num JSON fixo (`status`, `resumo`, `arquivos`, `testes`, `duvidas`), pedido
com `--output-schema` no Codex e `--json-schema` no agy. O log completo fica em
`.don/saidas/<slug>/` (fora do git) e só entra no contexto do Claude se ele for ler.

## Camadas de proteção

Quando o Claude chama `codex` ou `agy` pelo shell, **os hooks e permissões do Claude não valem**:
eles só vigiam as ferramentas do próprio Claude. Por isso o don empilha camadas
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
node <pasta-do-don-cli>/bin/don.mjs instalar <pasta-do-projeto>
```

Para usar `don` como comando, rode `npm link` na pasta do pacote. O resto deste README usa
`don` para encurtar.

O `instalar` cria:

| Arquivo | Para quê |
|---|---|
| `.githooks/don.json` | **Configuração do projeto** (nunca sobrescrita) |
| `.githooks/caminhos.mjs` | Lê a configuração; lista única usada por todas as camadas |
| `.githooks/pre-commit`, `pre-commit.mjs` | Trava do git |
| `.agents/hooks.json`, `.agents/hooks/guarda.mjs` | Hook do agy (mescla com hooks que já existam) |
| `.claude/skills/don/SKILL.md` | Ensina o Claude a delegar (quem faz o quê, briefing, ciclo) |
| `.claude/agents/consigliere.md` | Subagente Haiku para buscas baratas |
| `.gitignore` (+ `.don/`), `.gitattributes` (LF nos hooks) | |

Depois, siga os passos que o `instalar` imprime:

1. **Revise `.githooks/don.json`** (veja abaixo): o que é protegido e reservado, a verificação.
2. **Perfil do Codex:** `don perfil-codex >> .codex/config.toml` (ou cole à mão).
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
8. `don checar` deve mostrar tudo `ok`.

## Configuração (`.githooks/don.json`)

```jsonc
{
  "projeto": "meu-app",
  "protegidos": { "src/crypto/": "Congelado até liberação." },   // commit só com liberação humana
  "reservados": { "api/": "Território sensível.", "package.json": "Dependências: só humano." },
  "liberados":  ["docs/rascunhos/livre.md"],                     // exceções, valem antes de tudo
  "segredos":   ["**/.env", "**/.env.*", "**/*.pem", "**/*.key"], // Codex: leitura negada
  "worktrees":  "../{projeto}-soldati",                           // onde ficam as worktrees
  "links":      ["node_modules"],                                 // junctions para a worktree
  "verificacao": [
    { "nome": "lint", "comando": ["node", "node_modules/eslint/bin/eslint.js", "{arquivos}"],
      "extensoes": [".ts", ".tsx"] },
    { "nome": "test", "comando": ["node", "node_modules/vitest/vitest.mjs", "run", "--changed", "{base}"] }
  ],
  "codex": { "modelo": "gpt-6.2-sol", "esforco": "high", "perfil": "don" },
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
| `agy.comandos` | Prefixos de comando que um worker do agy pode rodar (testes, lint): o hook responde `auto_approve`. Fora deles, e em qualquer encadeamento (`;`, `&&`, `\|`, `>`, `$(`), o hook nega no worker e pergunta numa sessão interativa sua. |

Há modelos prontos para Node (`don.node.json`), Python (`don.python.json`) e vazio. O
`instalar` escolhe pelo que encontra no projeto, ou use `--tipo`.

## Uso

```bash
don delegar --motor codex --briefing .don/briefings/tela-x.md
don delegar --motor codex --modelo gpt-6.2-astra --briefing .don/briefings/bug-y.md
don delegar --motor agy --modo leitura --briefing .don/briefings/mapa-do-modulo.md
don delegar --motor agy --swarm --minutos 60 --briefing .don/briefings/tres-telas.md
don listar | don limpar <slug> | don relatorio | don checar
```

Opções de `delegar`: `--modo escrita|leitura`, `--modelo` (o motor é deduzido do nome:
`gpt-*` → Codex; `gemini-*`, `claude-*` → agy), `--esforco`, `--slug`, `--base` (padrão
`HEAD`), `--minutos` (30; swarm 60), `--swarm`, `--sem-verificacao`, `--escalar`.

### Escalonamento (`--escalar`)

Começa pelo modelo pedido e, se a tentativa falhar por capacidade (sem resposta, `parcial`,
verificação reprovada, saída diferente de zero), descarta a tentativa e repete no próximo degrau da
escada (`codex.escada` / `agy.escada` no `don.json`; padrão Codex `gpt-6-luna → gpt-6.2-sol →
gpt-6.2-astra`, agy `gemini-3.8-flash-high → claude-sonnet-4-6 → claude-opus-4-6-thinking`). **Nunca
escala** em `REJEITADO` (é segurança) nem em `bloqueado` (é dúvida, não incapacidade). O relatório
mostra o caminho percorrido.

### Revisão cruzada (`don revisar <slug>`)

O **outro fornecedor** revisa o diff da branch do agente antes de você: se o Codex escreveu, o agy
revisa, e vice-versa (ou `--motor`/`--modelo`). Volta um veredito (`aprovar`, `corrigir`,
`rejeitar`) e achados com arquivo, linha, **cenário concreto** e sugestão. Modelos de famílias
diferentes erram coisas diferentes; você lê só o que sobrou. `--foco "<...>"` direciona.

### Rascunho de briefing (`don briefing --pedido "<...>"`)

Um modelo barato explora o repositório (leitura) e rascunha o briefing no formato da skill:
arquivos permitidos, onde olhar (`caminho:linhas`), critérios, comando de verificação, contexto e
dúvidas abertas. Grava em `.don/briefings/<slug>.md` e avisa se listou área reservada como
permitida. Você só revisa e ajusta, em vez de escrever do zero.

## Ler contextos grandes (`don resumir`)

```bash
don resumir docs/ --foco "o que procuro" [--motor agy|codex] [--fatia 40000] [--paralelo 3]
```

1. **Fatia** os arquivos (cortando em títulos markdown), cada linha marcada com o número original.
2. **Mapeia** cada fatia num modelo barato, em paralelo, numa pasta isolada (o leitor não vê o resto
   do projeto). Cada item volta com `arquivo:linhas` e uma **citação literal**.
3. **Confere** cada citação na fonte, perto das linhas indicadas: o que não bate leva ⚠.
4. **Reduz**: o modelo barato agrupa tudo por tema e sem duplicatas (`SINTESE.md`); locais
   inventados na síntese são descartados.

Leia primeiro o `SINTESE.md` (poucos KB). Para conferir algo, vá direto às linhas citadas: é para
isso que a localização existe. O `INDICE.md` tem todos os itens com citação. Fatias já lidas com o
mesmo foco e modelo saem do **cache** (`.don/cache/resumos/`), sem gastar de novo
(`--sem-cache` desliga; `--sem-sintese` pula a redução).

Primeira rodada real (11 arquivos da documentação do Codex, 350 KB): 18 fatias, 260 itens,
**251/260 citações conferidas**, zero fatias perdidas, só cota do Google.

## Documentação local (`don docs`) e MCP

```bash
don docs baixar   --indice https://antigravity.google/llms.txt --pasta docs/Antigravity
don docs baixar   --indice https://learn.chatgpt.com/llms.txt  --pasta docs/Codex-oficial
don docs baixar   --indice https://code.claude.com/llms.txt   --pasta docs/ClaudeCode --filtro "^/docs/en/"
don docs atualizar --pasta docs/Antigravity     # só o que mudou e o que é novo
don docs verificar --pasta docs/Antigravity     # compara com o servidor, não grava nada
don docs baixar --pasta docs/Antigravity --forcar   # baixa tudo de novo
```

Lê o índice `llms.txt` do site, fica com as páginas de `/docs/` do mesmo domínio e baixa a versão
`.md` de cada uma. O manifesto `.fontes.json` guarda URL, `ETag`, `Last-Modified` e hash de cada
página. O `atualizar` faz **requisições condicionais**: página que não mudou volta `304` sem
conteúdo (114 páginas conferidas em 2 s). Relata novas, alteradas, iguais e removidas do índice
(`--remover` apaga as removidas). `--filtro "<regex do caminho>"` restringe as seções e fica gravado
no manifesto (no Git Bash, `^/docs/...` vira `^C:/Program Files/Git/docs/...`; o don desfaz).
Servidores sem `ETag` (como o do Claude Code) respondem 304 pelo `Last-Modified`.

O pacote versiona três referências: `docs/Antigravity` (114 páginas), `docs/Codex-oficial` (202,
inclui o `codex-manual.md` condensado) e `docs/ClaudeCode` (205). Cada pasta tem `FONTES.md` (de onde
veio cada arquivo) e `.fontes.json` (o manifesto da atualização).

**Servidor MCP de documentação**, para o Claude (ou Codex, ou agy) consultar sob demanda em vez de
carregar documentos no contexto:

```bash
claude mcp add consigliere -- node <pacote>/bin/don.mjs mcp-docs --pasta <docs1>,<docs2>
```

Ferramentas: `docs_listar`, `docs_buscar` (palavras na mesma linha ou `/regex/`; devolve
`arquivo:linha` e trecho) e `docs_ler` (linhas numeradas, até 400 por leitura). Só lê dentro das
pastas configuradas. Sem dependências: JSON-RPC sobre stdio. Combine com o `resumir`: a síntese
diz *onde*, o MCP lê *só aquilo*.

## Contra ficar preso

Quatro proteções, cada uma para um tipo de problema, todas configuráveis em `codex`/`agy` no
`don.json`:

| Proteção | Contra | Como | Padrão |
|---|---|---|---|
| Tempo total | qualquer coisa | `--minutos`; encerra a árvore de processos | 30 min (swarm 60) |
| Inatividade | trava silenciosa | log do worker (Codex) ou do hook (agy, uma linha por ferramenta) parado → encerra | `inativo_minutos: 8` |
| Saída de comando (Codex) | log enorme que encarece e confunde o worker | `tool_output_token_limit`: quanto de cada saída entra no contexto | `limite_saida_ferramenta: 6000` |
| Orçamento de tokens (Codex) | loop que gasta sem parar | `features.rollout_budget` com lembretes a 25% e 10% do fim (experimental no Codex) | `limite_tokens: 400000` |
| Limite de passos (agy) | loop de ferramentas | o hook conta as ferramentas; passou do teto, só deixa entregar a resposta | `limite_passos: 150` (swarm ×4) |
| Sentinela de conclusão | processo que terminou mas não sai | `notify` do Codex e evento `Stop` do agy gravam um marcador; vivo 20 s depois → encerra e segue | sempre |

O relatório diz qual proteção agiu (`Soldato interrompido: ...`). Para diagnosticar, rode com
`DON_DEBUG=1`: cada início, saída e interrupção de processo vai para o stderr com horário.

## Custos

`don relatorio` soma, por motor, modelo e modo, as delegações, o tempo, os **tokens
informados por cada fornecedor** (o `usage` do agy e o "tokens used" do Codex) e os desfechos. É
o que permite ajustar a tabela de quem faz o quê com números, não impressão.

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

O don acrescenta sozinho as regras de worker: sem commit, sem dependências, áreas
reservadas, parar na dúvida, resposta em JSON.

### Depois da delegação

1. `REJEITADO`: o worker mexeu em área reservada. Não integre; `don limpar <slug>`.
2. Leia as dúvidas do worker. Elas valem como dúvidas da tarefa.
3. `git diff <base>..soldato/<slug>`. **O aceite é do orquestrador.**
4. `git merge --squash soldato/<slug>`, verificação completa do projeto, commit, `don limpar <slug>`.

## Quem faz o quê

| Trabalho | Quem |
|---|---|
| Entender, dividir, revisar, decidir, integrar | Claude Opus (sessão principal) |
| Tarefa de minutos, ou que depende do contexto da conversa | O próprio Claude ou um subagente Sonnet |
| Achar onde está algo | `consigliere` (Haiku) |
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
   shell. O don usa `-c default_permissions="<perfil>"`.
2. **O pnpm 11 quase apagou o `node_modules` do projeto.** Antes de cada script ele confere as
   dependências; estranhando a junction, tenta apagar a pasta de módulos para reinstalar. Pela
   junction, apagaria a do projeto. Só não apagou por falta de TTY. O don desliga
   `verify-deps-before-run` em todo processo que inicia, roda a verificação pelo Node direto e
   **desfaz as junctions antes de remover qualquer worktree**. Nunca rode `pnpm install` numa
   worktree de agente, e remova só com `don limpar`.
3. **Instalar dependências na worktree travou.** Com o store do pnpm no C: e o projeto no E:,
   não há hardlink e o pnpm copia tudo; ficou 10 minutos parado. Daí as junctions.
4. **O agy em `-p` nega sozinho todo comando que pediria permissão** ("soft-denied") e o worker
   termina **sem resposta final**. No hook, `allow` **não aprova**: só passa a decisão à política
   padrão (docs/hooks). Quem aprova é `auto_approve`. O don devolve `auto_approve` para os
   comandos de `agy.comandos` (sem encadeamento) e, nos workers, `deny` para o resto. Nada de
   `command(*)` nem `--dangerously-skip-permissions`. No Windows, as regras `command(...)` de
   `settings.json` tendem a exigir o comando exato (docs/permissions); por isso o filtro fica no hook.
5. **O envelope JSON do agy repete o esquema pedido** (`json_schema.properties.status`...), o que
   engana um leitor ingênuo. A resposta real vem em `structured_output`.
6. **A verificação do projeto inteiro reprova tudo** quando o projeto já tem dívida de lint.
   Verifique o que mudou (`{arquivos}`, `--changed {base}`).
7. **Segredos no ambiente do Codex.** `shell_environment_policy.ignore_default_excludes` vem
   `true` por padrão e **mantém** variáveis com `KEY`, `SECRET` ou `TOKEN` no ambiente dos comandos
   do worker. O don passa `false`, e também desliga memórias (`memories.generate_memories` e
   `memories.use_memories`) e conectores (`features.apps`) nos workers.
8. **`codex exec -s read-only` no Windows nega até abrir o shell**, e o Codex lê arquivos pelo
   shell: o revisor "não conseguia ler o diff". Leitura agora roda em pasta descartável com o perfil
   do projeto (ou `workspace-write`), e diff e fatias vão dentro do prompt.
9. **Um neto do agy segurava a saída** (um terminal que o worker abriu): o processo terminava, mas
   o pipe não fechava e o don esperava para sempre. Agora ele conclui 2 s depois que o
   processo principal sai e encerra a árvore.
10. **Uma ação negada perto do fim faz o agy terminar sem resposta** (ex.: o modelo barato tentou ler
   `.git/worktrees/...`, fora da área). O preâmbulo proíbe `.git` e manda entregar mesmo depois de
   uma negativa; revisão e briefing tentam de novo uma vez, avisando o worker.
11. **Respostas do agy sobre o próprio agy erram.** Ele disse que `command(node)` liberava por
   prefixo e que existia `"permissions": {"command": [...]}`; a documentação oficial
   (`docs/hooks.md`, `docs/permissions.md`) disse outra coisa. Consulte a fonte (é para isso que existe
   o `don docs`).
12. **A busca do JSON na resposta travava a CPU por minutos.** Ela tentava interpretar a partir de
   cada `{` e recomeçava em todo texto com JSON dentro: com a resposta grande do agy, o tempo
   explodia. Com a CPU presa, nenhum evento era atendido, nem o limite de tempo: as tarefas pareciam
   "paradas" sem processo filho. Agora a busca é linear (texto inteiro, depois linha a linha, varredura
   só como último recurso e com teto), com teste de desempenho.
13. **Junction e `.gitignore`:** `node_modules/` (com barra) só casa diretório, e a junction poderia
   entrar no commit do worker. O don acrescenta `/node_modules` ao `.git/info/exclude`.

## Solução de problemas

| Sintoma | Causa e saída |
|---|---|
| `O soldato não devolveu o JSON esperado` + `no output produced ... headless mode` | Um comando do worker do agy foi negado. Veja `.don/saidas/<slug>/guarda.log`; se ele precisa daquele comando, acrescente o prefixo em `agy.comandos`. |
| `default_permissions requires a [permissions] table` | O Codex não carregou o `.codex/config.toml`: projeto não confiável (passo 3) ou perfil não colado (passo 2). |
| `A base tem outro lockfile` | `--base` aponta para um commit com outras dependências; delegue a partir do `HEAD`. |
| Toda delegação com `verificação FALHOU` | Rode o comando da etapa na worktree (`don listar`) e veja se a falha já existia na base. |
| `Commit recusado: caminho protegido` | Era para recusar. Se a mudança foi liberada, uma pessoa faz `LIBERA_CAMINHO_PROTEGIDO=1 git commit`. |
| Worktree órfã | `don listar` e `don limpar <slug>`. Evite `git worktree remove` direto quando houver junctions. |

## Desinstalar

`git config --unset core.hooksPath`. Depois remova `.githooks/`, `.agents/hooks*`,
`.claude/skills/don/`, `.claude/agents/consigliere.md`, o perfil do `.codex/config.toml`, o
trecho do `AGENTS.md` e as permissões no `.claude/settings.json`. Remova as worktrees abertas com
`don limpar`.

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
bin/don.mjs      CLI
lib/                   delegar (+ revisar, briefing, escalar), worker, worktree, resumir, docs, mcp-docs, instalar, processo, resposta, codex
modelos/               o que o instalar copia para o projeto
test/                  node --test (43 testes: globs, hook, pre-commit, perfil, resposta, confiança, fatias e citações, docs com ETag, MCP, tokens, escalonamento)
```

`npm test` roda tudo, sem dependências.
