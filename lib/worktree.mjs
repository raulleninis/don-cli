// Worktrees descartáveis e as junctions de dependências que elas usam.
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { git } from './processo.mjs';

const LOCKS = ['pnpm-lock.yaml', 'package-lock.json', 'yarn.lock', 'bun.lockb', 'uv.lock', 'poetry.lock', 'Cargo.lock'];

/** Desfaz as junctions antes de qualquer remoção, para nunca apagar as dependências do projeto. */
export function soltarLinks(projeto, wt) {
  for (const nome of projeto.config.links ?? []) {
    const alvo = path.join(wt, nome);
    try {
      if (fs.lstatSync(alvo).isSymbolicLink()) fs.unlinkSync(alvo);
    } catch {
      /* não existe */
    }
  }
}

function prenderLinks(projeto, wt, base) {
  const links = (projeto.config.links ?? []).filter((nome) => fs.existsSync(path.join(projeto.raiz, nome)));
  if (!links.length) return;
  const mudou = git(projeto.raiz, 'diff', '--name-only', base, 'HEAD', '--', ...LOCKS);
  if (mudou) throw new Error(`A base tem outro lockfile (${mudou}); delegue a partir do HEAD.`);
  const exclude = path.resolve(projeto.raiz, git(projeto.raiz, 'rev-parse', '--git-common-dir'), 'info', 'exclude');
  const atual = fs.existsSync(exclude) ? fs.readFileSync(exclude, 'utf8') : '';
  for (const nome of links) {
    fs.symlinkSync(path.join(projeto.raiz, nome), path.join(wt, nome), 'junction');
    // `pasta/` no .gitignore só casa diretório; a junction precisa do exclude local.
    const linha = `/${nome.replace(/\\/g, '/')}`;
    if (!atual.split(/\r?\n/).includes(linha)) fs.appendFileSync(exclude, `\n${linha}\n`);
  }
}

/** Cria a worktree: com branch própria (escrita, com junctions) ou destacada (leitura). */
export function criarWorktree(projeto, slug, ref, { escrita }) {
  fs.mkdirSync(projeto.pastaWorktrees, { recursive: true });
  const wt = path.join(projeto.pastaWorktrees, slug);
  const branch = `soldato/${slug}`;
  if (escrita) git(projeto.raiz, 'worktree', 'add', '-q', '-b', branch, wt, ref);
  else git(projeto.raiz, 'worktree', 'add', '-q', '--detach', wt, ref);
  if (escrita) {
    try {
      prenderLinks(projeto, wt, ref);
    } catch (erro) {
      removerWorktree(projeto, wt, branch);
      throw erro;
    }
  }
  return { wt, branch };
}

/**
 * Remove a worktree. O sandbox do Codex no Windows pode prender a pasta por alguns instantes: tenta
 * de novo e, se não der, avisa em vez de derrubar o resultado (sobra para `don limpar`).
 */
export function removerWorktree(projeto, wt, branch) {
  if (fs.existsSync(wt)) {
    soltarLinks(projeto, wt);
    let erro = null;
    for (let t = 0; t < 4; t++) {
      try {
        git(projeto.raiz, 'worktree', 'remove', '--force', wt);
        erro = null;
        break;
      } catch (e) {
        erro = e;
        if (!fs.existsSync(path.join(wt, '.git'))) {
          // O git já desfez o registro; falta só a pasta.
          try {
            fs.rmSync(wt, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
            erro = null;
            break;
          } catch (e2) {
            erro = e2;
          }
        }
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1000);
      }
    }
    try {
      git(projeto.raiz, 'worktree', 'prune');
    } catch {
      /* nada a podar */
    }
    if (erro) process.emitWarning(`Não consegui remover ${wt} agora (${String(erro.message).split('\n')[0]}). Rode \`don limpar\` depois.`);
  }
  if (branch) {
    try {
      git(projeto.raiz, 'branch', '-D', branch);
    } catch {
      /* branch já não existe */
    }
  }
}
