import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { after, test } from 'node:test';
import { encerrarProcessosEm, matarArvore, WIN } from '../lib/processo.mjs';

const pastas = [];
after(() => pastas.forEach((p) => fs.rmSync(p, { recursive: true, force: true })));

const pasta = () => {
  const p = fs.mkdtempSync(path.join(os.tmpdir(), 'don-orfaos-'));
  pastas.push(p);
  return p;
};
const vivo = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
const esperar = async (cond, ms = 15_000) => {
  const fim = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > fim) throw new Error('tempo esgotado esperando a condição');
    await new Promise((r) => setTimeout(r, 100));
  }
};
// Pai que abre um neto eterno (cuja linha de comando não cita a pasta) e grava o pid dele.
const PAI = (sair) => `
const { spawn } = require('node:child_process');
const neto = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore', detached: ${sair} });
require('node:fs').writeFileSync(process.env.ARQ_NETO, String(neto.pid));
${sair ? 'setTimeout(() => process.exit(0), 200);' : 'setInterval(() => {}, 1000);'}`;

test('encerra o processo que cita a pasta e o neto que não cita', async () => {
  const dir = pasta();
  const arqNeto = path.join(dir, 'neto.pid');
  const desde = new Date(Date.now() - 2000);
  const pai = spawn(process.execPath, ['-e', PAI(false), path.join(dir, 'marca')], { stdio: 'ignore', env: { ...process.env, ARQ_NETO: arqNeto } });
  await esperar(() => fs.existsSync(arqNeto) && fs.readFileSync(arqNeto, 'utf8'));
  const neto = Number(fs.readFileSync(arqNeto, 'utf8'));
  try {
    assert.ok(encerrarProcessosEm(dir, desde) >= 2);
    await esperar(() => !vivo(pai.pid) && !vivo(neto));
  } finally {
    matarArvore(pai.pid);
    matarArvore(neto);
  }
});

test('órfão de pai morto sai pelo pid registrado', { skip: !WIN && 'fora do Windows o órfão é adotado pelo init' }, async () => {
  const dir = pasta();
  const arqNeto = path.join(dir, 'neto.pid');
  const desde = new Date(Date.now() - 2000);
  const pai = spawn(process.execPath, ['-e', PAI(true)], { stdio: 'ignore', env: { ...process.env, ARQ_NETO: arqNeto } });
  await esperar(() => fs.existsSync(arqNeto) && fs.readFileSync(arqNeto, 'utf8'));
  const neto = Number(fs.readFileSync(arqNeto, 'utf8'));
  await esperar(() => !vivo(pai.pid));
  try {
    assert.ok(vivo(neto), 'o neto ficou órfão');
    assert.equal(encerrarProcessosEm(dir, desde, [String(pai.pid)]), 1);
    await esperar(() => !vivo(neto));
  } finally {
    matarArvore(neto);
  }
});

test('pid registrado de processo mais antigo que a worktree não é encerrado (pid reaproveitado)', { skip: !WIN && 'só Windows usa os pids registrados' }, async () => {
  const antigo = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  try {
    await new Promise((r) => setTimeout(r, 1500));
    assert.equal(encerrarProcessosEm(pasta(), new Date(), [String(antigo.pid)]), 0);
    assert.ok(vivo(antigo.pid));
  } finally {
    matarArvore(antigo.pid);
  }
});
