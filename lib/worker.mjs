// Roda um worker (Codex ou agy) com o sandbox certo, pede saída num esquema JSON e mede tokens.
import fs from 'node:fs';
import process from 'node:process';
import path from 'node:path';
import { codexConfiaNoProjeto } from './codex.mjs';
import { envDoWorker, rodar } from './processo.mjs';
import { acharPor } from './resposta.mjs';

export const PADRAO = {
  codex: { modelo: 'gpt-6.2-sol', esforco: 'high', perfil: null, escada: ['gpt-6-luna', 'gpt-6.2-sol', 'gpt-6.2-astra'] },
  agy: { modelo: 'gemini-3.8-flash-high', esforco: null, escada: ['gemini-3.8-flash-high', 'claude-sonnet-4-6', 'claude-opus-4-6-thinking'] },
};

/**
 * Ajustes de isolamento para todo worker do Codex (docs: config_reference):
 * - shell_environment_policy.ignore_default_excludes vem `true` por padrão e MANTÉM variáveis com
 *   KEY/SECRET/TOKEN no ambiente dos comandos; `false` aplica a exclusão automática.
 * - memórias: o worker não grava memórias a partir da tarefa nem usa as de outros trabalhos.
 * - apps (conectores do usuário, ex. e-mail e drive) ficam fora do alcance do worker.
 */
export const CODEX_ISOLADO = [
  // Sem terminal não há quem aprove: com "never", tudo roda dentro do sandbox e nada pede para sair
  // dele (docs: agent_subagents.md, "In non-interactive flows... fails"). Mais restritivo, não menos.
  '-c', 'approval_policy="never"',
  '-c', 'shell_environment_policy.ignore_default_excludes=false',
  '-c', 'memories.generate_memories=false',
  '-c', 'memories.use_memories=false',
  '-c', 'features.apps=false',
];

/**
 * No Windows, o sandbox padrão do Codex (token restrito, sem elevação) não consegue iniciar o
 * pwsh.exe de WindowsApps (CreateProcessAsUserW: acesso negado) e o worker fica sem shell. O modo
 * "elevated" resolve, mas exige a configuração inicial do sandbox do Codex na máquina.
 * Padrão: não força (vale o config do Codex; o perfil-codex sugere elevated). `codex.sandbox_windows`
 * no orquestra.json força um modo. Testado: numa pasta dentro de %TEMP% nem o elevated abriu o shell.
 */
export function codexWindows(conf) {
  if (process.platform !== 'win32') return [];
  const modo = conf?.sandbox_windows ?? null;
  return modo ? ['-c', `windows.sandbox="${modo}"`] : [];
}

export const configDoMotor = (projeto, motor) => ({ ...PADRAO[motor], ...(projeto?.config?.[motor] ?? {}) });

/** Tokens gastos: o agy informa em `usage`; o Codex imprime "tokens used" no log. */
export function contarTokens(motor, texto, log) {
  if (motor === 'agy') {
    const uso = acharPor(texto, (v) => typeof v.total_tokens === 'number');
    return uso?.total_tokens ?? null;
  }
  const bruto = log && fs.existsSync(log) ? fs.readFileSync(log, 'utf8') : texto;
  const m = [...bruto.matchAll(/tokens used\s*\r?\n?\s*([\d.,\s]+)/gi)].at(-1);
  return m ? Number(m[1].replace(/\D/g, '')) || null : null;
}

/**
 * modo: 'escrita' | 'leitura'. `esquema` é o caminho do JSON Schema da resposta e `predicado`
 * reconhece a resposta dentro do que o worker devolveu.
 */
export async function executarWorker({ projeto, motor, modelo, esforco, modo, swarm, prompt, esquema, predicado, wt, saidas, minutos }) {
  const conf = configDoMotor(projeto, motor);
  const log = path.join(saidas, 'execucao.log');
  const ultima = path.join(saidas, 'resposta.txt');
  const avisos = [];
  fs.writeFileSync(path.join(saidas, 'prompt.md'), prompt);
  let r;
  if (motor === 'codex') {
    // Escrita usa o perfil do projeto (.codex/config.toml). `-s workspace-write` explícito passa
    // por cima do perfil e deixa o shell escrever em área reservada (visto em teste).
    // Leitura também roda em pasta descartável (worktree destacada ou pasta de fatias), então não usa
    // `-s read-only`: no Windows ele nega até abrir o shell, e o Codex lê arquivos pelo shell.
    let sandbox;
    if (conf.perfil && projeto && codexConfiaNoProjeto(projeto.raiz)) sandbox = ['-c', `default_permissions="${conf.perfil}"`];
    else if (modo === 'leitura') sandbox = ['-s', 'workspace-write'];
    else if (conf.perfil) sandbox = ['-c', `default_permissions="${conf.perfil}"`];
    else {
      sandbox = ['-s', 'workspace-write'];
      avisos.push('Codex sem perfil de permissões: só a checagem final do diff protege as áreas reservadas.');
    }
    const args = ['exec', '-C', wt, ...sandbox, ...CODEX_ISOLADO, ...codexWindows(conf), '-m', modelo, '--output-schema', esquema, '-o', ultima, '--color', 'never'];
    if (esforco) args.push('-c', `model_reasoning_effort=${esforco}`);
    args.push('-');
    r = await rodar('codex', args, { cwd: wt, entrada: prompt, log, minutos });
  } else {
    // Sem terminal, comando que pede permissão é negado sozinho ("soft-denied"). Quem aprova os
    // comandos de `agy.comandos` é o hook .agents/hooks/guarda.mjs (auto_approve); com
    // ORQUESTRA_WORKER=1 ele nega o resto. Nada de command(*) nem --dangerously-skip-permissions.
    const args = ['-p', (swarm ? '/swarm ' : '') + prompt, '--model', modelo, '--output-format', 'json',
      '--json-schema', esquema, '--mode', modo === 'leitura' ? 'plan' : 'accept-edits', '--sandbox'];
    if (esforco) args.push('--effort', esforco);
    r = await rodar('agy', args, { cwd: wt, log, minutos, env: envDoWorker(path.join(saidas, 'guarda.log')) });
    fs.writeFileSync(ultima, r.texto);
  }
  const texto = fs.existsSync(ultima) ? fs.readFileSync(ultima, 'utf8') : r.texto;
  return {
    codigo: r.codigo,
    texto,
    resposta: acharPor(texto, predicado),
    tokens: contarTokens(motor, r.texto, log),
    avisos,
  };
}
