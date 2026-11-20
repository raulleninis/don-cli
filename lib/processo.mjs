// Execução de processos filhos com limite de tempo, log e ambiente seguro.
import { Buffer } from 'node:buffer';
import { execFileSync, spawn } from 'node:child_process';
import console from 'node:console';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { clearInterval, clearTimeout, setInterval, setTimeout } from 'node:timers';

export const WIN = process.platform === 'win32';

// Dependências da worktree são junctions para as do projeto. O pnpm 11 confere as dependências
// antes de cada script e, estranhando a junction, tenta APAGAR o node_modules para reinstalar —
// o que, pela junction, apagaria o do projeto. Desligado para todo processo que o don inicia.
export const ENV = {
  ...process.env,
  npm_config_verify_deps_before_run: 'false',
  pnpm_config_verify_deps_before_run: 'false',
  npm_config_confirm_modules_purge: 'true',
  pnpm_config_confirm_modules_purge: 'true',
};

/**
 * Ambiente de um worker do agy, lido pelo hook .agents/hooks/guarda.mjs:
 * - DON_SOLDATO=1: aplica a lista de comandos permitidos (fora dela, nega);
 * - DON_GUARDA_LOG: uma linha por ferramenta chamada (diagnóstico e vigia de inatividade);
 * - DON_LIMITE_PASSOS + DON_CONTADOR: passou do limite de ferramentas, nega tudo
 *   menos a entrega da resposta (contra loop);
 * - DON_SENTINELA: o evento Stop grava esse arquivo ao terminar.
 * Aceita uma string (só o log, forma antiga) ou um objeto com esses campos.
 */
export function envDoWorker(opcoes = {}) {
  const o = typeof opcoes === 'string' ? { log: opcoes } : opcoes;
  return {
    ...ENV,
    DON_SOLDATO: '1',
    ...(o.log ? { DON_GUARDA_LOG: o.log } : {}),
    ...(o.limitePassos && o.contador ? { DON_LIMITE_PASSOS: String(o.limitePassos), DON_CONTADOR: o.contador } : {}),
    ...(o.sentinela ? { DON_SENTINELA: o.sentinela } : {}),
  };
}

export const git = (cwd, ...args) =>
  execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

/** No Windows o codex do npm é um shim .cmd; roda o codex.js direto pelo Node, sem shell. */
function resolverCodex() {
  if (!WIN) return null;
  const candidatos = [
    path.join(process.env.APPDATA ?? '', 'npm', 'node_modules', '@openai', 'codex', 'bin', 'codex.js'),
  ];
  return candidatos.find((c) => fs.existsSync(c)) ?? null;
}
const CODEX_JS = resolverCodex();


/** Mais recente data de modificação entre os arquivos que existem (0 se nenhum). */
function ultimaAtividade(arquivos) {
  let ultima = 0;
  for (const a of arquivos) {
    try {
      ultima = Math.max(ultima, fs.statSync(a).mtimeMs);
    } catch {
      /* ainda não existe */
    }
  }
  return ultima;
}

/**
 * Roda `comando args` em `cwd`. `comando` pode ser 'codex', 'agy', 'node' (vira o Node atual) ou um
 * caminho relativo à `cwd`. O prompt vai pelo stdin quando `entrada` é dada. Nunca usa shell com
 * argumento variável.
 *
 * Contra ficar preso, três vigias encerram a árvore de processos:
 * - `minutos`: tempo total;
 * - `inativo` (minutos) sobre `vigiar` (arquivos que crescem enquanto o worker trabalha: log, log
 *   do hook): nada mudou nesse tempo → trava silenciosa;
 * - `sentinela`: arquivo que o worker grava ao terminar (notify do Codex, Stop do agy). Se o
 *   processo seguir vivo 20 s depois, o resultado já está pronto: encerra e conclui.
 * O resultado diz em `interrompido` qual vigia agiu (ou null).
 */
export function rodar(comando, args, { cwd, entrada, log, minutos = 10, env = ENV, vigiar = [], inativo = null, sentinela = null, esperaSentinela = 20_000 }) {
  return new Promise((resolve) => {
    let exe = comando;
    let lista = args;
    let shell = false;
    if (comando === 'node') exe = process.execPath;
    else if (comando === 'codex' && CODEX_JS) [exe, lista] = [process.execPath, [CODEX_JS, ...args]];
    else if (comando === 'agy' && WIN) exe = 'agy.exe';
    else if (/[\\/]/.test(comando)) exe = path.resolve(cwd, comando);
    else if (WIN) {
      // Outro shim .cmd (pnpm, npx...): só com argumentos simples, fixos da configuração.
      if (args.some((a) => /[\s"&|<>^%]/.test(a))) {
        resolve({ codigo: -1, texto: `Argumento inseguro para o shell em ${comando}.`, interrompido: null });
        return;
      }
      [exe, lista, shell] = [[comando, ...args].join(' '), [], true];
    }

    const inicio = Date.now();
    const filho = spawn(exe, lista, { cwd, env, shell, windowsHide: true });
    const rastro = (evento) => {
      if (process.env.DON_DEBUG) console.error(`[don ${new Date().toISOString().slice(11, 19)}] ${path.basename(String(exe))} pid=${filho.pid} ${evento}`);
    };
    rastro('iniciou');
    for (const ev of ['exit', 'close', 'error']) filho.on(ev, (a, b) => rastro(`${ev} ${a ?? ''} ${b ?? ''}`));

    const saida = [];
    let terminou = false;
    let interrompido = null;
    const derrubar = (motivo) => {
      if (terminou || interrompido) return;
      interrompido = motivo;
      rastro(`interrompido: ${motivo}`);
      if (WIN) spawn('taskkill', ['/pid', String(filho.pid), '/T', '/F'], { windowsHide: true });
      else filho.kill('SIGTERM');
      // Se nem assim o 'exit' vier, conclui mesmo assim.
      setTimeout(() => concluir(null), 10_000).unref();
    };
    const limite = setTimeout(() => derrubar(`tempo total de ${minutos} min`), minutos * 60_000);
    let sentinelaVistaEm = null;
    const vigia = setInterval(() => {
      if (sentinela && !sentinelaVistaEm && fs.existsSync(sentinela)) sentinelaVistaEm = Date.now();
      if (sentinelaVistaEm && Date.now() - sentinelaVistaEm > esperaSentinela) derrubar('terminou (sentinela) mas o processo não saiu');
      if (inativo) {
        const ultima = Math.max(ultimaAtividade(log ? [log, ...vigiar] : vigiar), inicio);
        if (Date.now() - ultima > inativo * 60_000) derrubar(`sem atividade há ${inativo} min`);
      }
    }, Math.max(200, Math.min(5_000, (inativo ?? 1) * 60_000 / 4, esperaSentinela / 4)));

    const registrar = (b) => {
      saida.push(b);
      if (log) fs.appendFileSync(log, b);
    };
    filho.stdout.on('data', registrar);
    filho.stderr.on('data', registrar);
    filho.stdin.on('error', () => {});
    filho.stdin.end(entrada ?? undefined);
    function concluir(codigo) {
      if (terminou) return;
      terminou = true;
      clearTimeout(limite);
      clearInterval(vigia);
      resolve({ codigo, texto: Buffer.concat(saida).toString('utf8'), interrompido });
    }
    filho.on('close', concluir);
    // Um neto (ex.: terminal persistente que o agy abriu) pode herdar o stdout e segurar o 'close'
    // para sempre. Quando o processo principal sai, espera 2 s pelo resto da saída e conclui.
    filho.on('exit', (codigo) => {
      setTimeout(() => {
        if (terminou) return;
        if (WIN) spawn('taskkill', ['/pid', String(filho.pid), '/T', '/F'], { windowsHide: true });
        filho.stdout.destroy();
        filho.stderr.destroy();
        concluir(codigo);
      }, 2000);
    });
    filho.on('error', (erro) => {
      saida.push(Buffer.from(String(erro)));
      concluir(-1);
    });
  });
}
