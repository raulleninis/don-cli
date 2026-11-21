import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { after, before, test } from 'node:test';
import { apagar, BIN, don, repoTemporario } from './ajuda.mjs';

let raiz;
before(() => {
  raiz = repoTemporario({ 'package.json': '{}' });
});
after(() => apagar(raiz));

test('--relatorio grava a saída do comando e aguardar a devolve', () => {
  const arquivo = path.join(raiz, '.don', 'cascas', 'ok.txt');
  don(raiz, 'ajuda', '--relatorio', arquivo);
  assert.ok(fs.existsSync(arquivo));
  assert.ok(!fs.existsSync(`${arquivo}.parcial`));
  const saida = don(raiz, 'aguardar', arquivo, '--segundos', '1');
  assert.match(saida, /don delegar --motor/);
  assert.match(saida, /\[don: fim, código de saída 0\]/);
});

test('--relatorio grava também o erro, para quem aguarda não ficar preso', () => {
  const arquivo = path.join(raiz, '.don', 'cascas', 'erro.txt');
  const r = spawnSync(process.execPath, [BIN, 'limpar', '--relatorio', arquivo], { cwd: raiz, encoding: 'utf8' });
  assert.equal(r.status, 1);
  const texto = fs.readFileSync(arquivo, 'utf8');
  assert.match(texto, /Informe o slug/);
  assert.match(texto, /código de saída 1/);
});

test('aguardar sem o arquivo avisa que ainda roda, com código 3', () => {
  const r = spawnSync(process.execPath, [BIN, 'aguardar', path.join(raiz, 'nao-existe.txt'), '--segundos', '0'], {
    cwd: raiz, encoding: 'utf8',
  });
  assert.equal(r.status, 3);
  assert.match(r.stdout, /^AINDA RODANDO/);
});
