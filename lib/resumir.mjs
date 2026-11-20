// Resume contextos grandes com modelos baratos, em fatias e em paralelo, e devolve ao orquestrador
// um índice com a localização (arquivo:linhas) de cada informação, para ele ir direto à fonte.
// Cada item traz uma citação literal curta, conferida na fonte: item com citação que não bate é
// marcado, porque modelo barato inventa.
import console from 'node:console';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { envDoWorker, git, rodar } from './processo.mjs';
import { acharPor } from './resposta.mjs';
import { CODEX_ISOLADO, codexWindows, contarTokens } from './worker.mjs';

const ESQUEMA = fileURLToPath(new URL('./esquema-resumo.json', import.meta.url));
const ESQUEMA_SINTESE = fileURLToPath(new URL('./esquema-sintese.json', import.meta.url));
const EXTENSOES = /\.(?:md|mdx|txt|rst|adoc|html?|json|ya?ml|toml|js|mjs|cjs|ts|tsx|jsx|py|go|rs|java|cs|sql|sh|ps1|csv|log)$/i;

function raizOuCwd() {
  try {
    return path.resolve(git(process.cwd(), 'rev-parse', '--show-toplevel'));
  } catch {
    return process.cwd();
  }
}

function listarArquivos(alvos) {
  const saida = [];
  const visitar = (p) => {
    const info = fs.statSync(p);
    if (info.isDirectory()) {
      for (const nome of fs.readdirSync(p).sort()) {
        if (!['.git', 'node_modules', '.agentes'].includes(nome)) visitar(path.join(p, nome));
      }
    } else if (EXTENSOES.test(p)) saida.push(path.resolve(p));
  };
  for (const alvo of alvos) visitar(alvo);
  return saida;
}

/** Divide um arquivo em fatias de até `limite` caracteres, cortando em títulos markdown. */
export function fatiar(texto, limite) {
  const linhas = texto.split(/\r?\n/);
  const secoes = [];
  let inicio = 0;
  for (let i = 1; i <= linhas.length; i++) {
    if (i === linhas.length || /^#{1,3}\s/.test(linhas[i])) {
      secoes.push([inicio, i]);
      inicio = i;
    }
  }
  const tamanho = (a, b) => linhas.slice(a, b).reduce((t, l) => t + l.length + 8, 0);
  const pedacos = [];
  for (const [a, b] of secoes) {
    if (tamanho(a, b) <= limite) {
      pedacos.push([a, b]);
      continue;
    }
    // Seção maior que o limite: corta por linhas.
    let ini = a;
    let soma = 0;
    for (let i = a; i < b; i++) {
      soma += linhas[i].length + 8;
      if (soma > limite && i > ini) {
        pedacos.push([ini, i]);
        ini = i;
        soma = linhas[i].length + 8;
      }
    }
    pedacos.push([ini, b]);
  }
  const fatias = [];
  for (const [a, b] of pedacos) {
    const ultima = fatias.at(-1);
    if (ultima && tamanho(ultima[0], b) <= limite) ultima[1] = b;
    else fatias.push([a, b]);
  }
  return fatias.map(([a, b]) => ({ de: a + 1, ate: b, linhas: linhas.slice(a, b) }));
}

const normalizar = (s) => String(s).toLowerCase().replace(/[`*_>"“”'’]/g, '').replace(/\s+/g, ' ').trim();

/** Confere se a citação está na fonte, perto das linhas indicadas (folga de 5 linhas). */
export function conferirCitacao(linhasDaFonte, intervalo, trecho) {
  const m = /(\d+)\s*(?:[-–]\s*(\d+))?/.exec(String(intervalo));
  if (!m || !normalizar(trecho)) return false;
  const de = Math.max(1, Number(m[1]) - 5);
  const ate = Math.min(linhasDaFonte.length, Number(m[2] ?? m[1]) + 5);
  return normalizar(linhasDaFonte.slice(de - 1, ate).join(' ')).includes(normalizar(trecho));
}

function prompt(foco, arquivoFatia) {
  return [
    'Você lê um trecho de documentação para um orquestrador que vai decidir o que aproveitar.',
    `Foco: ${foco}`,
    '',
    `Leia o arquivo ${arquivoFatia} inteiro, e só ele. Cada linha começa com o número da linha na fonte`,
    'original, seguido de "| ". Não rode comandos, não edite nada, não leia outros arquivos.',
    '',
    'Devolva só o JSON do esquema:',
    '- panorama: 1 a 3 frases sobre o que o trecho cobre.',
    '- itens: uma entrada por informação útil para o foco (ignore o resto). Para cada uma:',
    '  titulo curto; resumo factual em 1 a 3 frases, sem inventar nada que não esteja no trecho;',
    '  relevancia para o foco (alta, media, baixa); linhas na fonte no formato "A-B";',
    '  trecho: citação LITERAL de 5 a 20 palavras copiada do texto (sem o número da linha), que prove o item.',
  ].join('\n');
}

/**
 * Roda um leitor com a pasta de trabalho isolada. agy lê o arquivo pela ferramenta de leitura;
 * Codex recebe o conteúdo no próprio prompt (stdin): no Windows, `-s read-only` nega até o shell.
 */
async function rodarLeitor({ motor, modelo, esforco, pasta, texto, nomeArquivo, conteudo, esquema, predicado, log, saida, minutos }) {
  let r;
  if (motor === 'agy') {
    r = await rodar('agy', ['-p', texto, '--model', modelo, '--output-format', 'json', '--json-schema', esquema,
      '--mode', 'plan', '--sandbox'], { cwd: pasta, log, minutos, env: envDoWorker() });
    fs.writeFileSync(saida, r.texto);
  } else {
    const comConteudo = `${texto}\n\nConteúdo de ${nomeArquivo} (já está aqui; não precisa abrir o arquivo):\n\n${conteudo}`;
    r = await rodar('codex', ['exec', '-C', pasta, '--skip-git-repo-check', '-s', 'workspace-write', ...CODEX_ISOLADO, ...codexWindows(null), '-m', modelo,
      '-c', `model_reasoning_effort=${esforco ?? 'low'}`, '--output-schema', esquema, '-o', saida, '--color', 'never', '-'],
    { cwd: pasta, entrada: comConteudo, log, minutos });
  }
  const bruto = fs.existsSync(saida) ? fs.readFileSync(saida, 'utf8') : r.texto;
  return { resposta: acharPor(bruto, predicado), tokens: contarTokens(motor, r.texto, log) };
}

/**
 * Redução: agrupa os itens de todas as fatias por tema, sem duplicatas, para o orquestrador ler
 * primeiro um documento curto. Locais citados são conferidos contra os itens reais.
 */
async function sintetizar({ motor, modelo, esforco, pasta, foco, itens, minutos }) {
  const locais = new Set(itens.map((i) => `${i.rel}:${i.linhas}`));
  const lista = itens
    .map((i, n) => `[${n + 1}] (${i.relevancia}${i.ok ? '' : ', citação não conferida'}) ${i.titulo} — ${i.rel}:${i.linhas} — ${String(i.resumo).slice(0, 240)}`)
    .join('\n');
  const nomeArquivo = 'itens-para-sintese.md';
  fs.writeFileSync(path.join(pasta, nomeArquivo), `${lista}\n`);
  const texto = [
    'Você recebe itens extraídos de vários trechos de documentação (um por linha: relevância, título, local, resumo).',
    `Foco do orquestrador: ${foco}`,
    '',
    `Leia ${nomeArquivo} inteiro, e só ele. Não rode comandos nem edite nada. Agrupe os itens em temas (no máximo 25),`,
    'juntando duplicatas e informações repetidas entre arquivos. Para cada tema: tema (curto), resumo (2 a 5 frases,',
    'só com o que está nos itens, com nomes de chaves e flags), relevancia (alta, media, baixa) e locais: os locais',
    'copiados EXATAMENTE como aparecem nos itens (formato arquivo:linhas), do mais útil ao menos útil.',
    'lacunas: o que o foco pede e os itens não cobrem.',
  ].join('\n');
  const r = await rodarLeitor({
    motor, modelo, esforco, pasta, texto, nomeArquivo, conteudo: lista, esquema: ESQUEMA_SINTESE,
    predicado: (v) => Array.isArray(v.temas) && Array.isArray(v.lacunas),
    log: path.join(pasta, 'sintese.log'), saida: path.join(pasta, 'sintese.json'), minutos,
  });
  if (!r.resposta) return { tokens: r.tokens };
  let descartados = 0;
  const temas = r.resposta.temas.map((t) => {
    const validos = t.locais.filter((l) => locais.has(l));
    descartados += t.locais.length - validos.length;
    return { ...t, locais: validos };
  });
  return { temas, lacunas: r.resposta.lacunas, descartados, tokens: r.tokens };
}

async function emParalelo(tarefas, limite) {
  const resultados = new Array(tarefas.length);
  let proxima = 0;
  const trabalhador = async () => {
    while (proxima < tarefas.length) {
      const i = proxima++;
      resultados[i] = await tarefas[i]();
    }
  };
  await Promise.all(Array.from({ length: Math.min(limite, tarefas.length) }, trabalhador));
  return resultados;
}

export async function resumir(alvos, o) {
  if (!alvos.length) throw new Error('Informe arquivos ou pastas: orquestra resumir <caminhos...> --foco "<pergunta>"');
  if (!o.foco) throw new Error('--foco "<o que você procura>" é obrigatório: é ele que separa o útil do resto.');
  const motor = o.motor ?? 'agy';
  if (!['agy', 'codex'].includes(motor)) throw new Error('--motor agy|codex.');
  const modelo = o.modelo ?? (motor === 'agy' ? 'gemini-3.8-flash-high' : 'gpt-6-luna');
  const limite = Number(o.fatia ?? 40000);
  const paralelo = Number(o.paralelo ?? 3);

  const raiz = raizOuCwd();
  const carimbo = new Date().toISOString().slice(0, 16).replace(/[-:T]/g, '');
  const slug = `${(o.slug ?? 'resumo').replace(/[^\w-]+/g, '-')}-${carimbo}`;
  const pasta = path.join(raiz, '.agentes', 'resumos', slug);
  fs.mkdirSync(pasta, { recursive: true });

  const fontes = new Map();
  const fatias = [];
  for (const arquivo of listarArquivos(alvos)) {
    const rel = path.relative(raiz, arquivo).replace(/\\/g, '/');
    const texto = fs.readFileSync(arquivo, 'utf8');
    fontes.set(rel, texto.split(/\r?\n/));
    for (const f of fatiar(texto, limite)) {
      const nome = `fatia-${String(fatias.length + 1).padStart(3, '0')}.md`;
      const corpo = f.linhas.map((l, i) => `${f.de + i}| ${l}`).join('\n');
      fs.writeFileSync(path.join(pasta, nome), `Fonte: ${rel} (linhas ${f.de}-${f.ate})\n\n${corpo}\n`);
      fatias.push({ nome, rel, de: f.de, ate: f.ate });
    }
  }
  if (!fatias.length) throw new Error('Nenhum arquivo de texto encontrado.');

  const inicio = Date.now();
  // Cada worker roda com a pasta das fatias como área de trabalho: não vê o resto do projeto.
  // Cache por conteúdo: mesma fatia, mesmo foco, mesmo modelo → reaproveita (não gasta de novo).
  const pastaCache = path.join(raiz, '.agentes', 'cache', 'resumos');
  fs.mkdirSync(pastaCache, { recursive: true });
  let doCache = 0;
  let tokens = 0;
  const tarefas = fatias.map((f) => async () => {
    const log = path.join(pasta, `${f.nome}.log`);
    const saida = path.join(pasta, `${f.nome}.json`);
    const texto = prompt(o.foco, f.nome);
    const conteudo = fs.readFileSync(path.join(pasta, f.nome), 'utf8');
    const chave = createHash('sha256').update(`${motor}\n${modelo}\n${o.foco}\n${conteudo}`).digest('hex').slice(0, 24);
    const cache = path.join(pastaCache, `${chave}.json`);
    if (!o['sem-cache'] && fs.existsSync(cache)) {
      doCache += 1;
      return { ...f, resposta: JSON.parse(fs.readFileSync(cache, 'utf8')) };
    }
    const r = await rodarLeitor({ motor, modelo, esforco: o.esforco, pasta, texto, nomeArquivo: f.nome, conteudo,
      esquema: ESQUEMA, predicado: (v) => Array.isArray(v.itens) && typeof v.panorama === 'string', log, saida, minutos: Number(o.minutos ?? 10) });
    tokens += r.tokens ?? 0;
    if (r.resposta) fs.writeFileSync(cache, JSON.stringify(r.resposta));
    return { ...f, resposta: r.resposta };
  });
  const resultados = await emParalelo(tarefas, paralelo);
  const segundos = Math.round((Date.now() - inicio) / 1000);

  const itens = [];
  for (const r of resultados) {
    for (const item of r.resposta?.itens ?? []) {
      const ok = conferirCitacao(fontes.get(r.rel), item.linhas, item.trecho);
      itens.push({ ...item, rel: r.rel, ok });
    }
  }
  const ordem = { alta: 0, media: 1, baixa: 2 };
  itens.sort((a, b) => ordem[a.relevancia] - ordem[b.relevancia] || a.rel.localeCompare(b.rel));
  const conferidos = itens.filter((i) => i.ok).length;
  const falhas = resultados.filter((r) => !r.resposta);

  const md = [
    `# Resumo: ${o.foco}`,
    '',
    `${fontes.size} arquivo(s), ${fatias.length} fatia(s) (${doCache} do cache) · ${motor}/${modelo} · ${segundos}s · ${tokens || '?'} tokens · ` +
      `citações conferidas na fonte: ${conferidos}/${itens.length}. ⚠ = citação não encontrada nas linhas indicadas: confira antes de confiar.`,
    '',
  ];
  for (const nivel of ['alta', 'media', 'baixa']) {
    const doNivel = itens.filter((i) => i.relevancia === nivel);
    if (!doNivel.length) continue;
    md.push(`## Relevância ${nivel === 'media' ? 'média' : nivel}`, '');
    for (const i of doNivel) {
      const local = `\`${i.rel}:${i.linhas}\``;
      if (nivel === 'baixa') md.push(`- ${i.ok ? '' : '⚠ '}**${i.titulo}** ${local}`);
      else md.push(`- ${i.ok ? '' : '⚠ '}**${i.titulo}** ${local}: ${i.resumo}`, `  > ${i.trecho}`);
    }
    md.push('');
  }
  md.push('## Panorama por fatia', '');
  for (const r of resultados) md.push(`- \`${r.rel}:${r.de}-${r.ate}\`: ${r.resposta?.panorama ?? '(sem resposta: ver log)'}`);
  if (falhas.length) md.push('', `## Fatias sem resposta (${falhas.length})`, '', ...falhas.map((f) => `- ${f.nome} (${f.rel}:${f.de}-${f.ate}): ver ${f.nome}.log`));
  const indice = path.join(pasta, 'INDICE.md');
  fs.writeFileSync(indice, `${md.join('\n')}\n`);

  let sintese = null;
  let arquivoSintese = null;
  if (!o['sem-sintese'] && itens.length) {
    sintese = await sintetizar({ motor, modelo, esforco: o.esforco, pasta, foco: o.foco, itens, minutos: Number(o.minutos ?? 10) });
    tokens += sintese.tokens ?? 0;
    if (sintese.temas) {
      const ordemTema = { alta: 0, media: 1, baixa: 2 };
      const s = [
        `# Síntese: ${o.foco}`,
        '',
        `${sintese.temas.length} temas a partir de ${itens.length} itens (${motor}/${modelo}). Locais conferidos contra o índice` +
          `${sintese.descartados ? `; ${sintese.descartados} local(is) inventado(s) descartado(s)` : ''}. Detalhe e citações: INDICE.md.`,
        '',
      ];
      for (const t of [...sintese.temas].sort((a, b) => ordemTema[a.relevancia] - ordemTema[b.relevancia])) {
        s.push(`## ${t.tema} (${t.relevancia === 'media' ? 'média' : t.relevancia})`, '', t.resumo, '', `Onde: ${t.locais.map((l) => `\`${l}\``).join(', ') || '(nenhum local conferido)'}`, '');
      }
      if (sintese.lacunas.length) s.push('## Lacunas', '', ...sintese.lacunas.map((l) => `- ${l}`), '');
      arquivoSintese = path.join(pasta, 'SINTESE.md');
      fs.writeFileSync(arquivoSintese, s.join('\n'));
    }
  }

  fs.appendFileSync(
    path.join(raiz, '.agentes', 'registro.jsonl'),
    `${JSON.stringify({ quando: new Date().toISOString(), slug, motor, modelo, modo: 'resumir', segundos, fatias: fatias.length,
      itens: itens.length, conferidos, falhas: falhas.length, tokens, doCache, status: falhas.length ? 'parcial' : 'concluido' })}\n`,
  );

  const altas = itens.filter((i) => i.relevancia === 'alta');
  console.log([
    `Resumo ${slug} · ${motor}/${modelo} · ${fatias.length} fatias (${doCache} do cache) · ${segundos}s · ${tokens || '?'} tokens`,
    `Itens: ${itens.length} (alta ${altas.length}) · citações conferidas: ${conferidos}/${itens.length} · fatias sem resposta: ${falhas.length}`,
    ...(arquivoSintese
      ? [`Síntese (leia primeiro): ${path.relative(raiz, arquivoSintese)} · ${sintese.temas.length} temas`]
      : sintese ? ['Síntese: o modelo não devolveu (ver sintese.log); use o índice.'] : []),
    `Índice completo: ${path.relative(raiz, indice)}`,
  ].join('\n'));
}
