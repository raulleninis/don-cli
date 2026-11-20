// Delegação a agentes externos (Codex ou agy) em worktrees descartáveis, com relatório curto ao
// orquestrador (o don). Também: escalonamento de modelo. Revisão e briefing ficam no consigliere.
import console from 'node:console';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { COMO_CONFIAR, codexConfiaNoProjeto } from './codex.mjs';
import { git, rodar } from './processo.mjs';
import { configDoMotor, executarWorker } from './worker.mjs';
import { criarWorktree, removerWorktree } from './worktree.mjs';
import { situacaoLealdade } from './lealdade.mjs';
import { carimbo, limparSlug, motorDoModelo, preambulo, registrar } from './comum.mjs';

export { motorDoModelo } from './comum.mjs';

const esquema = (nome) => fileURLToPath(new URL(`./esquema-${nome}.json`, import.meta.url));
const ESQUEMA_RESPOSTA = esquema('resposta');
const ehResposta = (v) => typeof v.status === 'string' && typeof v.resumo === 'string';


function exigirConfianca(projeto, motor, modo) {
  const conf = configDoMotor(projeto, motor);
  if (motor === 'codex' && modo === 'escrita' && conf.perfil && !codexConfiaNoProjeto(projeto.raiz)) {
    throw new Error(`O Codex não confia neste projeto, então o perfil "${conf.perfil}" não carregaria.\n${COMO_CONFIAR(projeto.raiz)}`);
  }
}

async function verificar(projeto, wt, base, arquivos, log) {
  const resultado = [];
  for (const etapa of projeto.config.verificacao ?? []) {
    const alvos = etapa.extensoes
      ? arquivos.filter((a) => etapa.extensoes.some((e) => a.endsWith(e)) && fs.existsSync(path.join(wt, a)))
      : arquivos;
    if (etapa.comando.includes('{arquivos}') && !alvos.length) continue;
    const [cmd, ...resto] = etapa.comando;
    const args = resto.flatMap((a) => (a === '{arquivos}' ? alvos : [a.replaceAll('{base}', base)]));
    const r = await rodar(cmd, args, { cwd: wt, log, minutos: etapa.minutos ?? 15 });
    resultado.push(`${etapa.nome} ${r.codigo === 0 ? 'ok' : 'FALHOU'}`);
  }
  return resultado;
}

/** Uma ordem (uma tentativa de delegação). Devolve o resultado sem imprimir; usada também pelo lealdade. */
export async function executarOrdem(projeto, o, modelo, slug) {
  const saidas = path.join(projeto.pastaDon, 'saidas', slug);
  fs.mkdirSync(saidas, { recursive: true });
  const base = git(projeto.raiz, 'rev-parse', o.base ?? 'HEAD');
  const { wt, branch } = criarWorktree(projeto, slug, base, { escrita: o.modo === 'escrita' });
  const inicio = Date.now();
  const conf = configDoMotor(projeto, o.motor);
  const esforco = o.esforco ?? conf.esforco;
  const prompt = preambulo(projeto, o.modo, 'status, resumo (até 10 linhas), arquivos, testes, duvidas') + fs.readFileSync(o.briefing, 'utf8');
  const w = await executarWorker({
    projeto, motor: o.motor, modelo, esforco, modo: o.modo, swarm: o.swarm, prompt,
    esquema: ESQUEMA_RESPOSTA, predicado: ehResposta, wt, saidas, minutos: Number(o.minutos ?? (o.swarm ? 60 : 30)),
  });

  const r = { slug, base, branch, wt, saidas, modelo, esforco, ...w, arquivos: [], rejeitados: [], verificacao: [], estado: '' };
  if (o.modo === 'escrita') {
    git(wt, 'add', '-A');
    // Contra a base, para pegar também commits que o worker tenha feito por conta própria.
    r.arquivos = git(wt, 'diff', '--cached', '--name-only', '--no-renames', base).split('\n').filter(Boolean);
    r.rejeitados = r.arquivos.map((a) => [a, projeto.caminhos.motivo(a, projeto.caminhos.RESERVADOS)]).filter(([, m]) => m);
    if (r.rejeitados.length) {
      r.estado = 'REJEITADO: o worker mexeu em área reservada. Não integre esta branch; inspecione e descarte.';
    } else if (r.arquivos.length) {
      if (!o['sem-verificacao']) r.verificacao = await verificar(projeto, wt, base, r.arquivos, path.join(saidas, 'execucao.log'));
      git(wt, 'commit', '-q', '-m', `soldato(${o.motor}): ${slug}\n\nVerificação: ${r.verificacao.join(', ') || 'não rodada'}`);
      r.estado = 'commitado na branch do agente (nada foi integrado à sua branch).';
    } else r.estado = 'nenhum arquivo alterado.';
  } else {
    removerWorktree(projeto, wt);
  }
  r.segundos = Math.round((Date.now() - inicio) / 1000);
  registrar(projeto, {
    slug, motor: o.motor, modelo, esforco, modo: o.modo, swarm: !!o.swarm, segundos: r.segundos, saida: r.codigo,
    status: r.resposta?.status ?? 'sem-json', tokens: r.tokens, arquivos: r.arquivos.length, rejeitados: r.rejeitados.length,
    verificacao: r.verificacao, tentativa: o.tentativa ?? 1,
  });
  return r;
}

/** Vale escalar? Não em REJEITADO (segurança) nem em "bloqueado" (é dúvida, não incapacidade). */
export function motivoParaEscalar(r) {
  if (r.rejeitados.length || r.resposta?.status === 'bloqueado') return null;
  if (r.codigo !== 0) return `saída ${r.codigo}`;
  if (!r.resposta) return 'sem resposta estruturada';
  if (r.resposta.status === 'parcial') return 'worker devolveu parcial';
  if (r.verificacao.some((v) => v.includes('FALHOU'))) return `verificação: ${r.verificacao.join(', ')}`;
  return null;
}

function relatorioDaTentativa(projeto, o, r) {
  const linhas = [
    `Delegação ${r.slug} · ${o.motor}/${r.modelo}${r.esforco ? ` (${r.esforco})` : ''} · ${o.modo}${o.swarm ? ' · swarm' : ''} · ` +
      `${r.segundos}s · ${r.tokens ? `${r.tokens} tokens · ` : ''}saída ${r.codigo}`,
    ...r.avisos.map((a) => `Aviso: ${a}`),
  ];
  if (r.resposta) {
    linhas.push(`Status do soldato: ${r.resposta.status}`, `Resumo: ${r.resposta.resumo}`);
    if (r.resposta.testes) linhas.push(`Testes (segundo o worker): ${r.resposta.testes}`);
    if (r.resposta.duvidas?.length) linhas.push('Dúvidas:', ...r.resposta.duvidas.map((d) => `  - ${d}`));
  } else {
    linhas.push('O soldato não devolveu o JSON esperado. Últimas linhas:', ...r.texto.trim().split('\n').slice(-12));
  }
  if (o.modo === 'escrita') {
    linhas.push(`Resultado: ${r.estado}`);
    for (const [a, m] of r.rejeitados) linhas.push(`  ${a}: ${m}`);
    if (r.verificacao.length) linhas.push(`Verificação: ${r.verificacao.join(' · ')}`);
    if (r.arquivos.length && !r.rejeitados.length) {
      linhas.push(git(projeto.raiz, 'diff', '--stat=100', `${r.base}..${r.branch}`).split('\n').slice(-25).join('\n'));
      linhas.push(`Revisar:   git diff ${r.base.slice(0, 9)}..${r.branch}   (ou: don revisar ${r.slug})`);
      linhas.push(`Integrar:  git merge --squash ${r.branch}`);
    }
    linhas.push(`Descartar: don limpar ${r.slug}`);
  }
  linhas.push(`Log completo: ${path.relative(projeto.raiz, r.saidas)}`);
  return linhas.join('\n');
}

export async function delegar(projeto, o) {
  o.motor = o.motor ?? motorDoModelo(o.modelo);
  if (!['codex', 'agy'].includes(o.motor)) throw new Error('--motor codex|agy é obrigatório (ou um --modelo que indique o motor).');
  if (!o.briefing || !fs.existsSync(o.briefing)) throw new Error('--briefing <arquivo.md> é obrigatório e precisa existir.');
  if (!['escrita', 'leitura'].includes(o.modo)) throw new Error('--modo escrita|leitura.');
  if (o.swarm && (o.motor !== 'agy' || o.modo !== 'escrita')) throw new Error('--swarm só vale para agy em modo escrita.');
  exigirConfianca(projeto, o.motor, o.modo);
  // Lealdade (don.json "lealdade": aviso | exigir | ignorar): as travas foram sondadas nesta versão?
  const politica = projeto.config.lealdade ?? 'aviso';
  if (o.modo === 'escrita' && politica !== 'ignorar') {
    const s = await situacaoLealdade(o.motor);
    if (!s.ok && politica === 'exigir') throw new Error(`Este projeto exige sondagem aprovada: ${s.motivo}.`);
    if (!s.ok) console.log(`Aviso de lealdade: ${s.motivo}.`);
  }

  const conf = configDoMotor(projeto, o.motor);
  const inicial = o.modelo ?? conf.modelo;
  let modelos = [inicial];
  if (o.escalar) {
    const i = conf.escada.indexOf(inicial);
    modelos = i >= 0 ? conf.escada.slice(i) : [inicial, ...conf.escada];
  }
  const raizSlug = `${limparSlug(o.slug ?? path.basename(o.briefing, path.extname(o.briefing)))}-${carimbo()}`;
  const historico = [];
  for (let t = 0; t < modelos.length; t++) {
    const slug = t === 0 ? raizSlug : `${raizSlug}-t${t + 1}`;
    const r = await executarOrdem(projeto, { ...o, tentativa: t + 1 }, modelos[t], slug);
    const motivo = motivoParaEscalar(r);
    if (!motivo || t === modelos.length - 1 || !o.escalar) {
      if (historico.length) console.log(['Escalonamento:', ...historico].join('\n'));
      console.log(relatorioDaTentativa(projeto, o, r));
      return;
    }
    historico.push(`  ${modelos[t]}: ${motivo} → tentando ${modelos[t + 1]} (tentativa descartada; log em ${path.relative(projeto.raiz, r.saidas)})`);
    if (o.modo === 'escrita') removerWorktree(projeto, r.wt, r.branch);
  }
}

/** Roda um worker em modo leitura numa worktree destacada e a remove no fim. */
export function limpar(projeto, slug) {
  removerWorktree(projeto, path.join(projeto.pastaWorktrees, slug), `soldato/${slug}`);
  console.log(`Removidos a worktree e a branch soldato/${slug}. O log em .don/saidas/${slug} fica.`);
}

export function listar(projeto) {
  const pasta = projeto.pastaWorktrees.replace(/\\/g, '/').toLowerCase();
  const linhas = git(projeto.raiz, 'worktree', 'list')
    .split('\n')
    .filter((l) => l.replace(/\\/g, '/').toLowerCase().includes(pasta));
  console.log(linhas.length ? linhas.join('\n') : 'Nenhuma worktree de agente aberta.');
}

export function relatorio(projeto) {
  const arquivo = path.join(projeto.pastaDon, 'registro.jsonl');
  if (!fs.existsSync(arquivo)) return console.log('Nenhuma delegação registrada ainda.');
  const grupos = new Map();
  for (const linha of fs.readFileSync(arquivo, 'utf8').trim().split('\n')) {
    const r = JSON.parse(linha);
    const chave = `${r.motor}/${r.modelo} · ${r.modo ?? 'escrita'}${r.swarm ? ' (swarm)' : ''}`;
    const g = grupos.get(chave) ?? { n: 0, segundos: 0, tokens: 0, ok: 0, bloqueado: 0, semJson: 0, rejeitado: 0, falhou: 0 };
    g.n += 1;
    g.segundos += r.segundos ?? 0;
    g.tokens += r.tokens ?? 0;
    if (['concluido', 'aprovar', 'corrigir', 'rejeitar'].includes(r.status)) g.ok += 1;
    if (r.status === 'bloqueado') g.bloqueado += 1;
    if (r.status === 'sem-json') g.semJson += 1;
    if (r.rejeitados) g.rejeitado += 1;
    if (r.verificacao?.some?.((v) => v.includes('FALHOU'))) g.falhou += 1;
    grupos.set(chave, g);
  }
  console.log('motor/modelo · modo | vezes | média s | tokens (total) | concluído | bloqueado | sem JSON | rejeitado | verificação falhou');
  for (const [chave, g] of grupos) {
    console.log(`${chave} | ${g.n} | ${Math.round(g.segundos / g.n)} | ${g.tokens || '-'} | ${g.ok} | ${g.bloqueado} | ${g.semJson} | ${g.rejeitado} | ${g.falhou}`);
  }
  console.log('Tokens são os que cada fornecedor informa (Google/OpenAI), não os do orquestrador.');
}
