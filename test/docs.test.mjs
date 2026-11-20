import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { sincronizarDocs, urlsDoIndice } from '../lib/docs.mjs';

let servidor;
let base;
let pasta;
const paginas = { '/docs/a.md': '# A\nprimeira', '/docs/b.md': '# B\nsegunda' };
let indice = '';
let pedidos = [];

before(async () => {
  servidor = http.createServer((req, res) => {
    pedidos.push(`${req.url} ${req.headers['if-none-match'] ? 'condicional' : 'normal'}`);
    if (req.url === '/llms.txt') return res.end(indice);
    const corpo = paginas[req.url];
    if (corpo === undefined) {
      res.statusCode = 404;
      return res.end('nada');
    }
    const etag = `"${createHash('sha1').update(corpo).digest('hex').slice(0, 8)}"`;
    if (req.headers['if-none-match'] === etag) {
      res.statusCode = 304;
      return res.end();
    }
    res.setHeader('etag', etag);
    res.setHeader('content-type', 'text/markdown');
    res.end(corpo);
  });
  await new Promise((r) => servidor.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${servidor.address().port}`;
  pasta = fs.mkdtempSync(path.join(os.tmpdir(), 'orquestra-docs-'));
  indice = `- [A](${base}/docs/a/)\n- [B](${base}/docs/b)\n- [Fora](https://outro.exemplo/docs/x)\n- [Marketing](${base}/pricing)`;
});
after(() => {
  servidor.close();
  fs.rmSync(pasta, { recursive: true, force: true });
});

test('urlsDoIndice: mesmo domínio, forma .md, só /docs/ quando existe', () => {
  assert.deepEqual(urlsDoIndice(indice, `${base}/llms.txt`), [`${base}/docs/a.md`, `${base}/docs/b.md`]);
});

test('baixar, atualizar (304), alteração, página nova, verificar sem gravar, remover', async () => {
  const silencio = { ...console };
  const r1 = await sincronizarDocs({ acao: 'baixar', indice: `${base}/llms.txt`, pasta });
  assert.deepEqual([r1.novas.length, r1.alteradas.length], [2, 0]);
  assert.equal(fs.readFileSync(path.join(pasta, 'a.md'), 'utf8'), '# A\nprimeira');
  assert.ok(fs.existsSync(path.join(pasta, 'FONTES.md')));

  pedidos = [];
  const r2 = await sincronizarDocs({ acao: 'atualizar', pasta });
  assert.deepEqual([r2.novas.length, r2.alteradas.length, r2.iguais.length], [0, 0, 2]);
  assert.ok(pedidos.filter((p) => p.endsWith('condicional')).length === 2, 'usa ETag');

  paginas['/docs/b.md'] = '# B\nmudou';
  indice += `\n- [C](${base}/docs/c)`;
  paginas['/docs/c.md'] = '# C';
  const r3 = await sincronizarDocs({ acao: 'verificar', pasta });
  assert.deepEqual([r3.novas, r3.alteradas], [['c.md'], ['b.md']]);
  assert.equal(fs.readFileSync(path.join(pasta, 'b.md'), 'utf8'), '# B\nsegunda', 'verificar não grava');
  assert.ok(!fs.existsSync(path.join(pasta, 'c.md')));

  await sincronizarDocs({ acao: 'atualizar', pasta });
  assert.equal(fs.readFileSync(path.join(pasta, 'b.md'), 'utf8'), '# B\nmudou');
  assert.ok(fs.existsSync(path.join(pasta, 'c.md')));

  indice = indice.replace(`- [A](${base}/docs/a/)\n`, '');
  const r5 = await sincronizarDocs({ acao: 'atualizar', pasta });
  assert.deepEqual(r5.removidas, ['a.md']);
  assert.ok(fs.existsSync(path.join(pasta, 'a.md')), 'sem --remover, mantém');
  await sincronizarDocs({ acao: 'atualizar', pasta, remover: true });
  assert.ok(!fs.existsSync(path.join(pasta, 'a.md')));

  fs.rmSync(path.join(pasta, 'b.md'));
  const r7 = await sincronizarDocs({ acao: 'atualizar', pasta });
  assert.deepEqual(r7.alteradas, ['b.md'], 'arquivo apagado localmente volta');
  const r8 = await sincronizarDocs({ acao: 'baixar', pasta, forcar: true });
  assert.equal(r8.novas.length, 2, '--forcar baixa tudo de novo');
  Object.assign(console, silencio);
});

test('filtro: desfaz a conversão de caminho do Git Bash (MSYS)', async () => {
  const destino = fs.mkdtempSync(path.join(os.tmpdir(), 'orquestra-filtro-'));
  try {
    const r = await sincronizarDocs({ acao: 'verificar', indice: `${base}/llms.txt`, pasta: destino, filtro: '^C:/Program Files/Git/docs/b' });
    assert.deepEqual([...r.novas, ...r.alteradas, ...r.iguais], ['b.md']);
  } finally {
    fs.rmSync(destino, { recursive: true, force: true });
  }
});
