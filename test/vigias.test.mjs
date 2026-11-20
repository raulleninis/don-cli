import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { after, before, test } from 'node:test';
import { rodar } from '../lib/processo.mjs';
import { codexLimites } from '../lib/worker.mjs';
import { apagar, orquestra, repoTemporario } from './ajuda.mjs';

let pasta;
before(() => {
  pasta = fs.mkdtempSync(path.join(os.tmpdir(), 'orquestra-vigias-'));
});
after(() => fs.rmSync(pasta, { recursive: true, force: true }));

const script = (nome, corpo) => {
  const p = path.join(pasta, nome);
  fs.writeFileSync(p, corpo);
  return p;
};

test('vigia de inatividade encerra processo que parou de produzir', async () => {
  const p = script('parado.mjs', 'console.log("comecei"); setInterval(() => {}, 1000);');
  const inicio = Date.now();
  const r = await rodar('node', [p], { cwd: pasta, log: path.join(pasta, 'parado.log'), minutos: 1, inativo: 0.03 });
  assert.match(r.interrompido, /sem atividade/);
  assert.match(r.texto, /comecei/);
  assert.ok(Date.now() - inicio < 30_000);
});

test('sentinela: terminou mas não saiu → encerra e conclui com a saída', async () => {
  const marcador = path.join(pasta, 'terminou.json');
  const p = script('preso.mjs', `console.log("resultado pronto"); require("fs").writeFileSync(${JSON.stringify(marcador)}, "{}"); setInterval(() => {}, 1000);`.replace('require("fs")', '(await import("node:fs")).default'));
  const r = await rodar('node', [p], { cwd: pasta, minutos: 1, sentinela: marcador, esperaSentinela: 500 });
  assert.match(r.interrompido, /sentinela/);
  assert.match(r.texto, /resultado pronto/);
});

test('processo normal: nenhum vigia age', async () => {
  const p = script('normal.mjs', 'console.log("ok")');
  const r = await rodar('node', [p], { cwd: pasta, minutos: 1, inativo: 0.03, sentinela: path.join(pasta, 'nao-existe.json') });
  assert.equal(r.interrompido, null);
  assert.equal(r.codigo, 0);
});

test('codexLimites: notify com a sentinela e orçamento de tokens com lembretes', () => {
  const args = codexLimites({ limite_tokens: 100_000, limite_saida_ferramenta: 6000 }, 'C:\\x\\terminou.json');
  const valores = args.filter((_, i) => i % 2 === 1);
  const notify = valores.find((v) => v.startsWith('notify='));
  assert.deepEqual(JSON.parse(notify.slice('notify='.length)).at(-1), 'C:\\x\\terminou.json');
  assert.ok(valores.includes('tool_output_token_limit=6000'));
  assert.ok(valores.includes('features.rollout_budget.enabled=true'));
  assert.ok(valores.includes('features.rollout_budget.limit_tokens=100000'));
  assert.ok(valores.includes('features.rollout_budget.reminder_at_remaining_tokens=[25000,10000]'));
  assert.equal(codexLimites({ limite_tokens: null, limite_saida_ferramenta: null }, 'm').length, 2, 'sem limites, só o notify');
});

test('hook do agy: Stop grava a sentinela; limite de passos só deixa entregar', () => {
  const raiz = repoTemporario({ 'package.json': '{}' });
  try {
    orquestra(raiz, 'instalar');
    const marcador = path.join(raiz, 'terminou.json');
    const contador = path.join(raiz, 'passos.txt');
    const env = { ...process.env, ORQUESTRA_WORKER: '1', ORQUESTRA_SENTINELA: marcador, ORQUESTRA_LIMITE_PASSOS: '2', ORQUESTRA_CONTADOR: contador };
    const chamar = (entrada) => JSON.parse(spawnSync(process.execPath, ['hooks/guarda.mjs'], { cwd: path.join(raiz, '.agents'), input: JSON.stringify({ workspacePaths: [raiz], ...entrada }), encoding: 'utf8', env }).stdout);
    const ler = { hookEventName: 'PreToolUse', toolCall: { name: 'view_file', args: { AbsolutePath: path.join(raiz, 'a.txt') } } };
    assert.equal(chamar(ler).decision, 'allow');
    assert.equal(chamar(ler).decision, 'allow');
    const terceira = chamar(ler);
    assert.equal(terceira.decision, 'deny');
    assert.match(terceira.reason, /Limite de 2 passos/);
    assert.notEqual(chamar({ hookEventName: 'PreToolUse', toolCall: { name: 'finish', args: {} } }).decision, 'deny', 'entregar a resposta sempre passa');
    const stop = chamar({ hookEventName: 'Stop', terminationReason: 'model_stop', fullyIdle: true });
    assert.equal(stop.decision, 'stop');
    assert.equal(JSON.parse(fs.readFileSync(marcador, 'utf8')).motivo, 'model_stop');
  } finally {
    apagar(raiz);
  }
});
