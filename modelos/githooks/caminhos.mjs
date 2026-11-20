// orquestra — lista única de caminhos sensíveis do projeto.
// Usada pelo pre-commit do git, pelo hook do agy (.agents/hooks/guarda.mjs) e pelo delegador.
// A configuração do projeto fica em orquestra.json, ao lado deste arquivo. Os dois vivem em
// .githooks/, que é protegido: só mudam com intervenção humana.
//
// PROTEGIDOS: nenhum commit passa sem liberação humana (LIBERA_CAMINHO_PROTEGIDO=1).
// RESERVADOS: agentes externos (Codex, agy) nunca tocam. Inclui os PROTEGIDOS.
// LIBERADOS:  exceções que valem antes de tudo (ex.: .env.example).
//
// Padrões são globs relativos à raiz: `pasta/` casa a pasta e tudo dentro; `*` não cruza `/`;
// `**/` casa qualquer profundidade (inclusive nenhuma); `?` casa um caractere. Sem distinção
// de maiúsculas, por causa do Windows.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const AQUI = path.dirname(fileURLToPath(import.meta.url));

const SEMPRE_PROTEGIDOS = {
  '**/.env': 'Arquivos .env nunca entram no repositório nem são editados por agentes.',
  '**/.env.*': 'Arquivos .env nunca entram no repositório nem são editados por agentes.',
  '.githooks/': 'Os hooks do git e a lista de caminhos só mudam com intervenção humana.',
  '.claude/hooks/': 'Hooks de segurança do Claude só mudam com intervenção humana.',
  '.codex/hooks/': 'Hooks de segurança do Codex só mudam com intervenção humana.',
  '.codex/hooks.json': 'Hooks de segurança do Codex só mudam com intervenção humana.',
  '.agents/hooks/': 'Hooks de segurança do agy só mudam com intervenção humana.',
  '.agents/hooks.json': 'Hooks de segurança do agy só mudam com intervenção humana.',
};

const SEMPRE_RESERVADOS = {
  '.claude/': 'Configuração dos agentes não é editada por agente externo.',
  '.codex/': 'Configuração dos agentes não é editada por agente externo.',
  '.agents/': 'Configuração dos agentes não é editada por agente externo.',
  'AGENTS.md': 'Regras dos agentes não são editadas por agente externo.',
  'CLAUDE.md': 'Regras dos agentes não são editadas por agente externo.',
  'GEMINI.md': 'Regras dos agentes não são editadas por agente externo.',
  '.gitignore': 'O .gitignore protege o que não pode entrar no repositório.',
};

const SEMPRE_LIBERADOS = ['**/.env.example'];

export const CONFIG = JSON.parse(fs.readFileSync(path.join(AQUI, 'orquestra.json'), 'utf8'));

export function normalizar(caminho) {
  return String(caminho).replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+/g, '/');
}

export function globParaRegex(glob) {
  let g = normalizar(glob);
  const pasta = g.endsWith('/');
  if (pasta) g = g.slice(0, -1);
  let re = '';
  for (let i = 0; i < g.length; i++) {
    const c = g[i];
    if (c === '*' && g[i + 1] === '*' && g[i + 2] === '/') {
      re += '(?:.*/)?';
      i += 2;
    } else if (c === '*' && g[i + 1] === '*') {
      re += '.*';
      i += 1;
    } else if (c === '*') {
      re += '[^/]*';
    } else if (c === '?') {
      re += '[^/]';
    } else {
      re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    }
  }
  return new RegExp(`^${re}${pasta ? '(?:/|$)' : '$'}`, 'i');
}

const compilar = (mapa) => Object.entries(mapa).map(([glob, porque]) => [globParaRegex(glob), porque, glob]);

export const LIBERADOS = [...SEMPRE_LIBERADOS, ...(CONFIG.liberados ?? [])].map(globParaRegex);
export const PROTEGIDOS = compilar({ ...SEMPRE_PROTEGIDOS, ...(CONFIG.protegidos ?? {}) });
export const RESERVADOS = [...PROTEGIDOS, ...compilar({ ...SEMPRE_RESERVADOS, ...(CONFIG.reservados ?? {}) })];

/** Devolve o motivo do bloqueio, ou null. `lista` é PROTEGIDOS ou RESERVADOS. */
export function motivo(caminho, lista) {
  const rel = normalizar(caminho);
  if (LIBERADOS.some((re) => re.test(rel))) return null;
  return lista.find(([re]) => re.test(rel))?.[1] ?? null;
}
