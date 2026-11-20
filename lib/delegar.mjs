// Delegação a agentes externos (Codex ou agy) em worktrees descartáveis, com relatório curto ao
// orquestrador. Também: escalonamento de modelo, revisão cruzada e rascunho de briefing.
import console from 'node:console';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { COMO_CONFIAR, codexConfiaNoProjeto } from './codex.mjs';
import { git, rodar } from './processo.mjs';
import { configDoMotor, executarWorker } from './worker.mjs';
import { criarWorktree, removerWorktree } from './worktree.mjs';

const esquema = (nome) => fileURLToPath(new URL(`./esquema-${nome}.json`, import.meta.url));
const ESQUEMA_RESPOSTA = esquema('resposta');
const ESQUEMA_REVISAO = esquema('revisao');
const ESQUEMA_BRIEFING = esquema('briefing');
const ehResposta = (v) => typeof v.status === 'string' && typeof v.resumo === 'string';
const ehRevisao = (v) => typeof v.veredito === 'string' && Array.isArray(v.achados);
const ehBriefing = (v) => typeof v.objetivo === 'string' && Array.isArray(v.arquivos_permitidos);

const carimbo = () => new Date().toISOString().slice(0, 19).replace(/[-:T]/g, '').slice(0, 14);
const limparSlug = (s) => String(s).replace(/[^\w-]+/g, '-');

function preambulo(projeto, modo, formato) {
  const reservados = projeto.caminhos.RESERVADOS.map(([, , glob]) => glob).join(', ');
  return [
    `Você é um worker delegado pelo orquestrador (Claude) do projeto ${projeto.nome}.`,
    '- Leia e siga AGENTS.md (se existir). Esta pasta é uma worktree descartável só sua.',
    modo === 'leitura'
      ? '- Tarefa somente de leitura: não edite nenhum arquivo.'
      : '- Não faça commit, push nem instale ou remova dependências; o orquestrador cuida disso.',
    `- Nunca edite: ${reservados}. Se a tarefa exigir, pare e devolva status "bloqueado" com a dúvida.`,
    '- Requisito ambíguo ou em conflito: pare e devolva a dúvida. Não chute.',
    '- Não leia nem liste `.git` nem nada fora desta pasta. Se uma ação for negada, não insista nem contorne:',
    '  siga com o que tem e entregue a resposta final mesmo assim, registrando a limitação.',
    ...(projeto.config.preambulo ?? []).map((l) => `- ${l}`),
    `- Sua resposta final é só o JSON do esquema pedido: ${formato}.`,
    '',
    '--- TAREFA ---',
    '',
  ].join('\n');
}

function registrar(projeto, dados) {
  fs.mkdirSync(projeto.pastaAgentes, { recursive: true });
  fs.appendFileSync(path.join(projeto.pastaAgentes, 'registro.jsonl'), `${JSON.stringify({ quando: new Date().toISOString(), ...dados })}\n`);
}

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

/** Uma tentativa de delegação. Devolve o resultado; não imprime. */
async function tentar(projeto, o, modelo, slug) {
  const saidas = path.join(projeto.pastaAgentes, 'saidas', slug);
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
      git(wt, 'commit', '-q', '-m', `agente(${o.motor}): ${slug}\n\nVerificação: ${r.verificacao.join(', ') || 'não rodada'}`);
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
    linhas.push(`Status do worker: ${r.resposta.status}`, `Resumo: ${r.resposta.resumo}`);
    if (r.resposta.testes) linhas.push(`Testes (segundo o worker): ${r.resposta.testes}`);
    if (r.resposta.duvidas?.length) linhas.push('Dúvidas:', ...r.resposta.duvidas.map((d) => `  - ${d}`));
  } else {
    linhas.push('O worker não devolveu o JSON esperado. Últimas linhas:', ...r.texto.trim().split('\n').slice(-12));
  }
  if (o.modo === 'escrita') {
    linhas.push(`Resultado: ${r.estado}`);
    for (const [a, m] of r.rejeitados) linhas.push(`  ${a}: ${m}`);
    if (r.verificacao.length) linhas.push(`Verificação: ${r.verificacao.join(' · ')}`);
    if (r.arquivos.length && !r.rejeitados.length) {
      linhas.push(git(projeto.raiz, 'diff', '--stat=100', `${r.base}..${r.branch}`).split('\n').slice(-25).join('\n'));
      linhas.push(`Revisar:   git diff ${r.base.slice(0, 9)}..${r.branch}   (ou: orquestra revisar ${r.slug})`);
      linhas.push(`Integrar:  git merge --squash ${r.branch}`);
    }
    linhas.push(`Descartar: orquestra limpar ${r.slug}`);
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
    const r = await tentar(projeto, { ...o, tentativa: t + 1 }, modelos[t], slug);
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
async function lerComWorker(projeto, { motor, modelo, esforco, ref, slug, prompt, esquema: arq, predicado, preparar, minutos = 20 }) {
  const saidas = path.join(projeto.pastaAgentes, 'saidas', slug);
  fs.mkdirSync(saidas, { recursive: true });
  const { wt } = criarWorktree(projeto, slug, ref, { escrita: false });
  const inicio = Date.now();
  try {
    if (preparar) preparar(wt);
    const executar = (p) => executarWorker({ projeto, motor, modelo, esforco, modo: 'leitura', prompt: p, esquema: arq, predicado, wt, saidas, minutos });
    let w = await executar(prompt);
    let tentativas = 1;
    if (!w.resposta) {
      // Uma ação negada perto do fim faz o agy terminar sem resposta: uma nova tentativa, avisada.
      const tokensAntes = w.tokens ?? 0;
      w = await executar(`${prompt}\n\nATENÇÃO: numa tentativa anterior você não entregou a resposta final. Entregue o JSON do esquema mesmo com informação parcial.`);
      w.tokens = (w.tokens ?? 0) + tokensAntes;
      tentativas = 2;
    }
    return { ...w, tentativas, saidas, segundos: Math.round((Date.now() - inicio) / 1000) };
  } finally {
    removerWorktree(projeto, wt);
  }
}

function motorDoRegistro(projeto, slug) {
  const arquivo = path.join(projeto.pastaAgentes, 'registro.jsonl');
  if (!fs.existsSync(arquivo)) return null;
  const linhas = fs.readFileSync(arquivo, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  // Só delegações de escrita contam como "autor" (revisões e briefings registram o mesmo slug).
  return linhas.reverse().find((r) => r.slug === slug && !['revisao', 'briefing', 'resumir'].includes(r.modo))?.motor ?? null;
}

/** gpt-* é Codex; gemini-*, claude-* e gpt-oss-* rodam no agy. */
export function motorDoModelo(modelo) {
  if (!modelo) return null;
  if (/^gpt-oss/i.test(modelo) || /^(gemini|claude)/i.test(modelo)) return 'agy';
  if (/^(gpt|o\d|codex)/i.test(modelo)) return 'codex';
  return null;
}

/** Revisão cruzada: o outro fornecedor revisa o diff da branch do agente, antes do orquestrador. */
export async function revisar(projeto, slug, o) {
  const branch = `agente/${slug}`;
  try {
    git(projeto.raiz, 'rev-parse', '--verify', branch);
  } catch {
    throw new Error(`Não existe a branch ${branch}.`);
  }
  const base = git(projeto.raiz, 'merge-base', 'HEAD', branch);
  const diff = git(projeto.raiz, 'diff', `${base}..${branch}`);
  if (!diff) return console.log('Diff vazio: nada a revisar.');
  const autor = motorDoRegistro(projeto, slug);
  const motor = o.motor ?? motorDoModelo(o.modelo) ?? (autor === 'codex' ? 'agy' : 'codex');
  const conf = configDoMotor(projeto, motor);
  const modelo = o.modelo ?? conf.modelo;
  const prompt =
    preambulo(projeto, 'leitura', 'veredito, resumo, achados (gravidade, arquivo, linha, problema, cenario, sugestao)') +
    [
      'Revise o diff abaixo (também salvo em `.orquestra-revisao.diff`): é a mudança que outro agente propôs.',
      'Leia os arquivos do projeto que precisar para o contexto. Procure defeitos reais: erro de lógica, caso não',
      'tratado, quebra de contrato, teste que não testa, regressão, problema de segurança, violação do AGENTS.md.',
      'Cada achado precisa de um cenário concreto (entrada → comportamento errado); sem cenário, não é achado.',
      'Não comente estilo. Veredito: aprovar (sem achado alto), corrigir (achados a resolver) ou rejeitar.',
      ...(o.foco ? ['', `Foco pedido pelo orquestrador: ${o.foco}`] : []),
      '',
      // Diff embutido (cortado em 150 mil caracteres): o revisor não depende do shell para lê-lo.
      '--- DIFF ---',
      diff.length > 150_000 ? `${diff.slice(0, 150_000)}\n[... diff cortado; o resto está em .orquestra-revisao.diff]` : diff,
    ].join('\n');
  const r = await lerComWorker(projeto, {
    motor, modelo, esforco: o.esforco ?? (motor === 'codex' ? 'high' : null), ref: branch, slug: `${slug}-revisao-${carimbo()}`,
    prompt, esquema: ESQUEMA_REVISAO, predicado: ehRevisao, preparar: (wt) => fs.writeFileSync(path.join(wt, '.orquestra-revisao.diff'), diff),
  });
  registrar(projeto, { slug, motor, modelo, modo: 'revisao', segundos: r.segundos, saida: r.codigo, tokens: r.tokens,
    status: r.resposta?.veredito ?? 'sem-json', achados: r.resposta?.achados?.length ?? 0 });
  const linhas = [`Revisão de ${slug} por ${motor}/${modelo}${autor ? ` (autor: ${autor})` : ''} · ${r.segundos}s${r.tokens ? ` · ${r.tokens} tokens` : ''}`];
  if (!r.resposta) linhas.push('O revisor não devolveu o JSON esperado. Últimas linhas:', ...r.texto.trim().split('\n').slice(-10));
  else {
    linhas.push(`Veredito: ${r.resposta.veredito.toUpperCase()} · ${r.resposta.resumo}`);
    const ordem = { alta: 0, media: 1, baixa: 2 };
    for (const a of [...r.resposta.achados].sort((x, y) => ordem[x.gravidade] - ordem[y.gravidade])) {
      linhas.push(`- [${a.gravidade}] ${a.arquivo}:${a.linha} ${a.problema}`, `    cenário: ${a.cenario}`, `    sugestão: ${a.sugestao}`);
    }
  }
  linhas.push(`Log: ${path.relative(projeto.raiz, r.saidas)}`);
  console.log(linhas.join('\n'));
}

/** Um modelo barato explora o repositório e rascunha o briefing; o orquestrador só ajusta. */
export async function rascunharBriefing(projeto, o) {
  const pedido = o.pedido ?? (o['pedido-arquivo'] && fs.readFileSync(o['pedido-arquivo'], 'utf8'));
  if (!pedido) throw new Error('Uso: orquestra briefing --pedido "<o que precisa ser feito>" [--slug nome] [--motor agy|codex]');
  const motor = o.motor ?? motorDoModelo(o.modelo) ?? 'agy';
  const conf = configDoMotor(projeto, motor);
  const modelo = o.modelo ?? conf.modelo;
  const slug = limparSlug(o.slug ?? 'briefing');
  const prompt =
    preambulo(projeto, 'leitura', 'titulo, objetivo, referencias, arquivos_permitidos, arquivos_contexto, criterios, fora_do_escopo, verificar, contexto, duvidas') +
    [
      'Você prepara o briefing que outro agente vai executar sem ver esta conversa. Explore o repositório',
      '(AGENTS.md, docs, código, testes) para entender o pedido abaixo. Não implemente nada.',
      '- arquivos_permitidos: lista fechada do que a execução pode criar ou editar (nunca áreas reservadas).',
      '- arquivos_contexto: onde o executor deve olhar, no formato caminho:linha-inicial-final, com 1 frase do porquê.',
      '- criterios: aceite verificável. verificar: o comando de teste mais estreito que prova o aceite.',
      '- referencias: requisitos, issues ou docs com caminho:linha. contexto: o que ele não acharia sozinho.',
      '- duvidas: o que o pedido não decide e alguém precisa decidir antes. Não invente respostas.',
      '',
      `Pedido: ${pedido}`,
    ].join('\n');
  const r = await lerComWorker(projeto, { motor, modelo, esforco: o.esforco, ref: 'HEAD', slug: `${slug}-briefing-${carimbo()}`, prompt, esquema: ESQUEMA_BRIEFING, predicado: ehBriefing });
  registrar(projeto, { slug, motor, modelo, modo: 'briefing', segundos: r.segundos, saida: r.codigo, tokens: r.tokens, status: r.resposta ? 'concluido' : 'sem-json' });
  if (!r.resposta) {
    console.log(['O worker não devolveu o briefing. Últimas linhas:', ...r.texto.trim().split('\n').slice(-10), `Log: ${path.relative(projeto.raiz, r.saidas)}`].join('\n'));
    return;
  }
  const b = r.resposta;
  const lista = (itens) => (itens.length ? itens.map((i) => `- ${i}`).join('\n') : '- (nenhum)');
  const md = [
    `# ${b.titulo}`,
    '',
    `> Rascunho gerado por ${motor}/${modelo} a partir do pedido. Revise antes de delegar.`,
    '',
    `**Objetivo:** ${b.objetivo}`,
    '',
    '## Referências', lista(b.referencias), '',
    '## Arquivos permitidos', lista(b.arquivos_permitidos), '',
    '## Onde olhar', lista(b.arquivos_contexto), '',
    '## Critérios de aceite', lista(b.criterios), '',
    '## Fora do escopo', lista(b.fora_do_escopo), '',
    '## Verificar', `\`${b.verificar}\``, '',
    '## Contexto', b.contexto, '',
    '## Dúvidas abertas', lista(b.duvidas), '',
  ].join('\n');
  const destino = o.saida ?? path.join(projeto.pastaAgentes, 'briefings', `${slug}.md`);
  fs.mkdirSync(path.dirname(destino), { recursive: true });
  fs.writeFileSync(destino, md);
  const reservados = b.arquivos_permitidos.filter((a) => projeto.caminhos.motivo(a, projeto.caminhos.RESERVADOS));
  console.log([
    `Briefing rascunhado por ${motor}/${modelo} em ${r.segundos}s${r.tokens ? ` (${r.tokens} tokens)` : ''}: ${path.relative(projeto.raiz, destino)}`,
    `${b.arquivos_permitidos.length} arquivo(s) permitido(s), ${b.criterios.length} critério(s), ${b.duvidas.length} dúvida(s).`,
    ...(reservados.length ? [`ATENÇÃO: o rascunho lista área reservada como permitida: ${reservados.join(', ')}`] : []),
    ...(b.duvidas.length ? ['Dúvidas:', ...b.duvidas.map((d) => `  - ${d}`)] : []),
  ].join('\n'));
}

export function limpar(projeto, slug) {
  removerWorktree(projeto, path.join(projeto.pastaWorktrees, slug), `agente/${slug}`);
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
