// Acha a resposta estruturada do worker no que ele devolveu: crua (Codex, -o) ou dentro de um
// envelope JSON, às vezes como string (agy --output-format json).

// O envelope do agy repete o esquema pedido em `json_schema` (com `properties.status`...): não é
// resposta. A resposta tem `status` e `resumo` como texto.
const IGNORAR = new Set(['json_schema', 'schema', 'properties']);

export function acharResposta(valor) {
  if (typeof valor === 'string') return valor.includes('"status"') ? extrairJson(valor) : null;
  if (!valor || typeof valor !== 'object') return null;
  if (typeof valor.status === 'string' && typeof valor.resumo === 'string') return valor;
  // structured_output primeiro: é onde o agy põe a resposta validada.
  const chaves = Object.keys(valor).sort((a, b) => (b === 'structured_output') - (a === 'structured_output'));
  for (const chave of chaves) {
    if (IGNORAR.has(chave)) continue;
    const achou = acharResposta(valor[chave]);
    if (achou) return achou;
  }
  return null;
}

export function extrairJson(texto) {
  const fim = texto.lastIndexOf('}');
  for (let ini = texto.lastIndexOf('{', fim); ini >= 0; ini = texto.lastIndexOf('{', ini - 1)) {
    try {
      const achou = acharResposta(JSON.parse(texto.slice(ini, fim + 1)));
      if (achou) return achou;
    } catch {
      /* tenta o próximo { */
    }
  }
  return null;
}
