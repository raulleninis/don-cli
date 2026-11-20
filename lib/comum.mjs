// Partes comuns ao don (delegar) e ao consigliere (revisar, briefing): preâmbulo do soldato,
// registro de custo, leitura com worker em worktree destacada e dedução do motor pelo modelo.
import fs from 'node:fs';
import path from 'node:path';
import { executarWorker } from './worker.mjs';
import { criarWorktree, removerWorktree } from './worktree.mjs';

export const carimbo = () => new Date().toISOString().slice(0, 19).replace(/[-:T]/g, '').slice(0, 14);
export const limparSlug = (s) => String(s).replace(/[^w-]+/g, '-');

export function preambulo(projeto, modo, formato) {
  const reservados = projeto.caminhos.RESERVADOS.map(([, , glob]) => glob).join(', ');
  return [
    `Você é um soldato (worker delegado) do don, o orquestrador (Claude), no projeto ${projeto.nome}.`,
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

export function registrar(projeto, dados) {
  fs.mkdirSync(projeto.pastaDon, { recursive: true });
  fs.appendFileSync(path.join(projeto.pastaDon, 'registro.jsonl'), `${JSON.stringify({ quando: new Date().toISOString(), ...dados })}\n`);
}


export async function lerComWorker(projeto, { motor, modelo, esforco, ref, slug, prompt, esquema: arq, predicado, preparar, minutos = 20 }) {
  const saidas = path.join(projeto.pastaDon, 'saidas', slug);
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

export function motorDoRegistro(projeto, slug) {
  const arquivo = path.join(projeto.pastaDon, 'registro.jsonl');
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

