#!/usr/bin/env node
// orquestra — Claude orquestra, Codex e Antigravity (agy) executam em worktrees descartáveis.
import console from 'node:console';
import process from 'node:process';
import { delegar, limpar, listar, relatorio } from '../lib/delegar.mjs';
import { checar, COMANDO, instalar, perfilCodex } from '../lib/instalar.mjs';
import { carregarProjeto } from '../lib/projeto.mjs';

const AJUDA = `orquestra — delegação de tarefas do Claude para Codex e agy

Uso (rode de dentro do projeto):
  orquestra delegar --motor codex|agy --briefing <arquivo.md> [opções]
      --modo escrita|leitura   escrita (padrão) cria branch agente/<slug>; leitura não edita
      --modelo <id>            padrão do .githooks/orquestra.json
      --esforco <nível>        Codex: model_reasoning_effort · agy: --effort
      --slug <nome>            nome da delegação (padrão: nome do briefing)
      --base <commit>          padrão HEAD
      --minutos <n>            limite de tempo (30; swarm 60)
      --swarm                  só agy, só escrita
      --sem-verificacao        pula a verificação do orquestra.json
  orquestra listar             worktrees de agente abertas
  orquestra limpar <slug>      remove worktree e branch (desfaz as junctions antes)
  orquestra relatorio          resumo de .agentes/registro.jsonl
  orquestra instalar [dir] [--tipo node|python|vazio] [--forcar]
  orquestra perfil-codex [--nome <perfil>]   imprime o perfil de permissões do Codex
  orquestra checar             confere a instalação no projeto

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
    case 'listar':
      listar(await carregarProjeto());
      break;
    case 'limpar':
      if (!o._[0]) throw new Error('Informe o slug: orquestra limpar <slug>');
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
  console.error(`orquestra: ${erro.message}`);
  process.exitCode = 1;
}
