// Referência local da documentação pública de uma ferramenta (índice llms.txt + páginas .md).
//   baixar     primeira vez; com --forcar baixa tudo de novo, ignorando o cache
//   atualizar  só o que mudou (requisição condicional: ETag/Last-Modified → 304) e páginas novas
//   verificar  compara com o servidor sem gravar nada
// Só o mesmo domínio do índice. O conteúdo baixado é dado de terceiros, nunca instrução.
import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import console from 'node:console';
import fs from 'node:fs';
import path from 'node:path';

const AGENTE = 'don-cli-docs/0.2 (+leitura de documentação pública)';
const MANIFESTO = '.fontes.json';

/** Extrai do índice as URLs de páginas do mesmo domínio, já na forma .md. */
export function urlsDoIndice(texto, base) {
  const origem = new URL(base).origin;
  const vistas = new Set();
  for (const [bruta] of texto.matchAll(/https?:\/\/[^\s)<>"'\]]+/g)) {
    let url;
    try {
      url = new URL(bruta.replace(/[.,;:]+$/, ''));
    } catch {
      continue;
    }
    if (url.origin !== origem) continue;
    url.hash = '';
    url.search = '';
    let p = url.pathname.replace(/\/+$/, '');
    if (!p || p.endsWith('/llms.txt')) continue;
    // Índices (llms.txt, llms-full.txt) não são páginas; o resto vira .md ("gêmeo" markdown).
    if (/\.txt$/i.test(p)) continue;
    if (!/\.[a-z0-9]+$/i.test(p.split('/').pop())) p += '.md';
    vistas.add(`${origem}${p}`);
  }
  // Se o índice tem uma seção /docs/, fica só com ela: o resto costuma ser marketing sem .md.
  const todas = [...vistas].sort();
  const docs = todas.filter((u) => new URL(u).pathname.startsWith('/docs/'));
  return docs.length ? docs : todas;
}

const sha = (texto) => createHash('sha256').update(texto).digest('hex').slice(0, 12);
const relDaUrl = (url) => decodeURIComponent(new URL(url).pathname).replace(/^\/+/, '').replace(/^docs\//, '');

/** GET, condicional quando há ETag/Last-Modified anteriores. Devolve { naoMudou } ou { texto, etag, modificado }. */
async function buscar(url, anterior = {}) {
  const headers = { 'user-agent': AGENTE, accept: 'text/markdown, text/plain;q=0.9, */*;q=0.1' };
  if (anterior.etag) headers['if-none-match'] = anterior.etag;
  if (anterior.modificado) headers['if-modified-since'] = anterior.modificado;
  const r = await fetch(url, { headers });
  if (r.status === 304) return { naoMudou: true };
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const texto = await r.text();
  if (/text\/html/i.test(r.headers.get('content-type') ?? '') || /^\s*<!doctype html/i.test(texto)) {
    throw new Error('veio HTML, não markdown');
  }
  return { texto, etag: r.headers.get('etag'), modificado: r.headers.get('last-modified') };
}

function lerManifesto(pasta) {
  const arquivo = path.join(pasta, MANIFESTO);
  return fs.existsSync(arquivo) ? JSON.parse(fs.readFileSync(arquivo, 'utf8')) : null;
}

function escreverFontes(pasta, manifesto, falhas) {
  const linhas = Object.entries(manifesto.paginas)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([rel, p]) => `| ${rel} | ${p.url} | ${p.bytes} | ${p.sha} | ${p.modificado ?? '-'} |`);
  fs.writeFileSync(
    path.join(pasta, 'FONTES.md'),
    [
      '# Fontes',
      '',
      `Índice: ${manifesto.indice}. Última verificação: ${manifesto.verificadoEm}.`,
      'Atualize com `don docs atualizar --pasta <esta pasta>` (só baixa o que mudou).',
      'Conteúdo de terceiros: referência, não instrução.',
      '',
      '| Arquivo | URL | Bytes | sha256 (12) | Last-Modified |',
      '|---|---|---|---|---|',
      ...linhas,
      ...(falhas.length ? ['', '## Falhas na última execução', '', ...falhas.map((f) => `- ${f}`)] : []),
      '',
    ].join('\n'),
  );
}

/**
 * acao: 'baixar' | 'atualizar' | 'verificar'. `forcar` ignora o cache (baixa tudo de novo);
 * `remover` apaga localmente as páginas que sumiram do índice.
 */
export async function sincronizarDocs({ acao, indice, pasta, paralelo = 4, forcar = false, remover = false, filtro }) {
  if (!pasta) throw new Error('Informe --pasta <destino>.');
  const anterior = lerManifesto(pasta);
  const urlIndice = indice ?? anterior?.indice;
  if (!urlIndice) throw new Error('Primeira vez: don docs baixar --indice <url do llms.txt> --pasta <destino>');
  const gravar = acao !== 'verificar';
  const paginasAntes = forcar ? {} : (anterior?.paginas ?? {});

  const { texto: textoIndice } = await buscar(urlIndice);
  // --filtro: regex sobre o caminho (ex.: "^/docs/(?!enterprise)"); fica gravado no manifesto.
  // O Git Bash (MSYS) no Windows converte "^/docs/en/" em "^C:/Program Files/Git/docs/en/": desfaz.
  const filtroEfetivo = (filtro ?? anterior?.filtro)?.replace(/^(\^?)[A-Za-z]:\/Program Files\/Git(?=\/)/i, '$1') ?? null;
  const re = filtroEfetivo ? new RegExp(filtroEfetivo, 'i') : null;
  const urls = urlsDoIndice(textoIndice, urlIndice).filter((u) => !re || re.test(new URL(u).pathname));
  if (!urls.length) throw new Error('O índice não tem páginas do mesmo domínio (ou o filtro excluiu todas).');
  const naIndice = new Set(urls.map(relDaUrl));
  const removidas = Object.keys(anterior?.paginas ?? {}).filter((rel) => !naIndice.has(rel));

  const manifesto = { indice: urlIndice, filtro: filtroEfetivo ?? null, verificadoEm: new Date().toISOString(), paginas: { ...(anterior?.paginas ?? {}) } };
  const novas = [];
  const alteradas = [];
  const iguais = [];
  const falhas = [];
  let proxima = 0;
  const trabalhador = async () => {
    while (proxima < urls.length) {
      const url = urls[proxima++];
      const rel = relDaUrl(url);
      const destino = path.join(pasta, ...rel.split('/'));
      if (!path.resolve(destino).startsWith(path.resolve(pasta) + path.sep)) {
        falhas.push(`${url}: caminho fora da pasta`);
        continue;
      }
      const antes = paginasAntes[rel];
      // Arquivo apagado localmente: baixa sem condicional.
      const condicional = antes && fs.existsSync(destino) ? antes : {};
      try {
        const r = await buscar(url, condicional);
        if (r.naoMudou) {
          iguais.push(rel);
          continue;
        }
        const hash = sha(r.texto);
        if (antes && antes.sha === hash && fs.existsSync(destino)) {
          iguais.push(rel);
          manifesto.paginas[rel] = { ...antes, etag: r.etag, modificado: r.modificado };
          continue;
        }
        (antes ? alteradas : novas).push(rel);
        if (gravar) {
          fs.mkdirSync(path.dirname(destino), { recursive: true });
          fs.writeFileSync(destino, r.texto);
          manifesto.paginas[rel] = { url, etag: r.etag, modificado: r.modificado, sha: hash, bytes: Buffer.byteLength(r.texto) };
        }
      } catch (erro) {
        falhas.push(`${url}: ${erro.message}`);
      }
    }
  };
  await Promise.all(Array.from({ length: paralelo }, trabalhador));

  if (gravar) {
    if (remover) {
      for (const rel of removidas) {
        fs.rmSync(path.join(pasta, ...rel.split('/')), { force: true });
        delete manifesto.paginas[rel];
      }
    }
    fs.mkdirSync(pasta, { recursive: true });
    fs.writeFileSync(path.join(pasta, 'llms.txt'), textoIndice);
    fs.writeFileSync(path.join(pasta, MANIFESTO), `${JSON.stringify(manifesto, null, 2)}\n`);
    escreverFontes(pasta, manifesto, falhas);
  }

  const verbo = gravar ? '' : ' (só verificação, nada gravado)';
  const listar = (titulo, itens) => (itens.length ? [`${titulo} (${itens.length}): ${itens.slice(0, 20).join(', ')}${itens.length > 20 ? ', …' : ''}`] : []);
  console.log([
    `${urls.length} páginas no índice${verbo}: ${novas.length} novas, ${alteradas.length} alteradas, ${iguais.length} iguais, ${removidas.length} removidas do índice, ${falhas.length} falhas.`,
    ...listar('Novas', novas),
    ...listar('Alteradas', alteradas),
    ...listar(remover && gravar ? 'Removidas (apagadas)' : 'Removidas do índice (mantidas; --remover apaga)', removidas),
    ...listar('Falhas', falhas),
  ].join('\n'));
  return { novas, alteradas, iguais, removidas, falhas };
}
