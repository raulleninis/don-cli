#!/usr/bin/env node
// don — trava comum a todos os agentes (Claude, Codex, agy) e a pessoas: recusa o commit
// que toca em caminho PROTEGIDO. Liberação humana: LIBERA_CAMINHO_PROTEGIDO=1 git commit ...
import { execFileSync } from 'node:child_process';
import console from 'node:console';
import process from 'node:process';
import { PROTEGIDOS, motivo } from './caminhos.mjs';

if (process.env.LIBERA_CAMINHO_PROTEGIDO === '1') process.exit(0);

const saida = execFileSync('git', ['diff', '--cached', '--name-only', '--no-renames', '-z'], {
  encoding: 'utf8',
});
const bloqueados = saida
  .split('\0')
  .filter(Boolean)
  .map((arquivo) => [arquivo, motivo(arquivo, PROTEGIDOS)])
  .filter(([, porque]) => porque);

if (bloqueados.length) {
  console.error('Commit recusado: caminho protegido no stage.');
  for (const [arquivo, porque] of bloqueados) console.error(`  ${arquivo}: ${porque}`);
  console.error('Se a mudança foi liberada, um humano faz: LIBERA_CAMINHO_PROTEGIDO=1 git commit ...');
  process.exit(1);
}
