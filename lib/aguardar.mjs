// Relatório em arquivo e espera por ele. Serve às cascas (subagentes soldato-codex e soldato-agy do
// Claude Code): o Bash em primeiro plano para em 10 minutos, então a casca roda o don em segundo
// plano com --relatorio e chama `don aguardar` em ciclos até o arquivo aparecer.
import console from 'node:console';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

export const AINDA_RODANDO = 3;

/** Copia tudo o que o comando escreve (stdout e stderr) para `arquivo`, gravado só na saída do processo. */
export function capturarRelatorio(arquivo) {
  const destino = path.resolve(arquivo);
  fs.mkdirSync(path.dirname(destino), { recursive: true });
  fs.rmSync(destino, { force: true });
  const linhas = [];
  for (const nome of ['log', 'error', 'warn']) {
    const original = console[nome].bind(console);
    console[nome] = (...a) => {
      linhas.push(a.map((x) => (typeof x === 'string' ? x : String(x))).join(' '));
      original(...a);
    };
  }
  // Grava na saída (inclusive em erro ou process.exit): gravar e renomear, para que quem aguarda
  // nunca leia um relatório pela metade.
  process.on('exit', (codigo) => {
    const texto = `${linhas.join('\n')}\n\n[don: fim, código de saída ${process.exitCode ?? codigo}]\n`;
    try {
      fs.writeFileSync(`${destino}.parcial`, texto);
      fs.renameSync(`${destino}.parcial`, destino);
    } catch {
      /* sem relatório: quem aguarda acaba pelo próprio limite */
    }
  });
}

/** Espera `arquivo` aparecer por até `segundos`; imprime o conteúdo ou avisa que ainda roda (código 3). */
export async function aguardar(arquivo, segundos = 540, intervaloMs = 2000) {
  if (!arquivo) throw new Error('Informe o arquivo: don aguardar <arquivo do --relatorio>');
  const destino = path.resolve(arquivo);
  const limite = Date.now() + segundos * 1000;
  for (;;) {
    if (fs.existsSync(destino)) {
      console.log(fs.readFileSync(destino, 'utf8').trimEnd());
      return 0;
    }
    if (Date.now() >= limite) {
      console.log(`AINDA RODANDO: ${arquivo} não apareceu em ${segundos}s. Chame \`don aguardar\` de novo.`);
      process.exitCode = AINDA_RODANDO;
      return AINDA_RODANDO;
    }
    await new Promise((r) => setTimeout(r, Math.min(intervaloMs, Math.max(0, limite - Date.now()))));
  }
}
