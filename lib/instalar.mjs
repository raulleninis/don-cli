// Instala o don num projeto, gera o perfil de permissões do Codex e confere a instalação.
import console from 'node:console';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { codexConfiaNoProjeto } from './codex.mjs';
import { raizDoProjeto } from './projeto.mjs';
import { git, rodar } from './processo.mjs';

const PACOTE = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const MODELOS = path.join(PACOTE, 'modelos');
export const COMANDO = `node ${path.join(PACOTE, 'bin', 'don.mjs').replace(/\\/g, '/')}`;

function tipoDoProjeto(raiz) {
  if (fs.existsSync(path.join(raiz, 'package.json'))) return 'node';
  if (['pyproject.toml', 'requirements.txt', 'setup.py'].some((f) => fs.existsSync(path.join(raiz, f)))) return 'python';
  return 'vazio';
}

export function instalar(dir, { forcar = false, tipo, config } = {}) {
  const raiz = raizDoProjeto(dir);
  const nome = path.basename(raiz);
  const t = tipo ?? tipoDoProjeto(raiz);
  const feito = [];
  const pulado = [];

  const copiar = (origem, destino, { trocar = {}, sobrescrever = forcar, executavel = false } = {}) => {
    const alvo = path.join(raiz, destino);
    if (fs.existsSync(alvo) && !sobrescrever) return pulado.push(destino);
    let texto = fs.readFileSync(path.join(MODELOS, origem), 'utf8');
    for (const [de, para] of Object.entries(trocar)) texto = texto.replaceAll(de, para);
    fs.mkdirSync(path.dirname(alvo), { recursive: true });
    fs.writeFileSync(alvo, texto);
    if (executavel) fs.chmodSync(alvo, 0o755);
    feito.push(destino);
  };

  copiar('githooks/caminhos.mjs', '.githooks/caminhos.mjs');
  copiar('githooks/pre-commit.mjs', '.githooks/pre-commit.mjs', { executavel: true });
  copiar('githooks/pre-commit', '.githooks/pre-commit', { executavel: true });
  // A configuração do projeto nunca é sobrescrita pelo modelo, nem com --forcar. Uma configuração
  // pronta (`--config <arquivo>`, ex.: a proposta numa migração ou a do `don configurar`) entra se não
  // houver uma, ou com --forcar.
  const destinoConfig = path.join(raiz, '.githooks', 'don.json');
  if (config) {
    const texto = fs.readFileSync(path.resolve(config), 'utf8');
    JSON.parse(texto); // recusa JSON inválido antes de gravar
    if (fs.existsSync(destinoConfig) && !forcar) pulado.push('.githooks/don.json (--config ignorado: já existe; use --forcar)');
    else {
      fs.mkdirSync(path.dirname(destinoConfig), { recursive: true });
      fs.writeFileSync(destinoConfig, texto.endsWith('\n') ? texto : `${texto}\n`);
      feito.push(`.githooks/don.json (de ${path.basename(config)})`);
    }
  } else {
    copiar(`githooks/don.${t}.json`, '.githooks/don.json', { trocar: { '{{PROJETO}}': nome }, sobrescrever: false });
  }
  copiar('agents/hooks/guarda.mjs', '.agents/hooks/guarda.mjs');
  copiar('claude/skills/don/SKILL.md', '.claude/skills/don/SKILL.md', { trocar: { '{{DON}}': COMANDO } });
  copiar('claude/agents/consigliere.md', '.claude/agents/consigliere.md');

  // hooks.json do agy: acrescenta o hook do don sem apagar os que já existem.
  const hooksJson = path.join(raiz, '.agents', 'hooks.json');
  const nosso = JSON.parse(fs.readFileSync(path.join(MODELOS, 'agents', 'hooks.json'), 'utf8'));
  const atual = fs.existsSync(hooksJson) ? JSON.parse(fs.readFileSync(hooksJson, 'utf8')) : {};
  // Instalação antiga (outro nome de chave rodando o mesmo hooks/guarda.mjs): sai, senão o hook roda
  // duas vezes por ferramenta (e o limite de passos conta em dobro).
  const legado = Object.keys(atual).filter((k) => k !== 'don-guarda' && JSON.stringify(atual[k]).includes('hooks/guarda.mjs'));
  if (!atual['don-guarda'] || forcar || legado.length) {
    for (const k of legado) delete atual[k];
    fs.writeFileSync(hooksJson, `${JSON.stringify({ ...atual, ...nosso }, null, 2)}\n`);
    feito.push(`.agents/hooks.json${legado.length ? ` (removido hook antigo: ${legado.join(', ')})` : ''}`);
  } else pulado.push('.agents/hooks.json');

  const gitignore = path.join(raiz, '.gitignore');
  const ignorado = fs.existsSync(gitignore) ? fs.readFileSync(gitignore, 'utf8') : '';
  if (!/^\/?\.don\/?$/m.test(ignorado)) {
    fs.appendFileSync(gitignore, `${ignorado.endsWith('\n') || !ignorado ? '' : '\n'}\n# Saídas e registro do don.\n.don/\n`);
    feito.push('.gitignore (+ .don/)');
  }

  // Os scripts da trava sempre com LF, mesmo com core.autocrlf=true.
  const atributos = path.join(raiz, '.gitattributes');
  const attr = fs.existsSync(atributos) ? fs.readFileSync(atributos, 'utf8') : '';
  if (!attr.includes('.githooks/** text eol=lf')) {
    fs.appendFileSync(atributos, `${attr.endsWith('\n') || !attr ? '' : '\n'}.githooks/** text eol=lf\n.agents/hooks/** text eol=lf\n`);
    feito.push('.gitattributes (eol=lf nos hooks)');
  }

  const settings = fs.readFileSync(path.join(MODELOS, 'trechos', 'claude-settings.json'), 'utf8').replaceAll('{{DON}}', COMANDO);
  console.log(
    [
      `Don instalado em ${raiz} (modelo de configuração: ${t}).`,
      feito.length ? `Criados: ${feito.join(', ')}` : '',
      pulado.length ? `Já existiam (mantidos; --forcar sobrescreve, menos o don.json): ${pulado.join(', ')}` : '',
      '',
      'Próximos passos:',
      '1. Revise .githooks/don.json: áreas protegidas e reservadas, links, verificação, modelos.',
      `2. Gere o perfil do Codex e cole em .codex/config.toml:  ${COMANDO} perfil-codex`,
      `3. Junte ao AGENTS.md o trecho de ${path.join(MODELOS, 'trechos', 'AGENTS.md')}`,
      '   e faça o CLAUDE.md importá-lo com uma linha "@AGENTS.md".',
      '4. Mescle no .claude/settings.json (permissões do don):',
      settings.replace(/^/gm, '     '),
      '5. Faça commit (o pre-commit ainda não está ativo, então passa).',
      '6. Um humano ativa a trava do git:  git config core.hooksPath .githooks',
      `7. Confira:  ${COMANDO} checar`,
    ]
      .filter((l) => l !== '')
      .join('\n'),
  );
}

const pastaOuGlob = (glob) => (glob.endsWith('/') ? glob.slice(0, -1) : glob);

export function perfilCodex(projeto, nome, windows = process.platform === 'win32') {
  const perfil = nome ?? projeto.config.codex?.perfil ?? 'don';
  const segredos = projeto.config.segredos ?? ['**/.env', '**/.env.*', '**/*.pem', '**/*.key'];
  const regras = new Map(segredos.map((g) => [g, 'deny']));
  for (const [, , glob] of projeto.caminhos.RESERVADOS) {
    const chave = pastaOuGlob(glob);
    if (!regras.has(chave) && !regras.has(glob)) regras.set(chave, 'read');
  }
  const linhas = [
    `# Gerado pelo don a partir de .githooks/don.json. Cole em .codex/config.toml do projeto.`,
    `# Áreas reservadas ficam só leitura, segredos negados e o sandbox sem rede.`,
    `default_permissions = "${perfil}"`,
    '',
    // No Windows, a negação de leitura (segredos) só existe no sandbox elevated: sem ele o Codex nem
    // inicia ("Restricted read-only access requires the elevated Windows sandbox backend", achado pelo
    // don lealdade). Por isso, gerado no Windows, sai ativo; em outros sistemas, fica de referência.
    ...(windows
      ? ['# Windows: a negação de leitura de segredos exige o sandbox elevated (sem ele o Codex não inicia).',
        '[features]', 'prefer_mxc = true', '', '[windows]', 'sandbox = "elevated"']
      : ['# No Windows, a negação de leitura de segredos exige o sandbox elevated:',
        '# [features]', '# prefer_mxc = true', '# [windows]', '# sandbox = "elevated"']),
    '',
    `[permissions.${perfil}]`,
    'extends = ":workspace"',
    '',
    `[permissions.${perfil}.filesystem]`,
    'glob_scan_max_depth = 8',
    '',
    `[permissions.${perfil}.filesystem.":workspace_roots"]`,
    ...[...regras].map(([glob, acesso]) => `${JSON.stringify(glob)} = "${acesso}"`),
    '',
    `[permissions.${perfil}.network]`,
    'enabled = false',
  ];
  console.log(linhas.join('\n'));
}

export async function checar(projeto) {
  const { raiz, config } = projeto;
  const existe = (rel) => fs.existsSync(path.join(raiz, rel));
  const ler = (rel) => (existe(rel) ? fs.readFileSync(path.join(raiz, rel), 'utf8') : '');
  let hooksPath = '';
  try {
    hooksPath = git(raiz, 'config', 'core.hooksPath');
  } catch {
    /* não configurado */
  }
  const versao = async (cmd) => {
    const r = await rodar(cmd, ['--version'], { cwd: raiz, minutos: 1 });
    return r.codigo === 0 ? r.texto.trim().split('\n').pop() : null;
  };
  const codex = await versao('codex');
  const agy = await versao('agy');
  const perfil = config.codex?.perfil;
  const itens = [
    ['lista de caminhos e configuração (.githooks/)', existe('.githooks/caminhos.mjs') && existe('.githooks/don.json')],
    ['pre-commit (.githooks/pre-commit)', existe('.githooks/pre-commit') && existe('.githooks/pre-commit.mjs')],
    ['trava do git ativa (core.hooksPath = .githooks)', hooksPath.replace(/\/$/, '') === '.githooks'],
    ['hook do agy (.agents/hooks.json)', ler('.agents/hooks.json').includes('don-guarda') && existe('.agents/hooks/guarda.mjs')],
    ['skill delegar e agente consigliere (.claude/)', existe('.claude/skills/don/SKILL.md') && existe('.claude/agents/consigliere.md')],
    ['.don/ no .gitignore', /^\/?\.don\/?$/m.test(ler('.gitignore'))],
    ['AGENTS.md com a seção de worker delegado', ler('AGENTS.md').includes('worker delegado')],
    ['CLAUDE.md importa o AGENTS.md', /^@AGENTS\.md/m.test(ler('CLAUDE.md'))],
    [`perfil do Codex [permissions.${perfil}] em .codex/config.toml`, !perfil || ler('.codex/config.toml').includes(`[permissions.${perfil}]`)],
    ['Codex confia no projeto (senão o perfil não carrega)', !perfil || codexConfiaNoProjeto(raiz)],
    ...(config.links ?? []).map((l) => [`dependência para junction: ${l}`, existe(l)]),
    [`codex instalado${codex ? ` (${codex})` : ''}`, !!codex],
    [`agy instalado${agy ? ` (${agy})` : ''}`, !!agy],
  ];
  const { situacaoLealdade } = await import('./lealdade.mjs');
  const leal = await situacaoLealdade();
  itens.push([`lealdade: ${leal.motivo}`, leal.ok || (config.lealdade ?? 'aviso') === 'ignorar']);
  for (const [nome, ok] of itens) console.log(`${ok ? 'ok   ' : 'FALTA'} ${nome}`);
  return itens.every(([, ok]) => ok);
}
