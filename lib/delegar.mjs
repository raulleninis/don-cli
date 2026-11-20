// Delega uma tarefa a um agente externo (Codex ou agy) numa worktree descartável e devolve ao
// orquestrador só um relatório curto. O transcript completo fica em .agentes/saidas/<slug>/.
import console from 'node:console';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { COMO_CONFIAR, codexConfiaNoProjeto } from './codex.mjs';
import { envDoWorker, git, rodar } from './processo.mjs';
import { extrairJson } from './resposta.mjs';

const ESQUEMA = fileURLToPath(new URL('./esquema-resposta.json', import.meta.url));
const PADRAO = {
  codex: { modelo: 'gpt-6.2-sol', esforco: 'high', perfil: null },
  agy: { modelo: 'gemini-3.8-flash-high', esforco: null },
};
const LOCKS = ['pnpm-lock.yaml', 'package-lock.json', 'yarn.lock', 'bun.lockb', 'uv.lock', 'poetry.lock', 'Cargo.lock'];

function preambulo(projeto, modo) {
  const reservados = projeto.caminhos.RESERVADOS.map(([, , glob]) => glob).join(', ');
  return [
    `Você é um worker delegado pelo orquestrador (Claude) do projeto ${projeto.nome}.`,
    '- Leia e siga AGENTS.md (se existir). Esta pasta é uma worktree descartável só sua.',
    modo === 'leitura'
      ? '- Tarefa somente de leitura: não edite nenhum arquivo.'
      : '- Não faça commit, push nem instale ou remova dependências; o orquestrador cuida disso.',
    `- Nunca edite: ${reservados}. Se a tarefa exigir, pare e devolva status "bloqueado" com a dúvida.`,
    '- Requisito ambíguo ou em conflito: pare e devolva status "bloqueado" com a dúvida. Não chute.',
    ...(projeto.config.preambulo ?? []).map((l) => `- ${l}`),
    '- Sua resposta final é só o JSON do esquema pedido: status, resumo (até 10 linhas), arquivos, testes, duvidas.',
    '',
    '--- BRIEFING ---',
    '',
  ].join('\n');
}

/** Desfaz as junctions antes de qualquer remoção, para nunca apagar as dependências do projeto. */
function soltarLinks(projeto, wt) {
  for (const nome of projeto.config.links ?? []) {
    const alvo = path.join(wt, nome);
    try {
      if (fs.lstatSync(alvo).isSymbolicLink()) fs.unlinkSync(alvo);
    } catch {
      /* não existe */
    }
  }
}

function prenderLinks(projeto, wt, base) {
  const links = (projeto.config.links ?? []).filter((nome) => fs.existsSync(path.join(projeto.raiz, nome)));
  if (!links.length) return;
  const mudou = git(projeto.raiz, 'diff', '--name-only', base, 'HEAD', '--', ...LOCKS);
  if (mudou) throw new Error(`A base tem outro lockfile (${mudou}); delegue a partir do HEAD.`);
  const exclude = path.resolve(projeto.raiz, git(projeto.raiz, 'rev-parse', '--git-common-dir'), 'info', 'exclude');
  const atual = fs.existsSync(exclude) ? fs.readFileSync(exclude, 'utf8') : '';
  for (const nome of links) {
    fs.symlinkSync(path.join(projeto.raiz, nome), path.join(wt, nome), 'junction');
    // `pasta/` no .gitignore só casa diretório; a junction precisa do exclude local.
    const linha = `/${nome.replace(/\\/g, '/')}`;
    if (!atual.split(/\r?\n/).includes(linha)) fs.appendFileSync(exclude, `\n${linha}\n`);
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

export async function delegar(projeto, o) {
  if (!['codex', 'agy'].includes(o.motor)) throw new Error('--motor codex|agy é obrigatório.');
  if (!o.briefing || !fs.existsSync(o.briefing)) throw new Error('--briefing <arquivo.md> é obrigatório e precisa existir.');
  if (!['escrita', 'leitura'].includes(o.modo)) throw new Error('--modo escrita|leitura.');
  if (o.swarm && (o.motor !== 'agy' || o.modo !== 'escrita')) throw new Error('--swarm só vale para agy em modo escrita.');

  const conf = { ...PADRAO[o.motor], ...(projeto.config[o.motor] ?? {}) };
  if (o.motor === 'codex' && o.modo === 'escrita' && conf.perfil && !codexConfiaNoProjeto(projeto.raiz)) {
    throw new Error(`O Codex não confia neste projeto, então o perfil "${conf.perfil}" não carregaria.\n${COMO_CONFIAR(projeto.raiz)}`);
  }
  const modelo = o.modelo ?? conf.modelo;
  const esforco = o.esforco ?? conf.esforco;
  const carimbo = new Date().toISOString().slice(0, 16).replace(/[-:T]/g, '');
  const slug = `${(o.slug ?? path.basename(o.briefing, path.extname(o.briefing))).replace(/[^\w-]+/g, '-')}-${carimbo}`;
  const saidas = path.join(projeto.pastaAgentes, 'saidas', slug);
  const log = path.join(saidas, 'execucao.log');
  const ultima = path.join(saidas, 'resposta.txt');
  fs.mkdirSync(saidas, { recursive: true });
  fs.mkdirSync(projeto.pastaWorktrees, { recursive: true });

  const base = git(projeto.raiz, 'rev-parse', o.base ?? 'HEAD');
  const wt = path.join(projeto.pastaWorktrees, slug);
  const branch = `agente/${slug}`;
  if (o.modo === 'escrita') git(projeto.raiz, 'worktree', 'add', '-q', '-b', branch, wt, base);
  else git(projeto.raiz, 'worktree', 'add', '-q', '--detach', wt, base);
  if (o.modo === 'escrita') {
    try {
      prenderLinks(projeto, wt, base);
    } catch (erro) {
      soltarLinks(projeto, wt);
      git(projeto.raiz, 'worktree', 'remove', '--force', wt);
      git(projeto.raiz, 'branch', '-D', branch);
      throw erro;
    }
  }

  const inicio = Date.now();
  const avisos = [];
  const prompt = preambulo(projeto, o.modo) + fs.readFileSync(o.briefing, 'utf8');
  fs.writeFileSync(path.join(saidas, 'briefing.md'), prompt);
  const minutos = Number(o.minutos ?? (o.swarm ? 60 : 30));
  let execucao;
  if (o.motor === 'codex') {
    // Escrita usa o perfil de permissões do projeto (.codex/config.toml). `-s workspace-write`
    // explícito passa por cima do perfil e deixa o shell escrever em área reservada.
    let sandbox;
    if (o.modo === 'leitura') sandbox = ['-s', 'read-only'];
    else if (conf.perfil) sandbox = ['-c', `default_permissions="${conf.perfil}"`];
    else {
      sandbox = ['-s', 'workspace-write'];
      avisos.push('Codex sem perfil de permissões: só a checagem final do diff protege as áreas reservadas.');
    }
    const args = ['exec', '-C', wt, ...sandbox, '-m', modelo, '--output-schema', ESQUEMA, '-o', ultima, '--color', 'never'];
    if (esforco) args.push('-c', `model_reasoning_effort=${esforco}`);
    args.push('-');
    execucao = await rodar('codex', args, { cwd: wt, entrada: prompt, log, minutos });
  } else {
    const args = ['-p', (o.swarm ? '/swarm ' : '') + prompt, '--model', modelo, '--output-format', 'json',
      '--json-schema', ESQUEMA, '--mode', o.modo === 'leitura' ? 'plan' : 'accept-edits', '--sandbox'];
    // Sem terminal, comando que pede permissão é negado sozinho e o worker termina sem resposta.
    // As regras do agy em -p só casam o comando exato ou `*` (testado em 20/11/2026): libera `*` e
    // quem filtra é o hook .agents/hooks/guarda.mjs, que com ORQUESTRA_WORKER=1 nega tudo fora de
    // `agy.comandos`. Os comandos continuam no --sandbox do agy e na worktree.
    if ((conf.comandos ?? []).length && o.modo === 'escrita') {
      args.push('--settings', JSON.stringify({ permissions: { allow: ['command(*)'] } }));
    }
    if (esforco) args.push('--effort', esforco);
    execucao = await rodar('agy', args, { cwd: wt, log, minutos, env: envDoWorker(path.join(saidas, 'guarda.log')) });
    fs.writeFileSync(ultima, execucao.texto);
  }
  const textoFinal = fs.existsSync(ultima) ? fs.readFileSync(ultima, 'utf8') : execucao.texto;
  const resposta = extrairJson(textoFinal);

  let arquivos = [];
  let rejeitados = [];
  let verificacao = [];
  let estado;
  if (o.modo === 'escrita') {
    git(wt, 'add', '-A');
    // Contra a base, para pegar também commits que o worker tenha feito por conta própria.
    arquivos = git(wt, 'diff', '--cached', '--name-only', '--no-renames', base).split('\n').filter(Boolean);
    rejeitados = arquivos.map((a) => [a, projeto.caminhos.motivo(a, projeto.caminhos.RESERVADOS)]).filter(([, m]) => m);
    if (rejeitados.length) {
      estado = 'REJEITADO: o worker mexeu em área reservada. Não integre esta branch; inspecione e descarte.';
    } else if (arquivos.length) {
      if (!o['sem-verificacao']) verificacao = await verificar(projeto, wt, base, arquivos, log);
      git(wt, 'commit', '-q', '-m', `agente(${o.motor}): ${slug}\n\nVerificação: ${verificacao.join(', ') || 'não rodada'}`);
      estado = 'commitado na branch do agente (nada foi integrado à sua branch).';
    } else {
      estado = 'nenhum arquivo alterado.';
    }
  }

  const segundos = Math.round((Date.now() - inicio) / 1000);
  fs.appendFileSync(
    path.join(projeto.pastaAgentes, 'registro.jsonl'),
    `${JSON.stringify({
      quando: new Date().toISOString(), slug, motor: o.motor, modelo, esforco, modo: o.modo, swarm: !!o.swarm,
      segundos, saida: execucao.codigo, status: resposta?.status ?? 'sem-json',
      arquivos: arquivos.length, rejeitados: rejeitados.length, verificacao,
    })}\n`,
  );

  const linhas = [
    `Delegação ${slug} · ${o.motor}/${modelo}${esforco ? ` (${esforco})` : ''} · ${o.modo}${o.swarm ? ' · swarm' : ''} · ${segundos}s · saída ${execucao.codigo}`,
    ...avisos.map((a) => `Aviso: ${a}`),
  ];
  if (resposta) {
    linhas.push(`Status do worker: ${resposta.status}`, `Resumo: ${resposta.resumo}`);
    if (resposta.testes) linhas.push(`Testes (segundo o worker): ${resposta.testes}`);
    if (resposta.duvidas?.length) linhas.push('Dúvidas:', ...resposta.duvidas.map((d) => `  - ${d}`));
  } else {
    linhas.push('O worker não devolveu o JSON esperado. Últimas linhas:', ...textoFinal.trim().split('\n').slice(-12));
  }
  if (o.modo === 'escrita') {
    linhas.push(`Resultado: ${estado}`);
    for (const [a, m] of rejeitados) linhas.push(`  ${a}: ${m}`);
    if (verificacao.length) linhas.push(`Verificação: ${verificacao.join(' · ')}`);
    if (arquivos.length && !rejeitados.length) {
      linhas.push(git(projeto.raiz, 'diff', '--stat=100', `${base}..${branch}`).split('\n').slice(-25).join('\n'));
      linhas.push(`Revisar:   git diff ${base.slice(0, 9)}..${branch}`);
      linhas.push(`Integrar:  git merge --squash ${branch}`);
    }
    linhas.push(`Descartar: orquestra limpar ${slug}`);
  } else {
    soltarLinks(projeto, wt);
    git(projeto.raiz, 'worktree', 'remove', '--force', wt);
  }
  linhas.push(`Log completo: ${path.relative(projeto.raiz, saidas)}`);
  console.log(linhas.join('\n'));
}

export function limpar(projeto, slug) {
  const wt = path.join(projeto.pastaWorktrees, slug);
  if (fs.existsSync(wt)) {
    soltarLinks(projeto, wt);
    git(projeto.raiz, 'worktree', 'remove', '--force', wt);
  }
  try {
    git(projeto.raiz, 'branch', '-D', `agente/${slug}`);
  } catch {
    /* branch já não existe */
  }
  console.log(`Removidos a worktree e a branch agente/${slug}. O log em .agentes/saidas/${slug} fica.`);
}

export function listar(projeto) {
  const pasta = projeto.pastaWorktrees.replace(/\\/g, '/').toLowerCase();
  const linhas = git(projeto.raiz, 'worktree', 'list')
    .split('\n')
    .filter((l) => l.replace(/\\/g, '/').toLowerCase().includes(pasta));
  console.log(linhas.length ? linhas.join('\n') : 'Nenhuma worktree de agente aberta.');
}

export function relatorio(projeto) {
  const arquivo = path.join(projeto.pastaAgentes, 'registro.jsonl');
  if (!fs.existsSync(arquivo)) return console.log('Nenhuma delegação registrada ainda.');
  const grupos = new Map();
  for (const linha of fs.readFileSync(arquivo, 'utf8').trim().split('\n')) {
    const r = JSON.parse(linha);
    const chave = `${r.motor}/${r.modelo}${r.swarm ? ' (swarm)' : ''}`;
    const g = grupos.get(chave) ?? { n: 0, segundos: 0, concluido: 0, bloqueado: 0, semJson: 0, rejeitado: 0, falhou: 0 };
    g.n += 1;
    g.segundos += r.segundos;
    if (r.status === 'concluido') g.concluido += 1;
    if (r.status === 'bloqueado') g.bloqueado += 1;
    if (r.status === 'sem-json') g.semJson += 1;
    if (r.rejeitados) g.rejeitado += 1;
    if (r.verificacao?.some((v) => v.includes('FALHOU'))) g.falhou += 1;
    grupos.set(chave, g);
  }
  console.log('motor/modelo | vezes | média s | concluído | bloqueado | sem JSON | rejeitado | verificação falhou');
  for (const [chave, g] of grupos) {
    console.log(`${chave} | ${g.n} | ${Math.round(g.segundos / g.n)} | ${g.concluido} | ${g.bloqueado} | ${g.semJson} | ${g.rejeitado} | ${g.falhou}`);
  }
}
