// Acha a resposta estruturada do worker no que ele devolveu: crua (Codex, -o) ou dentro de um
// envelope JSON, às vezes como string (agy --output-format json).
//
// Tempo LINEAR, de propósito. A versão anterior tentava JSON.parse a partir de cada `{` e, ao achar
// texto com JSON dentro, recomeçava a varredura nele: com a resposta grande do agy, isso explodia,
// prendia a CPU por minutos e, com o event loop parado, nem o limite de tempo disparava.

// O envelope do agy repete o esquema pedido em `json_schema` (com `properties.status`...): não é resposta.
const IGNORAR = new Set(['json_schema', 'schema', 'properties']);
const MAX_VARREDURA = 200;

const tentar = (texto) => {
  try {
    return JSON.parse(texto);
  } catch {
    return undefined;
  }
};

/** Procura em objetos já interpretados; texto só é interpretado se for JSON inteiro (sem varrer). */
function procurar(valor, pred, profundidade = 0) {
  if (profundidade > 12) return null;
  if (typeof valor === 'string') {
    const t = valor.trim();
    if (!(t.startsWith('{') && t.endsWith('}'))) return null;
    const obj = tentar(t);
    return obj === undefined ? null : procurar(obj, pred, profundidade + 1);
  }
  if (!valor || typeof valor !== 'object') return null;
  if (!Array.isArray(valor) && pred(valor)) return valor;
  const chaves = Object.keys(valor).sort((a, b) => (b === 'structured_output') - (a === 'structured_output'));
  for (const chave of chaves) {
    if (IGNORAR.has(chave)) continue;
    const achou = procurar(valor[chave], pred, profundidade + 1);
    if (achou) return achou;
  }
  return null;
}

/** Acha, no texto ou objeto, o primeiro objeto que satisfaz `pred`. */
export function acharPor(valor, pred) {
  if (typeof valor !== 'string') return procurar(valor, pred);
  // 1. O texto inteiro.  2. Cada linha, de baixo para cima (o envelope do agy é uma linha).
  const inteiro = tentar(valor.trim());
  if (inteiro !== undefined) {
    const achou = procurar(inteiro, pred);
    if (achou) return achou;
  }
  const linhas = valor.split(/\r?\n/);
  for (let i = linhas.length - 1; i >= 0; i--) {
    const l = linhas[i].trim();
    if (!l.startsWith('{')) continue;
    const obj = tentar(l);
    if (obj === undefined) continue;
    const achou = procurar(obj, pred);
    if (achou) return achou;
  }
  // 3. Último recurso: JSON no meio do texto. Varre poucos `{` a partir do fim, sem recursão em texto.
  const fim = valor.lastIndexOf('}');
  let tentativas = 0;
  for (let ini = valor.lastIndexOf('{', fim); ini >= 0 && tentativas < MAX_VARREDURA; ini = valor.lastIndexOf('{', ini - 1)) {
    tentativas += 1;
    const obj = tentar(valor.slice(ini, fim + 1));
    if (obj === undefined) continue;
    const achou = procurar(obj, pred);
    if (achou) return achou;
  }
  return null;
}

const ehResposta = (v) => typeof v.status === 'string' && typeof v.resumo === 'string';
export const acharResposta = (valor) => acharPor(valor, ehResposta);
export const extrairJson = (texto) => acharPor(texto, ehResposta);
