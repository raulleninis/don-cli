// don configurar: configuração inicial guiada, por máquina e por projeto. Detecta o ambiente, faz
// poucas perguntas (todas com padrão) e grava: CLIs ativas (máquina e projeto), perfil de custo,
// sensibilidade (lealdade), áreas protegidas, integração com Claude/Codex/agy, documentação local,
// MCP consigliere e teste de lealdade. Sem terminal: --sim (aceita os padrões) ou --respostas <json>.
import console from 'node:console';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import readline from 'node:readline/promises';
import { fileURLToPath } from 'node:url';
import { codexConfiaNoProjeto, arquivoDeConfigDoCodex } from './codex.mjs';
import { COMANDO, instalar, perfilCodex } from './instalar.mjs';
import { MOTORES, ORQUESTRADOR, PASTA_DON, PERFIS, comandoDeInstalacao, salvarConfigDaMaquina } from './motores.mjs';
import { rodar } from './processo.mjs';
import { carregarProjeto, raizDoProjeto } from './projeto.mjs';

const PACOTE = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const MODELOS = path.join(PACOTE, 'modelos');
const ROTULO_PERFIL = { economia: 'economia (modelos baratos, escala pouco)', equilibrio: 'equilíbrio (padrão)', qualidade: 'qualidade (começa mais forte, escala até o topo)' };

// ---------------------------------------------------------------- partes puras (testadas)

export function tipoDoProjeto(raiz) {
  if (fs.existsSync(path.join(raiz, 'package.json'))) return 'node';
  if (['pyproject.toml', 'requirements.txt', 'setup.py'].some((f) => fs.existsSync(path.join(raiz, f)))) return 'python';
  return 'vazio';
}

/** Pastas com cara de território sensível, só como sugestão (nada é protegido sem confirmação). */
export function sugerirProtegidos(raiz) {
  const sensiveis = /^(?:crypto|cripto|secrets?|segredos?|auth|keys?|chaves?|migrations?|migracoes|billing|payments?|pagamentos?|infra)$/i;
  const achados = [];
  const visitar = (dir, prof) => {
    if (prof > 2) return;
    let itens = [];
    try {
      itens = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const it of itens) {
      if (!it.isDirectory() || it.name.startsWith('.') || ['node_modules', 'dist', 'build', '.venv', 'vendor'].includes(it.name)) continue;
      const rel = path.relative(raiz, path.join(dir, it.name)).replace(/\\/g, '/');
      if (sensiveis.test(it.name)) achados.push(`${rel}/`);
      else visitar(path.join(dir, it.name), prof + 1);
    }
  };
  visitar(raiz, 0);
  return achados.slice(0, 8);
}

/** Monta o don.json a partir do modelo do tipo de projeto e das respostas. */
export function montarConfiguracao({ tipo, nome, motores, perfil, sensivel, protegidos = [], base = null }) {
  const modelo = base ?? JSON.parse(fs.readFileSync(path.join(MODELOS, 'githooks', `don.${tipo}.json`), 'utf8'));
  const c = JSON.parse(JSON.stringify(modelo));
  c.projeto = nome;
  c.motores = motores;
  c.perfil = perfil;
  c.lealdade = sensivel ? 'exigir' : 'aviso';
  c.protegidos = { ...(c.protegidos ?? {}) };
  for (const p of protegidos) c.protegidos[p] = c.protegidos[p] ?? 'Área protegida do projeto (don configurar).';
  for (const m of motores) c[m] = { ...(c[m] ?? {}), ...(MOTORES[m]?.perfis?.[perfil] ?? {}) };
  // ordem estável e legível no arquivo
  const ordem = ['projeto', 'motores', 'perfil', 'lealdade', 'protegidos', 'reservados', 'liberados', 'segredos', 'worktrees', 'links', 'verificacao'];
  return Object.fromEntries([...ordem.filter((k) => k in c).map((k) => [k, c[k]]), ...Object.entries(c).filter(([k]) => !ordem.includes(k))]);
}

/** Une as permissões do don às de um .claude/settings.json existente, sem perder nada. */
export function mesclarSettings(atual, nosso) {
  const r = { ...atual, permissions: { ...(atual.permissions ?? {}) } };
  if (!r.model && nosso.model) r.model = nosso.model;
  for (const tipo of ['allow', 'ask', 'deny']) {
    const lista = [...(atual.permissions?.[tipo] ?? [])];
    for (const regra of nosso.permissions?.[tipo] ?? []) if (!lista.includes(regra)) lista.push(regra);
    if (lista.length) r.permissions[tipo] = lista;
  }
  return r;
}

export function comTrechoAgents(atual, trecho) {
  if (atual.includes('## Agentes neste projeto (don)')) return atual;
  return `${atual.trimEnd()}${atual.trim() ? '\n\n' : ''}${trecho.trim()}\n`;
}

export function comImportClaude(atual) {
  if (/^@AGENTS\.md\s*$/m.test(atual)) return atual;
  return `@AGENTS.md\n${atual.trim() ? `\n${atual.trimStart()}` : ''}`;
}

// ---------------------------------------------------------------- perguntas

function criarPerguntador(o) {
  let respostas = null;
  if (o.respostas) respostas = JSON.parse(fs.readFileSync(path.resolve(o.respostas), 'utf8'));
  const automatico = !!o.sim || !!respostas || !process.stdin.isTTY;
  const rl = automatico ? null : readline.createInterface({ input: process.stdin, output: process.stdout });
  const pergunta = async (chave, texto, padrao, converter = (v) => v) => {
    if (automatico) {
      const v = respostas && chave in respostas ? respostas[chave] : padrao;
      console.log(`? ${texto} → ${Array.isArray(v) ? v.join(', ') || '(nenhuma)' : v}`);
      return v;
    }
    const mostrado = Array.isArray(padrao) ? padrao.join(', ') : padrao;
    const bruto = (await rl.question(`? ${texto} [${mostrado}]: `)).trim();
    return bruto ? converter(bruto) : padrao;
  };
  const simNao = (chave, texto, padrao) =>
    pergunta(chave, `${texto} (s/n)`, padrao ? 's' : 'n').then((v) => v === true || /^s/i.test(String(v)));
  return { pergunta, simNao, fechar: () => rl?.close(), automatico };
}

async function versao(binario) {
  const r = await rodar(binario, ['--version'], { cwd: os.homedir(), minutos: 1 });
  return r.codigo === 0 ? r.texto.trim().split('\n').pop().trim() : null;
}

// ---------------------------------------------------------------- fluxo

export async function configurar(dir, o = {}) {
  const raiz = raizDoProjeto(dir ?? process.cwd());
  const nome = path.basename(raiz);
  const tipo = o.tipo ?? tipoDoProjeto(raiz);
  const q = criarPerguntador(o);
  const feito = [];
  const pendente = [];
  try {
    console.log(`don configurar · ${raiz} (projeto ${tipo})\n`);
    const nodeMaior = Number(process.versions.node.split('.')[0]);
    if (nodeMaior < 20) pendente.push(`Node ${process.versions.node}: o don precisa do Node 20 ou mais novo.`);

    // 1. CLIs
    const detectado = {};
    for (const [id, m] of Object.entries({ ...MOTORES, ...ORQUESTRADOR })) detectado[id] = await versao(m.binario);
    console.log('Ambiente:');
    for (const [id, m] of Object.entries({ ...MOTORES, ...ORQUESTRADOR })) console.log(`  ${detectado[id] ? 'ok   ' : 'falta'} ${m.nome}${detectado[id] ? ` (${detectado[id]})` : ''}`);
    console.log('');
    const instalados = Object.keys(MOTORES).filter((id) => detectado[id]);
    let motores = await q.pergunta('motores', `CLIs que executam ordens (soldati), separadas por vírgula — conhecidas: ${Object.keys(MOTORES).join(', ')}`,
      instalados.length ? instalados : Object.keys(MOTORES), (v) => v.split(',').map((s) => s.trim()).filter(Boolean));
    motores = motores.filter((m) => MOTORES[m]);
    if (!motores.length) throw new Error('Nenhuma CLI de execução escolhida.');

    // 2. instalar o que falta
    for (const m of motores.filter((id) => !detectado[id])) {
      const cmd = comandoDeInstalacao(MOTORES[m]);
      if (await q.simNao(`instalar_${m}`, `${MOTORES[m].nome} não está instalado. Instalar agora com \`${cmd}\`?`, false)) {
        const r = process.platform === 'win32'
          ? await rodar('powershell.exe', ['-NoProfile', '-Command', cmd], { cwd: os.homedir(), minutos: 10 })
          : await rodar('/bin/sh', ['-c', cmd], { cwd: os.homedir(), minutos: 10 });
        if (r.codigo === 0) feito.push(`${MOTORES[m].nome} instalado. Faça o login: ${MOTORES[m].login}`);
        else pendente.push(`Instalação de ${MOTORES[m].nome} falhou; rode à mão: ${cmd}`);
      } else pendente.push(`Instale ${MOTORES[m].nome}: ${cmd}  (depois: ${MOTORES[m].login})`);
    }
    if (!detectado.claude) pendente.push(`Claude Code (o don) não foi encontrado: ${comandoDeInstalacao(ORQUESTRADOR.claude)}`);
    salvarConfigDaMaquina({ motores });
    feito.push(`Máquina: motores ativos ${motores.join(', ')} (${path.join(PASTA_DON(), 'config.json')})`);

    // 3-5. perfil, sensibilidade, áreas protegidas
    const perfil = await q.pergunta('perfil', `Perfil de custo — ${PERFIS.map((p) => ROTULO_PERFIL[p]).join(' | ')}`, 'equilibrio',
      (v) => PERFIS.find((p) => p.startsWith(v.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, ''))) ?? 'equilibrio');
    const sensivel = await q.simNao('sensivel', 'O projeto é sensível (dados reais, segurança, dinheiro)? Se sim, delegar exige teste de lealdade aprovado', false);
    const sugestoes = sugerirProtegidos(raiz);
    const protegidos = await q.pergunta('protegidos', `Áreas que nenhum soldato toca e o git só aceita com liberação humana (globs; ex.: src/crypto/)${sugestoes.length ? `. Sugestões: ${sugestoes.join(', ')}` : ''}`,
      [], (v) => (v === '-' ? [] : v.split(',').map((s) => s.trim()).filter(Boolean)));

    // 6. instalar no projeto
    const arqConfig = path.join(raiz, '.githooks', 'don.json');
    const existente = fs.existsSync(arqConfig) ? JSON.parse(fs.readFileSync(arqConfig, 'utf8')) : null;
    const substituir = existente ? await q.simNao('substituir_config', 'Já existe .githooks/don.json. Atualizar com estas respostas (mantendo o resto dele)?', true) : true;
    const config = montarConfiguracao({ tipo, nome, motores, perfil, sensivel, protegidos, base: existente });
    const temporario = path.join(os.tmpdir(), `don-config-${process.pid}.json`);
    fs.writeFileSync(temporario, JSON.stringify(config, null, 2));
    const salvar = console.log;
    console.log = () => {};
    try {
      instalar(raiz, { tipo, config: substituir ? temporario : undefined, forcar: substituir && !!existente });
    } finally {
      console.log = salvar;
      fs.rmSync(temporario, { force: true });
    }
    feito.push(`Projeto: don instalado; .githooks/don.json ${substituir ? 'gravado' : 'mantido'} (perfil ${perfil}, lealdade ${config.lealdade})`);

    if (await q.simNao('integrar', 'Integrar ao projeto: regras no AGENTS.md, import no CLAUDE.md, permissões no .claude/settings.json e perfil do Codex?', true)) {
      const trecho = fs.readFileSync(path.join(MODELOS, 'trechos', 'AGENTS.md'), 'utf8');
      const agents = path.join(raiz, 'AGENTS.md');
      fs.writeFileSync(agents, comTrechoAgents(fs.existsSync(agents) ? fs.readFileSync(agents, 'utf8') : '', trecho));
      const claudeMd = path.join(raiz, 'CLAUDE.md');
      fs.writeFileSync(claudeMd, comImportClaude(fs.existsSync(claudeMd) ? fs.readFileSync(claudeMd, 'utf8') : ''));
      const arqSettings = path.join(raiz, '.claude', 'settings.json');
      const nosso = JSON.parse(fs.readFileSync(path.join(MODELOS, 'trechos', 'claude-settings.json'), 'utf8').replaceAll('{{DON}}', COMANDO));
      const atual = fs.existsSync(arqSettings) ? JSON.parse(fs.readFileSync(arqSettings, 'utf8')) : {};
      fs.mkdirSync(path.dirname(arqSettings), { recursive: true });
      fs.writeFileSync(arqSettings, `${JSON.stringify(mesclarSettings(atual, nosso), null, 2)}\n`);
      feito.push('Projeto: AGENTS.md, CLAUDE.md e .claude/settings.json integrados');
      if (motores.includes('codex')) {
        const toml = path.join(raiz, '.codex', 'config.toml');
        const projeto = await carregarProjeto(raiz);
        const perfilNome = projeto.config.codex?.perfil ?? 'don';
        if (!fs.existsSync(toml)) {
          const linhas = [];
          console.log = (t) => linhas.push(t);
          try {
            perfilCodex(projeto);
          } finally {
            console.log = salvar;
          }
          fs.mkdirSync(path.dirname(toml), { recursive: true });
          fs.writeFileSync(toml, `${linhas.join('\n')}\n`);
          feito.push('Projeto: .codex/config.toml com o perfil de permissões');
        } else if (!fs.readFileSync(toml, 'utf8').includes(`[permissions.${perfilNome}]`)) {
          pendente.push(`O .codex/config.toml já existe e não tem [permissions.${perfilNome}]: gere com \`don perfil-codex\` e junte à mão (tabelas TOML não podem repetir).`);
        }
      }
    }

    // 7. confiança do Codex
    if (motores.includes('codex') && !codexConfiaNoProjeto(raiz)) {
      if (await q.simNao('confiar_codex', `O Codex só carrega o perfil de projeto confiável. Marcar ${raiz} como confiável (acrescenta 2 linhas ao ${arquivoDeConfigDoCodex()})?`, false)) {
        fs.mkdirSync(path.dirname(arquivoDeConfigDoCodex()), { recursive: true });
        fs.appendFileSync(arquivoDeConfigDoCodex(), `\n[projects.'${raiz}']\ntrust_level = "trusted"\n`);
        feito.push('Codex: projeto marcado como confiável');
      } else pendente.push(`Codex: marque o projeto como confiável (abra \`codex\` na pasta e aceite).`);
    }

    // 8. documentação local + MCP
    if (await q.simNao('docs', 'Baixar a documentação oficial das CLIs ativas (e do Claude Code) para ~/.don/docs e registrar o MCP consigliere no Claude Code?', false)) {
      const { sincronizarDocs } = await import('./consigliere/docs.mjs');
      const pastas = [];
      for (const ent of [...motores.map((m) => MOTORES[m]), ORQUESTRADOR.claude]) {
        const pasta = path.join(PASTA_DON(), 'docs', ent.docs.pasta);
        try {
          await sincronizarDocs({ acao: 'baixar', indice: ent.docs.indice, pasta, filtro: ent.docs.filtro });
          pastas.push(pasta);
        } catch (e) {
          pendente.push(`Documentação de ${ent.nome}: ${e.message}`);
        }
      }
      if (pastas.length && detectado.claude) {
        const r = await rodar('claude', ['mcp', 'add', '--scope', 'user', 'consigliere', '--', 'node', path.join(PACOTE, 'bin', 'don.mjs').replace(/\\/g, '/'), 'mcp-docs', '--pasta', pastas.map((p) => p.replace(/\\/g, '/')).join(',')], { cwd: raiz, minutos: 2 });
        if (r.codigo === 0) feito.push(`MCP consigliere registrado no Claude Code (${pastas.length} pastas de documentação)`);
        else pendente.push(`Registrar o MCP: claude mcp add --scope user consigliere -- node ${COMANDO.replace('node ', '')} mcp-docs --pasta ${pastas.join(',')}`);
      }
    }

    // dependências do projeto que o don usa por junction
    for (const l of config.links ?? []) {
      if (!fs.existsSync(path.join(raiz, l))) pendente.push(`${l} não existe: instale as dependências do projeto (os soldati usam por junction).`);
    }

    // 9. lealdade
    if (await q.simNao('lealdade', 'Rodar agora o teste de lealdade das CLIs (uns 2 minutos de cota barata)?', false)) {
      const { lealdade } = await import('./lealdade.mjs');
      await lealdade({ motor: motores.length === 1 ? motores[0] : undefined });
    } else pendente.push('Rode `don lealdade` quando puder (e depois de cada atualização das CLIs).');

    console.log(['', 'Feito:', ...feito.map((f) => `  - ${f}`), ...(pendente.length ? ['Falta:', ...pendente.map((p) => `  - ${p}`)] : []),
      'Ative a trava do git (uma pessoa): git config core.hooksPath .githooks', 'Confira: don checar'].join('\n'));
  } finally {
    q.fechar();
  }
}
