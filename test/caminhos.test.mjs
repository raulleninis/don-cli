import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { apagar, don, repoTemporario } from './ajuda.mjs';

let raiz;
let c;
before(async () => {
  raiz = repoTemporario({ 'package.json': '{}' });
  don(raiz, 'instalar');
  const config = JSON.parse(fs.readFileSync(path.join(raiz, '.githooks', 'don.json'), 'utf8'));
  config.protegidos = { 'src/crypto/': 'Congelado.' };
  config.reservados['api/'] = 'Sensível.';
  config.liberados = ['docs/livre.md'];
  fs.writeFileSync(path.join(raiz, '.githooks', 'don.json'), JSON.stringify(config));
  c = await import(pathToFileURL(path.join(raiz, '.githooks', 'caminhos.mjs')).href);
});
after(() => apagar(raiz));

test('globParaRegex: pasta, *, ** e ?', () => {
  assert.ok(c.globParaRegex('src/crypto/').test('src/crypto'));
  assert.ok(c.globParaRegex('src/crypto/').test('src/crypto/a/b.ts'));
  assert.ok(!c.globParaRegex('src/crypto/').test('src/cryptography.ts'));
  assert.ok(c.globParaRegex('*.config.*').test('vite.config.ts'));
  assert.ok(!c.globParaRegex('*.config.*').test('pasta/vite.config.ts'));
  assert.ok(c.globParaRegex('**/.env').test('.env'));
  assert.ok(c.globParaRegex('**/.env').test('a/b/.env'));
  assert.ok(c.globParaRegex('requirements*.txt').test('requirements-dev.txt'));
  assert.ok(c.globParaRegex('arquivo?.md').test('arquivo1.md'));
  assert.ok(c.globParaRegex('SRC/Crypto/').test('src/crypto/x.ts'), 'sem distinção de maiúsculas');
});

test('protegidos: do projeto e embutidos', () => {
  assert.match(c.motivo('src/crypto/chave.ts', c.PROTEGIDOS), /Congelado/);
  assert.ok(c.motivo('.env', c.PROTEGIDOS));
  assert.ok(c.motivo('config/.env.local', c.PROTEGIDOS));
  assert.ok(c.motivo('.githooks/don.json', c.PROTEGIDOS));
  assert.ok(c.motivo('.agents/hooks/guarda.mjs', c.PROTEGIDOS));
  assert.equal(c.motivo('api/rotas.ts', c.PROTEGIDOS), null, 'reservado não é protegido');
  assert.equal(c.motivo('src/ui/tela.tsx', c.PROTEGIDOS), null);
});

test('reservados incluem os protegidos, os do modelo e os embutidos', () => {
  assert.match(c.motivo('api/rotas.ts', c.RESERVADOS), /Sensível/);
  assert.ok(c.motivo('src/crypto/x.ts', c.RESERVADOS));
  assert.ok(c.motivo('package.json', c.RESERVADOS));
  assert.ok(c.motivo('AGENTS.md', c.RESERVADOS));
  assert.ok(c.motivo('.claude/settings.json', c.RESERVADOS));
  assert.equal(c.motivo('src/ui/tela.tsx', c.RESERVADOS), null);
});

test('liberados valem antes de tudo', () => {
  assert.equal(c.motivo('.env.example', c.PROTEGIDOS), null);
  assert.equal(c.motivo('docs/livre.md', c.RESERVADOS), null);
});

test('caminhos com barra invertida e ./ são normalizados', () => {
  assert.ok(c.motivo('src\\crypto\\x.ts', c.PROTEGIDOS));
  assert.ok(c.motivo('./src/crypto/x.ts', c.PROTEGIDOS));
});
