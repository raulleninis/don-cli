// Execução de processos filhos com limite de tempo, log e ambiente seguro.
import { Buffer } from 'node:buffer';
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { clearTimeout, setTimeout } from 'node:timers';

export const WIN = process.platform === 'win32';

// Dependências da worktree são junctions para as do projeto. O pnpm 11 confere as dependências
// antes de cada script e, estranhando a junction, tenta APAGAR o node_modules para reinstalar —
// o que, pela junction, apagaria o do projeto. Desligado para todo processo que a orquestra inicia.
export const ENV = {
  ...process.env,
  npm_config_verify_deps_before_run: 'false',
  pnpm_config_verify_deps_before_run: 'false',
  npm_config_confirm_modules_purge: 'true',
  pnpm_config_confirm_modules_purge: 'true',
};

/**
 * Ambiente de um worker: o seguro, a marca ORQUESTRA_WORKER (o hook do agy aplica a lista de
 * comandos permitidos) e o log do hook, para diagnóstico.
 */
export function envDoWorker(logDoHook) {
  return { ...ENV, ORQUESTRA_WORKER: '1', ...(logDoHook ? { ORQUESTRA_GUARDA_LOG: logDoHook } : {}) };
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

/**
 * Roda `comando args` em `cwd`. `comando` pode ser 'codex', 'agy', 'node' (vira o Node atual) ou um
 * caminho relativo à `cwd`. O prompt vai pelo stdin quando `entrada` é dada. Nunca usa shell com
 * argumento variável.
 */
export function rodar(comando, args, { cwd, entrada, log, minutos = 10, env = ENV }) {
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
        resolve({ codigo: -1, texto: `Argumento inseguro para o shell em ${comando}.` });
        return;
      }
      [exe, lista, shell] = [[comando, ...args].join(' '), [], true];
    }

    const filho = spawn(exe, lista, { cwd, env, shell, windowsHide: true });
    const saida = [];
    const limite = setTimeout(() => {
      if (WIN) spawn('taskkill', ['/pid', String(filho.pid), '/T', '/F']);
      else filho.kill('SIGTERM');
    }, minutos * 60_000);
    const registrar = (b) => {
      saida.push(b);
      if (log) fs.appendFileSync(log, b);
    };
    filho.stdout.on('data', registrar);
    filho.stderr.on('data', registrar);
    filho.stdin.on('error', () => {});
    filho.stdin.end(entrada ?? undefined);
    let terminou = false;
    const concluir = (codigo) => {
      if (terminou) return;
      terminou = true;
      clearTimeout(limite);
      resolve({ codigo, texto: Buffer.concat(saida).toString('utf8') });
    };
    filho.on('close', concluir);
    // Um neto (ex.: terminal persistente que o agy abriu) pode herdar o stdout e segurar o 'close'
    // para sempre. Quando o processo principal sai, espera 2 s pelo resto da saída e conclui; se
    // ainda houver netos vivos, encerra a árvore.
    filho.on('exit', (codigo) => {
      setTimeout(() => {
        if (terminou) return;
        if (WIN) spawn('taskkill', ['/pid', String(filho.pid), '/T', '/F']);
        filho.stdout.destroy();
        filho.stderr.destroy();
        concluir(codigo);
      }, 2000);
    });
    filho.on('error', (erro) => {
      if (terminou) return;
      terminou = true;
      clearTimeout(limite);
      resolve({ codigo: -1, texto: String(erro) });
    });
  });
}
