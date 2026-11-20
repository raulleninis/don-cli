import assert from 'node:assert/strict';
import { test } from 'node:test';
import { acharPor } from '../lib/resposta.mjs';
import { conferirCitacao, fatiar } from '../lib/resumir.mjs';

const doc = [
  '# Título',
  'introdução curta',
  '## Seção A',
  ...Array.from({ length: 30 }, (_, i) => `linha A ${i} com algum texto`),
  '## Seção B',
  'o sandbox bloqueia a rede por padrão',
  'fim',
].join('\n');

test('fatiar: cobre todas as linhas, em ordem, sem sobrepor', () => {
  const fatias = fatiar(doc, 400);
  assert.ok(fatias.length > 1);
  assert.equal(fatias[0].de, 1);
  for (let i = 1; i < fatias.length; i++) assert.equal(fatias[i].de, fatias[i - 1].ate + 1);
  assert.equal(fatias.at(-1).ate, doc.split('\n').length);
});

test('fatiar: corta em título quando cabe', () => {
  const fatias = fatiar(doc, 100000);
  assert.equal(fatias.length, 1, 'tudo numa fatia quando cabe');
  // Cada seção custa 20 (texto + 8 por linha para o prefixo do número); duas não cabem em 25.
  const pequenas = fatiar('# A\nx\n# B\ny', 25);
  assert.deepEqual(pequenas.map((f) => f.linhas[0]), ['# A', '# B']);
});

test('fatiar: seção maior que o limite é cortada por linhas', () => {
  for (const f of fatiar(doc, 200)) assert.ok(f.linhas.join('\n').length <= 200 + 8 * f.linhas.length);
});

test('conferirCitacao: acha a citação perto das linhas e recusa a inventada', () => {
  const linhas = doc.split('\n');
  const n = linhas.indexOf('o sandbox bloqueia a rede por padrão') + 1;
  assert.ok(conferirCitacao(linhas, `${n}-${n + 1}`, 'O sandbox bloqueia a REDE'));
  assert.ok(conferirCitacao(linhas, `${n + 3}`, 'sandbox bloqueia a rede'), 'folga de 5 linhas');
  assert.equal(conferirCitacao(linhas, `${n}`, 'o sandbox libera a rede'), false);
  assert.equal(conferirCitacao(linhas, '1-2', 'sandbox bloqueia a rede'), false, 'longe das linhas indicadas');
  assert.equal(conferirCitacao(linhas, 'sem número', 'fim'), false);
});

test('acharPor: resumo dentro do envelope do agy', () => {
  const r = { panorama: 'x', itens: [] };
  const envelope = { status: 'SUCCESS', json_schema: { properties: { itens: {}, panorama: {} } }, structured_output: r };
  assert.deepEqual(acharPor(`aviso\n${JSON.stringify(envelope)}`, (v) => Array.isArray(v.itens) && typeof v.panorama === 'string'), r);
});
