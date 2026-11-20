import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { after, before, test } from 'node:test';
import { codexConfiaNoProjeto } from '../lib/codex.mjs';

let home;
const antes = process.env.CODEX_HOME;
before(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'don-codex-'));
  process.env.CODEX_HOME = home;
  fs.writeFileSync(
    path.join(home, 'config.toml'),
    [
      'model = "x"',
      "[projects.'c:\\projetos\\confiavel']",
      'trust_level = "trusted"',
      '',
      '[projects."C:\\\\outro\\\\aspas"]',
      'trust_level = "trusted"',
      '',
      "[projects.'c:\\projetos\\nao-confiavel']",
      'trust_level = "untrusted"',
      '',
      '[features]',
      'trust_level = "trusted"',
    ].join('\n'),
  );
});
after(() => {
  if (antes === undefined) delete process.env.CODEX_HOME;
  else process.env.CODEX_HOME = antes;
  fs.rmSync(home, { recursive: true, force: true });
});

test('confiança do Codex: caminho sem distinção de maiúsculas e barras', { skip: process.platform !== 'win32' }, () => {
  assert.ok(codexConfiaNoProjeto('C:/projetos/confiavel'));
  assert.ok(codexConfiaNoProjeto('C:\\Projetos\\confiavel\\'));
  assert.ok(codexConfiaNoProjeto('C:\\outro\\aspas'), 'chave com aspas duplas e barras escapadas');
});

test('confiança do Codex: não confiável, ausente ou de outra seção', { skip: process.platform !== 'win32' }, () => {
  assert.equal(codexConfiaNoProjeto('C:/projetos/nao-confiavel'), false);
  assert.equal(codexConfiaNoProjeto('C:/projetos/outro'), false);
  assert.equal(codexConfiaNoProjeto('C:/projetos/confiavel-mas-outro'), false);
});
