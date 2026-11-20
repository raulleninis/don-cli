import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { after, before, test } from 'node:test';
import { comImportClaude, comTrechoAgents, mesclarSettings, montarConfiguracao, sugerirProtegidos } from '../lib/configurar.mjs';
import { motoresAtivos, motorPadrao } from '../lib/motores.mjs';
import { apagar, BIN, repoTemporario } from './ajuda.mjs';

let casaDon;
let casaCodex;
before(() => {
  casaDon = fs.mkdtempSync(path.join(os.tmpdir(), 'don-casa-'));
  casaCodex = fs.mkdtempSync(path.join(os.tmpdir(), 'don-codex-'));
});
after(() => {
  fs.rmSync(casaDon, { recursive: true, force: true });
  fs.rmSync(casaCodex, { recursive: true, force: true });
});

test('montarConfiguracao: motores, perfil de custo, sensibilidade e áreas protegidas', () => {
  const c = montarConfiguracao({ tipo: 'node', nome: 'app', motores: ['codex'], perfil: 'economia', sensivel: true, protegidos: ['src/crypto/'] });
  assert.deepEqual(c.motores, ['codex']);
  assert.equal(c.lealdade, 'exigir');
  assert.equal(c.codex.modelo, 'gpt-6-luna');
  assert.equal(c.codex.perfil, 'don', 'mantém o que o modelo já tinha');
  assert.ok(c.protegidos['src/crypto/']);
  assert.deepEqual(Object.keys(c).slice(0, 4), ['projeto', 'motores', 'perfil', 'lealdade']);
  const q = montarConfiguracao({ tipo: 'node', nome: 'app', motores: ['codex', 'agy'], perfil: 'qualidade', sensivel: false, base: c });
  assert.equal(q.lealdade, 'aviso');
  assert.deepEqual(q.codex.escada, ['gpt-6.2-sol', 'gpt-6.2-astra']);
  assert.ok(q.protegidos['src/crypto/'], 'atualizar mantém o que já existia');
});

test('mesclarSettings: une sem duplicar e sem perder regras do projeto', () => {
  const atual = { model: 'sonnet', permissions: { allow: ['Read(./**)'], deny: ['Bash(rm -rf *)'] } };
  const nosso = { model: 'opus', permissions: { allow: ['Read(./**)', 'Bash(don delegar *)'], deny: ['Bash(*--dangerously*)'] } };
  const r = mesclarSettings(atual, nosso);
  assert.equal(r.model, 'sonnet', 'não troca o modelo escolhido pelo projeto');
  assert.deepEqual(r.permissions.allow, ['Read(./**)', 'Bash(don delegar *)']);
  assert.deepEqual(r.permissions.deny, ['Bash(rm -rf *)', 'Bash(*--dangerously*)']);
});

test('AGENTS.md e CLAUDE.md: acrescenta uma vez só', () => {
  const trecho = '## Agentes neste projeto (don)\nregras';
  const uma = comTrechoAgents('# Projeto\n', trecho);
  assert.equal(comTrechoAgents(uma, trecho), uma);
  assert.match(comImportClaude('# regras do claude'), /^@AGENTS\.md\n\n# regras do claude/);
  assert.equal(comImportClaude('@AGENTS.md\n'), '@AGENTS.md\n');
});

test('sugerirProtegidos: pastas com cara de sensível', () => {
  const raiz = repoTemporario({ 'src/crypto/a.ts': '', 'src/ui/b.tsx': '', 'db/migrations/1.sql': '', 'node_modules/auth/x.js': '' });
  try {
    assert.deepEqual(sugerirProtegidos(raiz).sort(), ['db/migrations/', 'src/crypto/']);
  } finally {
    apagar(raiz);
  }
});

test('motores ativos: projeto manda; senão a máquina; motorPadrao cai no primeiro ativo', () => {
  assert.deepEqual(motoresAtivos({ config: { motores: ['agy'] } }), ['agy']);
  assert.equal(motorPadrao({ config: { motores: ['agy'] } }, 'codex'), 'agy');
  assert.equal(motorPadrao({ config: { motores: ['codex', 'agy'] } }, 'agy'), 'agy');
});

test('don configurar sem perguntas: grava máquina e projeto e integra (sem rede)', () => {
  const raiz = repoTemporario({ 'package.json': '{}', 'src/crypto/k.ts': '', 'CLAUDE.md': '# regras\n' });
  const respostas = path.join(raiz, 'respostas.json');
  fs.writeFileSync(respostas, JSON.stringify({
    motores: ['codex'], perfil: 'qualidade', sensivel: true, protegidos: ['src/crypto/'],
    integrar: true, confiar_codex: true, docs: false, lealdade: false,
  }));
  try {
    const r = spawnSync(process.execPath, [BIN, 'configurar', raiz, '--respostas', respostas], {
      encoding: 'utf8', env: { ...process.env, DON_HOME: casaDon, CODEX_HOME: casaCodex },
    });
    assert.equal(r.status, 0, r.stderr + r.stdout);
    const config = JSON.parse(fs.readFileSync(path.join(raiz, '.githooks/don.json'), 'utf8'));
    assert.deepEqual(config.motores, ['codex']);
    assert.equal(config.lealdade, 'exigir');
    assert.equal(config.codex.escada[0], 'gpt-6.2-sol');
    assert.ok(config.protegidos['src/crypto/']);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(casaDon, 'config.json'), 'utf8')).motores, ['codex']);
    assert.match(fs.readFileSync(path.join(raiz, 'CLAUDE.md'), 'utf8'), /^@AGENTS\.md/);
    assert.match(fs.readFileSync(path.join(raiz, 'AGENTS.md'), 'utf8'), /Agentes neste projeto \(don\)/);
    assert.ok(JSON.parse(fs.readFileSync(path.join(raiz, '.claude/settings.json'), 'utf8')).permissions.deny.length > 0);
    assert.match(fs.readFileSync(path.join(raiz, '.codex/config.toml'), 'utf8'), /\[permissions\.don\]/);
    assert.match(fs.readFileSync(path.join(casaCodex, 'config.toml'), 'utf8'), /trust_level = "trusted"/);
    assert.match(r.stdout, /Feito:/);
  } finally {
    apagar(raiz);
  }
});
