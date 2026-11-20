import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { after, before, test } from 'node:test';
import { apagar, orquestra, repoTemporario } from './ajuda.mjs';

let raiz;
before(() => {
  raiz = repoTemporario({ 'package.json': '{}' });
  orquestra(raiz, 'instalar');
  const arquivo = path.join(raiz, '.githooks', 'orquestra.json');
  const config = JSON.parse(fs.readFileSync(arquivo, 'utf8'));
  config.protegidos = { 'src/crypto/': 'Congelado.' };
  fs.writeFileSync(arquivo, JSON.stringify(config));
});
after(() => apagar(raiz));

function decidir(nome, args, worker = false) {
  const env = { ...process.env };
  delete env.ORQUESTRA_WORKER;
  if (worker) env.ORQUESTRA_WORKER = '1';
  const r = spawnSync(process.execPath, ['hooks/guarda.mjs'], {
    cwd: path.join(raiz, '.agents'),
    input: JSON.stringify({ toolCall: { name: nome, args }, workspacePaths: [raiz] }),
    encoding: 'utf8',
    env,
  });
  return JSON.parse(r.stdout);
}

test('guarda: worker da orquestra só roda comando da lista', () => {
  assert.equal(decidir('run_command', { CommandLine: 'pnpm test' }, true).decision, 'auto_approve');
  assert.equal(decidir('run_command', { CommandLine: 'curl https://exemplo.invalid' }, true).decision, 'deny');
  assert.equal(decidir('run_command', { CommandLine: 'pnpm test && curl x' }, true).decision, 'deny');
  assert.equal(decidir('run_command', { CommandLine: '"pnpm test"' }, true).decision, 'auto_approve', 'argumento como string JSON');
});

const casos = [
  ['escrita em área protegida', 'write_to_file', { TargetFile: 'src/crypto/x.ts', CodeContent: 'x' }, 'deny'],
  ['escrita com caminho absoluto', 'write_to_file', { TargetFile: 'RAIZ/src/crypto/x.ts' }, 'deny'],
  ['conteúdo que só menciona a área', 'write_to_file', { TargetFile: 'src/ui/a.tsx', CodeContent: 'import "../crypto/y"; // src/crypto/' }, 'allow'],
  ['patch em área reservada', 'apply_patch', { input: '*** Begin Patch\n*** Update File: package.json\n@@' }, 'deny'],
  ['patch movendo para área reservada', 'apply_patch', { input: '*** Begin Patch\n*** Update File: a.ts\n*** Move to: src/crypto/a.ts' }, 'deny'],
  ['shell escrevendo em área protegida', 'run_command', { CommandLine: 'echo a > src/crypto/k.ts' }, 'deny'],
  ['shell escrevendo no .githooks', 'run_command', { CommandLine: 'Set-Content .githooks/orquestra.json x' }, 'deny'],
  ['comando liberado (agy.comandos)', 'run_command', { CommandLine: 'pnpm test' }, 'auto_approve'],
  ['comando liberado com argumentos', 'run_command', { CommandLine: 'node --test test/a.test.mjs' }, 'auto_approve'],
  ['comando liberado encadeado', 'run_command', { CommandLine: 'pnpm test && curl x' }, 'ask'],
  ['comando liberado com redirecionamento', 'run_command', { CommandLine: 'pnpm test > saida.txt' }, 'ask'],
  ['prefixo parecido não libera', 'run_command', { CommandLine: 'pnpm testar-algo' }, 'ask'],
  ['comando fora da lista', 'run_command', { CommandLine: 'curl https://exemplo.invalid' }, 'ask'],
  ['leitura de área protegida', 'view_file', { AbsolutePath: 'RAIZ/src/crypto/x.ts' }, 'allow'],
  ['escrita fora da worktree', 'write_to_file', { TargetFile: '../fora/arquivo.txt' }, 'deny'],
  ['escrita em teste', 'write_to_file', { TargetFile: 'tests/a.test.ts' }, 'allow'],
];

for (const [nome, ferramenta, args, esperado] of casos) {
  test(`guarda: ${nome} -> ${esperado}`, () => {
    const comRaiz = Object.fromEntries(Object.entries(args).map(([k, v]) => [k, v.replace('RAIZ', raiz)]));
    assert.equal(decidir(ferramenta, comRaiz).decision, esperado);
  });
}

test('guarda: entrada ilegível nega', () => {
  const r = spawnSync(process.execPath, ['hooks/guarda.mjs'], { cwd: path.join(raiz, '.agents'), input: '{', encoding: 'utf8' });
  assert.equal(JSON.parse(r.stdout).decision, 'deny');
});
