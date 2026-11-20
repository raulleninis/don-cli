// Localiza o projeto-alvo e carrega a lista de caminhos e a configuração dele.
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';
import { git } from './processo.mjs';

export function raizDoProjeto(dir = process.cwd()) {
  try {
    return path.resolve(git(dir, 'rev-parse', '--show-toplevel'));
  } catch {
    throw new Error(`${dir} não está num repositório git.`);
  }
}

/** Importa o .githooks/caminhos.mjs do próprio projeto: a mesma lógica do pre-commit e do hook. */
export async function carregarProjeto(dir) {
  const raiz = raizDoProjeto(dir);
  const arquivo = path.join(raiz, '.githooks', 'caminhos.mjs');
  if (!fs.existsSync(arquivo)) throw new Error(`Don não instalado em ${raiz}. Rode: don instalar`);
  const caminhos = await import(pathToFileURL(arquivo).href);
  const config = caminhos.CONFIG;
  const nome = config.projeto && !config.projeto.includes('{{') ? config.projeto : path.basename(raiz);
  const pastaWorktrees = path.resolve(raiz, (config.worktrees ?? '../{projeto}-soldati').replace('{projeto}', nome));
  return { raiz, nome, config, caminhos, pastaWorktrees, pastaDon: path.join(raiz, '.don') };
}
