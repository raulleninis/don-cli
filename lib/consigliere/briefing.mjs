// Consigliere: um modelo barato explora o repositório e rascunha o briefing; o don só ajusta.
import console from 'node:console';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { carimbo, lerComWorker, limparSlug, motorDoModelo, preambulo, registrar } from '../comum.mjs';
import { configDoMotor } from '../worker.mjs';

const ESQUEMA_BRIEFING = fileURLToPath(new URL('./esquema-briefing.json', import.meta.url));
const ehBriefing = (v) => typeof v.objetivo === 'string' && Array.isArray(v.arquivos_permitidos);

export async function rascunharBriefing(projeto, o) {
  const pedido = o.pedido ?? (o['pedido-arquivo'] && fs.readFileSync(o['pedido-arquivo'], 'utf8'));
  if (!pedido) throw new Error('Uso: don briefing --pedido "<o que precisa ser feito>" [--slug nome] [--motor agy|codex]');
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
    console.log(['O soldato não devolveu o briefing. Últimas linhas:', ...r.texto.trim().split('\n').slice(-10), `Log: ${path.relative(projeto.raiz, r.saidas)}`].join('\n'));
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
  const destino = o.saida ?? path.join(projeto.pastaDon, 'briefings', `${slug}.md`);
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

