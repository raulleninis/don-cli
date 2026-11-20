// Registro das CLIs que o don sabe usar. Acrescentar uma CLI = uma entrada aqui (detecção, instalação,
// documentação, modelos por perfil) + o ponto de integração em worker.mjs (como rodá-la sem terminal).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';

/** Soldati: as CLIs que executam ordens. */
export const MOTORES = {
  codex: {
    nome: 'Codex CLI (OpenAI)',
    binario: 'codex',
    instalar: { todos: 'npm install --global @openai/codex' },
    login: 'codex login',
    docs: { indice: 'https://learn.chatgpt.com/llms.txt', pasta: 'Codex' },
    perfis: {
      economia: { modelo: 'gpt-6-luna', esforco: 'low', escada: ['gpt-6-luna', 'gpt-6.2-sol'], limite_tokens: 200_000 },
      equilibrio: { modelo: 'gpt-6.2-sol', esforco: 'high', escada: ['gpt-6-luna', 'gpt-6.2-sol', 'gpt-6.2-astra'], limite_tokens: 400_000 },
      qualidade: { modelo: 'gpt-6.2-sol', esforco: 'high', escada: ['gpt-6.2-sol', 'gpt-6.2-astra'], limite_tokens: 800_000 },
    },
  },
  agy: {
    nome: 'Antigravity CLI (Google)',
    binario: 'agy',
    instalar: {
      win32: 'irm https://antigravity.google/cli/install.ps1 | iex',
      todos: 'curl -fsSL https://antigravity.google/cli/install.sh | bash',
    },
    login: 'agy  (a primeira execução abre o login no navegador)',
    docs: { indice: 'https://antigravity.google/llms.txt', pasta: 'Antigravity' },
    perfis: {
      economia: { modelo: 'gemini-3.8-flash-medium', escada: ['gemini-3.8-flash-medium', 'gemini-3.8-flash-high'], limite_passos: 100 },
      equilibrio: { modelo: 'gemini-3.8-flash-high', escada: ['gemini-3.8-flash-high', 'claude-sonnet-4-6', 'claude-opus-4-6-thinking'], limite_passos: 150 },
      qualidade: { modelo: 'gemini-3.8-flash-high', escada: ['gemini-3.8-flash-high', 'claude-sonnet-4-6', 'claude-opus-4-6-thinking'], limite_passos: 250 },
    },
  },
};

/** O don (orquestrador). Não executa ordens; entra na configuração pela documentação e pelo MCP. */
export const ORQUESTRADOR = {
  claude: {
    nome: 'Claude Code (Anthropic)',
    binario: 'claude',
    instalar: { win32: 'irm https://claude.ai/install.ps1 | iex', todos: 'curl -fsSL https://claude.ai/install.sh | bash' },
    docs: { indice: 'https://code.claude.com/llms.txt', pasta: 'ClaudeCode', filtro: '^/docs/en/' },
  },
};

export const PERFIS = ['economia', 'equilibrio', 'qualidade'];

export const comandoDeInstalacao = (entrada) => entrada.instalar[process.platform] ?? entrada.instalar.todos;

export const PASTA_DON = () => process.env.DON_HOME ?? path.join(os.homedir(), '.don');
const ARQ_MAQUINA = () => path.join(PASTA_DON(), 'config.json');

/** Configuração desta máquina (motores disponíveis), gravada pelo `don configurar`. */
export function configDaMaquina() {
  try {
    return JSON.parse(fs.readFileSync(ARQ_MAQUINA(), 'utf8'));
  } catch {
    return {};
  }
}

export function salvarConfigDaMaquina(dados) {
  fs.mkdirSync(PASTA_DON(), { recursive: true });
  fs.writeFileSync(ARQ_MAQUINA(), `${JSON.stringify({ ...configDaMaquina(), ...dados, atualizado: new Date().toISOString() }, null, 2)}\n`);
}

/** Motores ativos: os do projeto (don.json), senão os da máquina, senão todos os conhecidos. */
export function motoresAtivos(projeto) {
  return projeto?.config?.motores ?? configDaMaquina().motores ?? Object.keys(MOTORES);
}

/** O motor preferido se estiver ativo; senão, o primeiro ativo. */
export function motorPadrao(projeto, preferido) {
  const ativos = motoresAtivos(projeto);
  if (!ativos.length) throw new Error('Nenhuma CLI de execução ativa. Rode: don configurar');
  return ativos.includes(preferido) ? preferido : ativos[0];
}

export function exigirMotorAtivo(projeto, motor) {
  const ativos = motoresAtivos(projeto);
  if (!ativos.includes(motor)) {
    throw new Error(`O motor "${motor}" não está ativo ${projeto?.config?.motores ? 'neste projeto' : 'nesta máquina'} (ativos: ${ativos.join(', ') || 'nenhum'}). Rode: don configurar`);
  }
}
