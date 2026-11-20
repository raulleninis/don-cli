// Consigliere: revisão cruzada. O outro fornecedor revisa o diff do soldato antes do don.
import console from 'node:console';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { carimbo, lerComWorker, motorDoModelo, motorDoRegistro, preambulo, registrar } from '../comum.mjs';
import { git } from '../processo.mjs';
import { configDoMotor } from '../worker.mjs';

const ESQUEMA_REVISAO = fileURLToPath(new URL('./esquema-revisao.json', import.meta.url));
const ehRevisao = (v) => typeof v.veredito === 'string' && Array.isArray(v.achados);

export async function revisar(projeto, slug, o) {
  const branch = `soldato/${slug}`;
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
      'Revise o diff abaixo (também salvo em `.don-revisao.diff`): é a mudança que outro agente propôs.',
      'Leia os arquivos do projeto que precisar para o contexto. Procure defeitos reais: erro de lógica, caso não',
      'tratado, quebra de contrato, teste que não testa, regressão, problema de segurança, violação do AGENTS.md.',
      'Cada achado precisa de um cenário concreto (entrada → comportamento errado); sem cenário, não é achado.',
      'Não comente estilo. Veredito: aprovar (sem achado alto), corrigir (achados a resolver) ou rejeitar.',
      ...(o.foco ? ['', `Foco pedido pelo orquestrador: ${o.foco}`] : []),
      '',
      // Diff embutido (cortado em 150 mil caracteres): o revisor não depende do shell para lê-lo.
      '--- DIFF ---',
      diff.length > 150_000 ? `${diff.slice(0, 150_000)}\n[... diff cortado; o resto está em .don-revisao.diff]` : diff,
    ].join('\n');
  const r = await lerComWorker(projeto, {
    motor, modelo, esforco: o.esforco ?? (motor === 'codex' ? 'high' : null), ref: branch, slug: `${slug}-revisao-${carimbo()}`,
    prompt, esquema: ESQUEMA_REVISAO, predicado: ehRevisao, preparar: (wt) => fs.writeFileSync(path.join(wt, '.don-revisao.diff'), diff),
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

