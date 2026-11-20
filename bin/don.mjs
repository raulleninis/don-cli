#!/usr/bin/env node
// don — Claude don, Codex e Antigravity (agy) executam em worktrees descartáveis.
import console from 'node:console';
import process from 'node:process';
import { delegar, limpar, listar, relatorio } from '../lib/delegar.mjs';
import { rascunharBriefing } from '../lib/consigliere/briefing.mjs';
import { revisar } from '../lib/consigliere/revisar.mjs';
import { servirDocs } from '../lib/consigliere/mcp.mjs';
import { checar, COMANDO, instalar, perfilCodex } from '../lib/instalar.mjs';
import { sincronizarDocs } from '../lib/consigliere/docs.mjs';
import { carregarProjeto } from '../lib/projeto.mjs';
import { resumir } from '../lib/consigliere/resumir.mjs';

const AJUDA = `don — delegação de tarefas do Claude para Codex e agy

Uso (rode de dentro do projeto):
  don delegar --motor codex|agy --briefing <arquivo.md> [opções]
      --modo escrita|leitura   escrita (padrão) cria branch soldato/<slug>; leitura não edita
      --modelo <id>            padrão do .githooks/don.json
      --esforco <nível>        Codex: model_reasoning_effort · agy: --effort
      --slug <nome>            nome da delegação (padrão: nome do briefing)
      --base <commit>          padrão HEAD
      --minutos <n>            limite de tempo (30; swarm 60)
      --swarm                  só agy, só escrita
      --sem-verificacao        pula a verificação do don.json
      --escalar                se falhar por capacidade, repete no próximo modelo da escada
  don revisar <slug> [--motor|--modelo] [--foco "<...>"]
      o outro fornecedor revisa o diff da branch soldato/<slug> (veredito + achados com cenário)
  don briefing --pedido "<...>" [--slug nome] [--motor|--modelo]
      modelo barato explora o repositório e rascunha .don/briefings/<slug>.md
  don resumir <arquivos|pastas...> --foco "<o que procura>" [opções]
      --motor agy|codex        agy (padrão, gemini-3.8-flash-high) ou codex (gpt-6-luna)
      --fatia <caracteres>     tamanho máximo da fatia (40000), cortada em títulos markdown
      --paralelo <n>           fatias ao mesmo tempo (3)
      --sem-cache | --sem-sintese
      Gera SINTESE.md (temas, leia primeiro) e INDICE.md (itens com arquivo:linhas e citação conferida).
  don docs baixar|atualizar|verificar --pasta <destino> [--indice <url llms.txt>] [--filtro <regex>]
      [--forcar] [--remover]   documentação local; atualizar/verificar usam ETag (304 = não mudou)
  don mcp-docs --pasta <p1>,<p2>   servidor MCP (stdio) com docs_listar, docs_buscar, docs_ler
  don listar             worktrees de soldati abertas
  don limpar <slug>      remove worktree e branch (desfaz as junctions antes)
  don relatorio          resumo de .don/registro.jsonl
  don instalar [dir] [--tipo node|python|vazio] [--forcar]
  don perfil-codex [--nome <perfil>]   imprime o perfil de permissões do Codex
  don checar             confere a instalação no projeto

Comando completo: ${COMANDO}`;

function opcoes(argv) {
  const o = { modo: 'escrita', _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) o._.push(a);
    else if (['swarm', 'sem-verificacao', 'forcar', 'ajuda'].includes(a.slice(2))) o[a.slice(2)] = true;
    else o[a.slice(2)] = argv[++i];
  }
  return o;
}

const [acao, ...resto] = process.argv.slice(2);
const o = opcoes(resto);
try {
  switch (acao) {
    case 'delegar':
      await delegar(await carregarProjeto(), o);
      break;
    case 'resumir':
      await resumir(o._, o);
      break;
    case 'docs':
      if (!['baixar', 'atualizar', 'verificar'].includes(o._[0])) {
        throw new Error('Uso: don docs baixar|atualizar|verificar --pasta <destino> [--indice <url do llms.txt>] [--filtro <regex do caminho>] [--forcar] [--remover]');
      }
      await sincronizarDocs({ acao: o._[0], indice: o.indice, pasta: o.pasta, paralelo: Number(o.paralelo ?? 4), forcar: !!o.forcar, remover: !!o.remover, filtro: o.filtro });
      break;
    case 'revisar':
      if (!o._[0]) throw new Error('Uso: don revisar <slug> [--motor agy|codex] [--foco "<...>"]');
      await revisar(await carregarProjeto(), o._[0], o);
      break;
    case 'briefing':
      await rascunharBriefing(await carregarProjeto(), o);
      break;
    case 'mcp-docs':
      await servirDocs(o.pasta ? String(o.pasta).split(',') : []);
      break;
    case 'listar':
      listar(await carregarProjeto());
      break;
    case 'limpar':
      if (!o._[0]) throw new Error('Informe o slug: don limpar <slug>');
      limpar(await carregarProjeto(), o._[0]);
      break;
    case 'relatorio':
      relatorio(await carregarProjeto());
      break;
    case 'instalar':
      instalar(o._[0] ?? process.cwd(), { forcar: !!o.forcar, tipo: o.tipo });
      break;
    case 'perfil-codex':
      perfilCodex(await carregarProjeto(), o.nome);
      break;
    case 'checar':
      process.exitCode = (await checar(await carregarProjeto())) ? 0 : 1;
      break;
    default:
      console.log(AJUDA);
      if (acao && acao !== 'ajuda' && acao !== '--ajuda') process.exitCode = 1;
  }
} catch (erro) {
  console.error(`don: ${erro.message}`);
  process.exitCode = 1;
}
