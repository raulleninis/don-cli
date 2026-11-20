#!/usr/bin/env node
// don — hook PreToolUse do agy (Antigravity CLI): impede escrita em caminho RESERVADO
// (.githooks/don.json) e fora da área de trabalho. Ferramentas de leitura passam. É a
// primeira barreira; a definitiva é a checagem do diff no delegador e o pre-commit do git.
// Vale também para os workers de um /swarm (testado).
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { CONFIG, RESERVADOS, motivo, normalizar } from '../../.githooks/caminhos.mjs';

// Sem terminal (agy -p), `ask` vira negação e o worker termina sem resposta. Comandos que começam
// por um prefixo de `agy.comandos` (testes, lint) e não encadeiam nada recebem `auto_approve` e
// continuam no sandbox do agy.
const PERMITIDOS = (CONFIG.agy?.comandos ?? []).map((p) => normalizar(p).trim()).filter(Boolean);
const ENCADEIA = /[;&|<>`]|\$\(|\r|\n/;
const permitido = (cmd) =>
  !ENCADEIA.test(cmd) && PERMITIDOS.some((p) => cmd === p || cmd.startsWith(p.endsWith('/') ? p : `${p} `));

const LEITURA = /^(?:read|view|list|grep|find|search|codebase|glob)/i;
const CHAVE_DE_CAMINHO = /(?:path|file|uri|dir)/i;
const ESCRITA_NO_SHELL =
  /(?:>|\brm\b|\bdel\b|\bmv\b|\bmove\b|\bcp\b|\bcopy\b|sed\s+-i|set-content|add-content|out-file|remove-item|new-item|git\s+(?:checkout|restore|apply|rm|mv|commit|config))/i;

function responder(decisao, razao) {
  process.stdout.write(JSON.stringify(razao ? { decision: decisao, reason: razao } : { decision: decisao }));
  process.exit(0);
}

function relativo(raiz, alvo) {
  const texto = normalizar(alvo).replace(/^file:\/\/\/?/i, '');
  const absoluto = path.isAbsolute(texto) ? texto : path.resolve(raiz, texto);
  return normalizar(path.relative(raiz, absoluto));
}

let bruto = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (c) => (bruto += c));
process.stdin.on('end', () => {
  let entrada;
  try {
    entrada = JSON.parse(bruto || '{}');
  } catch {
    responder('deny', 'don: entrada do hook ilegível.');
  }
  // Evento Stop: sentinela de conclusão para o don (o processo deveria sair logo depois).
  if (entrada.hookEventName === 'Stop') {
    if (process.env.DON_SENTINELA) {
      try {
        fs.writeFileSync(process.env.DON_SENTINELA, JSON.stringify({
          quando: new Date().toISOString(), motivo: entrada.terminationReason ?? null, ocioso: entrada.fullyIdle ?? null,
        }));
      } catch {
        /* sem marcador, valem os outros limites */
      }
    }
    responder('stop');
  }

  const nome = String(entrada.toolCall?.name ?? '');
  // Limite de passos (contra loop): passou do teto, só a entrega da resposta final passa.
  if (process.env.DON_LIMITE_PASSOS && process.env.DON_CONTADOR) {
    let passos = 0;
    try {
      passos = Number(fs.readFileSync(process.env.DON_CONTADOR, 'utf8')) || 0;
    } catch {
      /* primeiro passo */
    }
    passos += 1;
    try {
      fs.writeFileSync(process.env.DON_CONTADOR, String(passos));
    } catch {
      /* segue sem contar */
    }
    if (passos > Number(process.env.DON_LIMITE_PASSOS) && !/^(?:finish|final|submit|respond)/i.test(nome)) {
      responder('deny', `Limite de ${process.env.DON_LIMITE_PASSOS} passos atingido. Pare agora e entregue a resposta final com o que tem, registrando o que faltou.`);
    }
  }
  // O agy às vezes entrega cada argumento como string JSON (com aspas): desembrulha.
  const args = Object.fromEntries(
    Object.entries(entrada.toolCall?.args ?? {}).map(([k, v]) => {
      if (typeof v === 'string' && /^".*"$/s.test(v)) {
        try {
          return [k, JSON.parse(v)];
        } catch {
          /* fica como veio */
        }
      }
      return [k, v];
    }),
  );
  if (process.env.DON_GUARDA_LOG) {
    fs.appendFileSync(process.env.DON_GUARDA_LOG, `${JSON.stringify({ nome, args })}\n`);
  }
  const raiz = entrada.workspacePaths?.[0] ?? entrada.cwd ?? process.cwd();
  if (LEITURA.test(nome)) responder('allow');

  const candidatos = [];
  for (const [chave, valor] of Object.entries(args)) {
    if (typeof valor === 'string' && CHAVE_DE_CAMINHO.test(chave)) candidatos.push(valor);
  }
  for (const valor of Object.values(args)) {
    if (typeof valor !== 'string') continue;
    for (const [, arquivo, destino] of valor.matchAll(/^\*\*\* (?:Add|Update|Delete) File: (.+)$|^\*\*\* Move to: (.+)$/gm)) {
      if (arquivo ?? destino) candidatos.push((arquivo ?? destino).trim());
    }
  }
  for (const alvo of candidatos) {
    const rel = relativo(raiz, alvo);
    if (rel === '..' || rel.startsWith('../') || path.isAbsolute(rel)) {
      responder('deny', `Bloqueado pelo don: ${normalizar(alvo)} fica fora da área de trabalho.`);
    }
    const porque = motivo(rel, RESERVADOS);
    if (porque) responder('deny', `Bloqueado pelo don: ${rel}. ${porque}`);
  }

  const comando = typeof args.CommandLine === 'string' ? normalizar(args.CommandLine) : '';
  if (comando && ESCRITA_NO_SHELL.test(comando)) {
    for (const [re, porque] of RESERVADOS) {
      const solto = new RegExp(re.source.replace(/^\^/, '(?:^|[\\s"\'=/])'), 'i');
      if (solto.test(comando)) responder('deny', `Bloqueado pelo don: comando que escreve em área reservada. ${porque}`);
    }
  }
  // Comando da lista `agy.comandos`: `auto_approve` (docs/hooks: aprova o que a política padrão
  // perguntaria, respeitando as regras do usuário). `allow` NÃO aprova: só passa à política padrão,
  // que em `agy -p` nega. Worker do don (DON_SOLDATO=1): fora da lista, nega. Sessão
  // interativa: fora da lista, pergunta. Edição de arquivo fora das áreas reservadas segue o fluxo.
  if (comando) {
    if (permitido(comando.trim())) responder('auto_approve');
    if (process.env.DON_SOLDATO === '1') {
      responder('deny', `Bloqueado pelo don: comando fora de agy.comandos ou encadeado. Não contorne; registre em duvidas se precisar dele.`);
    }
    responder('ask');
  }
  responder('allow');
});
