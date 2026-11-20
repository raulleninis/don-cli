// O Codex só carrega o .codex/config.toml do projeto (e, com ele, o perfil de permissões) se o
// projeto for confiável. Worktrees herdam a confiança do repositório principal (o Codex resolve
// pelo commondir do git). Sem confiança, `default_permissions` aborta: falha fechada.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';

const normalizar = (p) => path.resolve(p).replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();

export function arquivoDeConfigDoCodex() {
  return path.join(process.env.CODEX_HOME ?? path.join(os.homedir(), '.codex'), 'config.toml');
}

export function codexConfiaNoProjeto(raiz) {
  const arquivo = arquivoDeConfigDoCodex();
  if (!fs.existsSync(arquivo)) return false;
  const alvo = normalizar(raiz);
  let atual = null;
  for (const linha of fs.readFileSync(arquivo, 'utf8').split(/\r?\n/)) {
    const secao = /^\s*\[projects\.(?:'([^']+)'|"((?:[^"\\]|\\.)+)")\]\s*$/.exec(linha);
    if (secao) {
      const bruto = secao[1] ?? secao[2].replace(/\\\\/g, '\\');
      atual = normalizar(bruto);
      continue;
    }
    if (/^\s*\[/.test(linha)) atual = null;
    else if (atual === alvo && /^\s*trust_level\s*=\s*"trusted"/.test(linha)) return true;
  }
  return false;
}

export const COMO_CONFIAR = (raiz) =>
  `Abra o Codex uma vez no projeto e aceite confiar nele (codex, na pasta ${raiz}), ou acrescente em ` +
  `${arquivoDeConfigDoCodex()}:\n  [projects.'${raiz}']\n  trust_level = "trusted"`;
