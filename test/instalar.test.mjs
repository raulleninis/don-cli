import console from 'node:console';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { after, before, test } from 'node:test';
import { acharResposta, extrairJson } from '../lib/resposta.mjs';
import { apagar, don, repoTemporario } from './ajuda.mjs';

let raiz;
before(() => {
  raiz = repoTemporario({ 'package.json': '{}', '.agents/hooks.json': '{"outro-hook": {"Stop": []}}' });
  don(raiz, 'instalar');
});
after(() => apagar(raiz));

test('instalar cria os arquivos e preserva hooks existentes do agy', () => {
  for (const rel of ['.githooks/caminhos.mjs', '.githooks/pre-commit', '.githooks/don.json', '.agents/hooks/guarda.mjs',
    '.claude/skills/don/SKILL.md', '.claude/agents/consigliere.md']) {
    assert.ok(fs.existsSync(path.join(raiz, rel)), rel);
  }
  const hooks = JSON.parse(fs.readFileSync(path.join(raiz, '.agents/hooks.json'), 'utf8'));
  assert.ok(hooks['don-guarda'] && hooks['outro-hook']);
  assert.match(fs.readFileSync(path.join(raiz, '.gitignore'), 'utf8'), /^\.don\/$/m);
  const config = JSON.parse(fs.readFileSync(path.join(raiz, '.githooks/don.json'), 'utf8'));
  assert.deepEqual(config.links, ['node_modules'], 'projeto Node usa o modelo node');
  assert.doesNotMatch(fs.readFileSync(path.join(raiz, '.claude/skills/don/SKILL.md'), 'utf8'), /\{\{ORQUESTRA\}\}/);
});

test('instalar de novo não sobrescreve o don.json, nem com --forcar', () => {
  const arquivo = path.join(raiz, '.githooks/don.json');
  const editado = fs.readFileSync(arquivo, 'utf8').replace('"protegidos": {}', '"protegidos": {"segredo/": "x"}');
  fs.writeFileSync(arquivo, editado);
  don(raiz, 'instalar', '--forcar');
  assert.equal(fs.readFileSync(arquivo, 'utf8'), editado);
});

test('pre-commit recusa caminho protegido e aceita o resto', () => {
  execFileSync('git', ['add', '-A'], { cwd: raiz });
  execFileSync('git', ['commit', '-q', '-m', 'instala'], { cwd: raiz });
  execFileSync('git', ['config', 'core.hooksPath', '.githooks'], { cwd: raiz });
  fs.mkdirSync(path.join(raiz, 'segredo'));
  fs.writeFileSync(path.join(raiz, 'segredo/a.txt'), 'x');
  execFileSync('git', ['add', '-A'], { cwd: raiz });
  const recusado = spawnSync('git', ['commit', '-q', '-m', 'tenta'], { cwd: raiz, encoding: 'utf8' });
  assert.notEqual(recusado.status, 0);
  assert.match(recusado.stderr, /segredo\/a\.txt/);
  const liberado = spawnSync('git', ['commit', '-q', '-m', 'liberado'], {
    cwd: raiz, encoding: 'utf8', env: { ...process.env, LIBERA_CAMINHO_PROTEGIDO: '1' },
  });
  assert.equal(liberado.status, 0, liberado.stderr);
  fs.writeFileSync(path.join(raiz, 'livre.txt'), 'x');
  execFileSync('git', ['add', '-A'], { cwd: raiz });
  assert.equal(spawnSync('git', ['commit', '-q', '-m', 'livre'], { cwd: raiz }).status, 0);
});

test('perfil-codex: segredos negados, reservados só leitura, sem rede', () => {
  const toml = don(raiz, 'perfil-codex');
  assert.match(toml, /^default_permissions = "don"$/m);
  assert.match(toml, /^"\*\*\/\.env" = "deny"$/m);
  assert.match(toml, /^"\.githooks" = "read"$/m);
  assert.match(toml, /^"segredo" = "read"$/m);
  assert.match(toml, /^"package\.json" = "read"$/m);
  assert.match(toml, /^enabled = false$/m);
  assert.equal((toml.match(/"\*\*\/\.env" =/g) ?? []).length, 1, 'sem duplicata');
});

test('resposta: crua, em envelope e como string dentro do envelope', () => {
  const r = { status: 'concluido', resumo: 'ok', arquivos: [], testes: '', duvidas: [] };
  assert.deepEqual(extrairJson(`ruído\n${JSON.stringify(r)}\n`), r);
  assert.deepEqual(acharResposta({ result: { structured_output: r } }), r);
  assert.deepEqual(extrairJson(JSON.stringify({ response: JSON.stringify(r), outra: 1 })), r);
  assert.equal(extrairJson('sem json aqui'), null);
});

test('resposta: o esquema ecoado no envelope do agy não é resposta', () => {
  const esquema = { properties: { status: { type: 'string' }, resumo: { type: 'string' } } };
  const semResposta = { status: 'SUCCESS', response: '', json_schema: esquema };
  assert.equal(extrairJson(`aviso\n${JSON.stringify(semResposta)}`), null);
  const r = { status: 'parcial', resumo: 'x', arquivos: [], testes: '', duvidas: [] };
  assert.deepEqual(extrairJson(JSON.stringify({ ...semResposta, structured_output: r })), r);
});

test('perfil-codex: no Windows o sandbox elevated sai ativo; fora dele, comentado', async () => {
  const { perfilCodex } = await import('../lib/instalar.mjs');
  const { carregarProjeto } = await import('../lib/projeto.mjs');
  const projeto = await carregarProjeto(raiz);
  const gerar = (windows) => {
    const linhas = [];
    const salvar = console.log;
    console.log = (t) => linhas.push(t);
    try {
      perfilCodex(projeto, undefined, windows);
    } finally {
      console.log = salvar;
    }
    return linhas.join('\n');
  };
  assert.match(gerar(true), /^\[windows\]\nsandbox = "elevated"$/m);
  assert.match(gerar(true), /^prefer_mxc = true$/m);
  assert.match(gerar(false), /^# sandbox = "elevated"$/m);
  assert.doesNotMatch(gerar(false), /^\[windows\]$/m);
});

test('instalar: remove hook antigo do agy que roda o mesmo guarda.mjs e aceita --config pronto', async () => {
  const { instalar } = await import('../lib/instalar.mjs');
  const legado = repoTemporario({
    'package.json': '{}',
    '.agents/hooks.json': JSON.stringify({ 'guarda-desaperreia': { PreToolUse: [{ matcher: '', hooks: [{ command: 'node hooks/guarda.mjs' }] }] }, outro: { Stop: [] } }),
    'pronto.json': JSON.stringify({ projeto: 'pronto', lealdade: 'exigir', protegidos: { 'src/crypto/': 'x' } }),
  });
  const salvar = console.log;
  console.log = () => {};
  try {
    instalar(legado, { config: path.join(legado, 'pronto.json') });
    const hooks = JSON.parse(fs.readFileSync(path.join(legado, '.agents/hooks.json'), 'utf8'));
    assert.deepEqual(Object.keys(hooks).sort(), ['don-guarda', 'outro'], 'o hook antigo saiu e o de terceiros ficou');
    assert.equal(JSON.parse(fs.readFileSync(path.join(legado, '.githooks/don.json'), 'utf8')).lealdade, 'exigir');
    fs.writeFileSync(path.join(legado, 'outro.json'), JSON.stringify({ projeto: 'outro' }));
    instalar(legado, { config: path.join(legado, 'outro.json') });
    assert.equal(JSON.parse(fs.readFileSync(path.join(legado, '.githooks/don.json'), 'utf8')).projeto, 'pronto', 'sem --forcar não sobrescreve');
    instalar(legado, { config: path.join(legado, 'outro.json'), forcar: true });
    assert.equal(JSON.parse(fs.readFileSync(path.join(legado, '.githooks/don.json'), 'utf8')).projeto, 'outro');
  } finally {
    console.log = salvar;
    apagar(legado);
  }
});
