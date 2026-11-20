import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import readline from 'node:readline';
import { after, before, test } from 'node:test';
import { motivoParaEscalar } from '../lib/delegar.mjs';
import { contarTokens } from '../lib/worker.mjs';
import { BIN } from './ajuda.mjs';

let pasta;
let servidor;
let linhas;
let id = 0;
const pendentes = new Map();

function chamar(method, params) {
  id += 1;
  servidor.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
  return new Promise((resolve) => pendentes.set(id, resolve));
}

before(() => {
  pasta = fs.mkdtempSync(path.join(os.tmpdir(), 'don-mcp-'));
  fs.mkdirSync(path.join(pasta, 'Ferramenta', 'cli'), { recursive: true });
  fs.writeFileSync(path.join(pasta, 'Ferramenta', 'sandbox.md'), '# Sandbox\nO sandbox bloqueia a rede por padrão.\nOutra linha.');
  fs.writeFileSync(path.join(pasta, 'Ferramenta', 'cli', 'flags.md'), '# Flags\n--sandbox liga o sandbox');
  fs.writeFileSync(path.join(pasta, 'segredo.txt'), 'não deve ser lido');
  servidor = spawn(process.execPath, [BIN, 'mcp-docs', '--pasta', path.join(pasta, 'Ferramenta')], { stdio: ['pipe', 'pipe', 'ignore'] });
  linhas = readline.createInterface({ input: servidor.stdout });
  linhas.on('line', (l) => {
    const msg = JSON.parse(l);
    pendentes.get(msg.id)?.(msg);
  });
});
after(() => {
  servidor.kill();
  fs.rmSync(pasta, { recursive: true, force: true });
});

test('mcp-docs: initialize, tools/list e as três ferramentas', async () => {
  const ini = await chamar('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } });
  assert.equal(ini.result.protocolVersion, '2025-06-18');
  assert.ok(ini.result.capabilities.tools);
  servidor.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
  const lista = await chamar('tools/list', {});
  assert.deepEqual(lista.result.tools.map((t) => t.name), ['docs_listar', 'docs_buscar', 'docs_ler']);

  const listar = await chamar('tools/call', { name: 'docs_listar', arguments: {} });
  assert.match(listar.result.content[0].text, /Ferramenta\/cli\/flags\.md/);
  assert.doesNotMatch(listar.result.content[0].text, /segredo/);

  const busca = await chamar('tools/call', { name: 'docs_buscar', arguments: { consulta: 'sandbox rede' } });
  assert.match(busca.result.content[0].text, /Ferramenta\/sandbox\.md:2: O sandbox bloqueia a rede/);
  const regex = await chamar('tools/call', { name: 'docs_buscar', arguments: { consulta: '/^--sandbox/' } });
  assert.match(regex.result.content[0].text, /flags\.md:2/);

  const ler = await chamar('tools/call', { name: 'docs_ler', arguments: { arquivo: 'Ferramenta/sandbox.md', de: 2, ate: 2 } });
  assert.match(ler.result.content[0].text, /^Ferramenta\/sandbox\.md linhas 2-2 de 3:\n2\| O sandbox/);
});

test('mcp-docs: não lê fora da pasta', async () => {
  for (const arquivo of ['Ferramenta/../segredo.txt', 'Outra/x.md', '../segredo.txt']) {
    const r = await chamar('tools/call', { name: 'docs_ler', arguments: { arquivo } });
    assert.equal(r.result.isError, true, arquivo);
  }
  const desconhecida = await chamar('tools/call', { name: 'apagar', arguments: {} });
  assert.ok(desconhecida.error);
});

test('contarTokens: envelope do agy e log do Codex (com separador de milhar)', () => {
  assert.equal(contarTokens('agy', JSON.stringify({ status: 'SUCCESS', usage: { input_tokens: 10, total_tokens: 18424 } })), 18424);
  const log = path.join(pasta, 'codex.log');
  fs.writeFileSync(log, 'codex\n{"status":"x"}\ntokens used\n29.768\n');
  assert.equal(contarTokens('codex', '', log), 29768);
  assert.equal(contarTokens('codex', 'sem contagem', null), null);
});

test('escalonamento: escala em falha de capacidade, nunca em REJEITADO ou bloqueado', () => {
  const base = { codigo: 0, rejeitados: [], verificacao: [], resposta: { status: 'concluido' } };
  assert.equal(motivoParaEscalar(base), null);
  assert.match(motivoParaEscalar({ ...base, resposta: null }), /sem resposta/);
  assert.match(motivoParaEscalar({ ...base, resposta: { status: 'parcial' } }), /parcial/);
  assert.match(motivoParaEscalar({ ...base, verificacao: ['test FALHOU'] }), /verificação/);
  assert.match(motivoParaEscalar({ ...base, codigo: 1 }), /saída 1/);
  assert.equal(motivoParaEscalar({ ...base, rejeitados: [['src/crypto/x', 'x']] }), null);
  assert.equal(motivoParaEscalar({ ...base, resposta: { status: 'bloqueado' } }), null);
});

test('motorDoModelo: deduz o motor pelo nome do modelo', async () => {
  const { motorDoModelo } = await import('../lib/delegar.mjs');
  assert.equal(motorDoModelo('gpt-6-luna'), 'codex');
  assert.equal(motorDoModelo('gpt-6.2-astra'), 'codex');
  assert.equal(motorDoModelo('gemini-3.8-flash-low'), 'agy');
  assert.equal(motorDoModelo('claude-sonnet-4-6'), 'agy');
  assert.equal(motorDoModelo('gpt-oss-120b-medium'), 'agy');
  assert.equal(motorDoModelo(undefined), null);
});
