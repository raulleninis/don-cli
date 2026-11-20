// Monta um repositório git temporário com o don instalada, para os testes.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

export const BIN = fileURLToPath(new URL('../bin/don.mjs', import.meta.url));

export function repoTemporario(arquivos = {}) {
  const raiz = fs.mkdtempSync(path.join(os.tmpdir(), 'don-teste-'));
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: raiz });
  execFileSync('git', ['config', 'user.email', 'teste@exemplo.invalid'], { cwd: raiz });
  execFileSync('git', ['config', 'user.name', 'Teste'], { cwd: raiz });
  for (const [rel, conteudo] of Object.entries(arquivos)) {
    fs.mkdirSync(path.dirname(path.join(raiz, rel)), { recursive: true });
    fs.writeFileSync(path.join(raiz, rel), conteudo);
  }
  return raiz;
}

export function don(raiz, ...args) {
  return execFileSync(process.execPath, [BIN, ...args], { cwd: raiz, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

export function apagar(raiz) {
  fs.rmSync(raiz, { recursive: true, force: true });
}
