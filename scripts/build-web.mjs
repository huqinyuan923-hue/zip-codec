/**
 * Web 单文件打包：web/main.ts → esbuild → 内联进 web/index.html → dist/web/index.html。
 * 任务书要求“Web UI 单文件已部署”。
 */
import { build } from 'esbuild';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = join(root, 'dist', 'web');
mkdirSync(outDir, { recursive: true });

const result = await build({
  entryPoints: [join(root, 'web', 'main.ts')],
  bundle: true,
  format: 'iife',
  target: 'es2022',
  minify: true,
  write: false,
  logLevel: 'error',
});
const js = result.outputFiles[0].text;

const html = readFileSync(join(root, 'web', 'index.html'), 'utf8')
  .replace('<!--BUNDLE-->', () => `<script>${js}</script>`);

writeFileSync(join(outDir, 'index.html'), html);
console.log(`web 单文件打包完成：dist/web/index.html（${(html.length / 1024).toFixed(1)} KB）`);
