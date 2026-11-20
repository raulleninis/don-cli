#!/usr/bin/env node
// Sentinela de conclusão. O Codex chama este script pelo `notify` ao fim de cada turno, passando um
// JSON como último argumento; o primeiro argumento é o arquivo marcador. A orquestra vê o marcador e,
// se o processo continuar vivo depois disso, encerra a árvore e segue (o resultado já está pronto).
import fs from 'node:fs';
import process from 'node:process';

const [marcador, ...resto] = process.argv.slice(2);
if (marcador) {
  try {
    fs.writeFileSync(marcador, JSON.stringify({ quando: new Date().toISOString(), payload: resto.at(-1) ?? null }));
  } catch {
    /* sem marcador, vale o limite de tempo */
  }
}
