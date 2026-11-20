---
name: delegar
description: Delegar trabalho a Codex (OpenAI) ou Antigravity/agy (Gemini) pela orquestra, ou a subagentes Claude mais baratos, para poupar a cota do Opus. Use ao decidir quem executa uma tarefa, uma reescrita mecânica, uma busca, uma segunda opinião ou um swarm.
---

# Delegar

O Opus orquestra: entende o pedido, divide o trabalho, escreve o briefing, revisa o diff e faz o
commit. O resto vai para quem custa menos e serve. As áreas reservadas do projeto
(`.githooks/orquestra.json`) e o que for sensível **não saem do Claude**.

Comando: `{{ORQUESTRA}}` (abaixo, `orquestra`).

## Quem faz o quê

| Trabalho | Quem | Como |
|---|---|---|
| Tarefa de minutos, ou que precisa do contexto desta conversa | você ou um subagente Sonnet | Agent |
| Achar onde está algo, quem usa | `explorador` (Haiku) | Agent |
| Feature bem especificada, telas, testes | Codex `gpt-6.2-sol` | `--motor codex` |
| Bug difícil, refatoração grande, segunda opinião séria | Codex `gpt-6.2-astra` | `--motor codex --modelo gpt-6.2-astra` |
| Ajuste visual a partir de screenshot, correção bem delimitada de UI | Codex `gpt-6.1-terra` | `--motor codex --modelo gpt-6.1-terra` |
| Reescrita mecânica em lote, renomear, textos | Codex `gpt-6-luna` ou agy `gemini-3.8-flash-medium` | `--esforco low` |
| Leitura ampla, resumo de logs ou de muitos arquivos | agy `gemini-3.8-flash-high` | `--motor agy --modo leitura` |
| Revisão de diff fora de área sensível | Codex `gpt-6.2-sol` | `--modo leitura` |
| Várias partes independentes ao mesmo tempo | agy `/swarm` | `--motor agy --swarm` |

O agy também oferece `claude-sonnet-4-6` e `claude-opus-4-6-thinking` na cota do Google.

## Briefing

O worker começa frio: não vê esta conversa. Grave em `.agentes/briefings/<slug>.md` (fora do git):

1. **Objetivo** em uma frase e a referência (issue, requisito, arquivo de spec).
2. **Arquivos** que pode criar ou editar — lista fechada. Dois workers nunca dividem arquivo.
3. **Critérios de aceite** e o que fica **fora**.
4. **Como verificar** (o comando de teste do arquivo).
5. **Contexto mínimo** que ele não acharia sozinho.

A orquestra acrescenta sozinha as regras de worker (sem commit, áreas reservadas, parar na
dúvida, resposta em JSON).

## Rodar

```bash
orquestra delegar --motor codex --briefing .agentes/briefings/<slug>.md
orquestra delegar --motor agy --modo leitura --briefing .agentes/briefings/<slug>.md
orquestra delegar --motor agy --swarm --minutos 60 --briefing .agentes/briefings/<slug>.md
```

Tarefa longa: rode com `run_in_background` e siga trabalhando. A base é o `HEAD`: **faça commit do
que o worker precisa ver antes de delegar.**

- `--escalar`: começa barato e sobe a escada de modelos só se falhar por capacidade (nunca em
  `REJEITADO` ou `bloqueado`). Bom padrão para tarefa mecânica: `--modelo gpt-6-luna --escalar`.
- `orquestra briefing --pedido "<...>" --slug <nome>`: um modelo barato rascunha o briefing
  explorando o repositório. Revise o rascunho em vez de escrever do zero.
- `orquestra revisar <slug>`: o outro fornecedor revisa o diff antes de você (achados com cenário).

## Ler muito, gastar pouco

Antes de ler documentação ou código extensos no seu contexto:

```bash
orquestra resumir <pastas|arquivos> --foco "<o que você procura>"
```

Leia o `SINTESE.md` que ele aponta (temas com `arquivo:linhas`). Para conferir, leia **só** as linhas
citadas. O `INDICE.md` tem cada item com citação literal conferida (⚠ = não conferida). Fatias já
lidas saem do cache.

Documentação de ferramentas fica local (`orquestra docs atualizar --pasta <...>` só baixa o que
mudou). Se o MCP `orquestra-docs` estiver configurado, use `docs_buscar` → `docs_ler` em vez de abrir
arquivos inteiros.

## Depois

O relatório traz status, resumo e dúvidas do worker, diffstat e a verificação do
`orquestra.json` rodada na worktree (em geral só sobre o que mudou). Então:

1. `REJEITADO`: o worker mexeu em área reservada. Não integre; leia o motivo e `orquestra limpar`.
2. Dúvidas do worker valem como dúvidas da tarefa.
3. Revise o diff (`git diff <base>..agente/<slug>`). Você é o revisor; não terceirize o aceite.
4. `git merge --squash agente/<slug>`, rode a verificação completa do projeto, faça commit com
   mensagem sua e `orquestra limpar <slug>`.

## Cuidados

- As dependências da worktree (`links` no `orquestra.json`, ex.: `node_modules`) são **junctions**
  para as do projeto. Nunca instale dependências numa worktree de agente e só remova com
  `orquestra limpar`, que desfaz as junctions antes.
- Modelo barato tenta escrever onde não deve mesmo instruído a não tentar. A barreira final é a
  checagem do diff (`REJEITADO`).
- Não delegue nada que use dados reais, segredos ou rede (o worker não tem rede).
- Tarefa em que explicar custa mais que fazer: faça você.

## Swarm (agy)

Gasta muita cota. Só para trabalho de verdade paralelo e sem arquivos em comum: 2 a 4 workers, uma
área por worker, divisão explícita no briefing (`@nome: arquivos e tarefa`). Verifier, monitor e
narrator só existem se você pedir. A verificação final é a sua.

O registro de cada delegação fica em `.agentes/registro.jsonl`; `orquestra relatorio` resume, com
os tokens que cada fornecedor informa.
