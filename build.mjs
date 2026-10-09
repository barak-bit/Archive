// Builds the web app: bundles engine.js, injects config.json and writes dist/index.html.
//   node build.mjs            -> dist/index.html
//   node build.mjs --preview  -> also dist/preview.html (no document skeleton, public-page links off)
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { build } from 'esbuild';

const root = new URL('.', import.meta.url);
const read = (p) => readFileSync(new URL(p, root), 'utf8');
const config = JSON.parse(read('config.json'));
const OUT = new URL(process.env.OUT_DIR ? `${process.env.OUT_DIR.replace(/\/$/, '')}/` : 'dist/', root);

const bundle = await build({
  entryPoints: [new URL('engine.js', root).pathname], bundle: true, format: 'iife', globalName: 'Engine',
  minify: true, target: 'es2020', legalComments: 'none', write: false,
});
const engine = bundle.outputFiles[0].text.replace(/<\/script/gi, '<\\/script');
const src = read('app.html');

function page(cfg) {
  const appCfg = { network: cfg.network, reportEmail: cfg.reportEmail, hiddenTxids: cfg.hiddenTxids || [], publicPages: !!cfg.publicPages, cardPayment: cfg.cardPayment || {} };
  const json = JSON.stringify(appCfg).replace(/</g, '\\u003c');
  return src
    .replace(/\/\*CONFIG\*\/[\s\S]*?\/\*END\*\//, () => json)
    .replace('<script>/*ENGINE*/</script>', () => `<script>\n${engine}\n</script>`);
}

mkdirSync(OUT, { recursive: true });
const body = page(config);
const cut = body.indexOf('</style>') + '</style>'.length;
writeFileSync(new URL('index.html', OUT),
  `<!doctype html>\n<html lang="he" dir="rtl">\n<head>\n<meta charset="utf-8">\n<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">\n<meta name="description" content="ארכיון ציבורי קבוע על הבלוקצ'יין של ביטקוין">\n${body.slice(0, cut)}\n</head>\n<body>${body.slice(cut)}\n</body>\n</html>\n`);
if (process.argv.includes('--preview')) writeFileSync(new URL('preview.html', OUT), page({ ...config, publicPages: false }));
writeFileSync(new URL('.nojekyll', OUT), '');
console.log('app built:', new URL('index.html', OUT).pathname);
