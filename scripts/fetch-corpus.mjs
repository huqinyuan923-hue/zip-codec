/**
 * 差分 2 语料抓取：10 个真实世界 ZIP（全部开源许可，出处与许可入 manifest）。
 * 下载到 tests/fixtures/real/。大文件（>5MB）仅本地缓存不入库（.gitignore）。
 * 用法：node scripts/fetch-corpus.mjs [--missing-only]
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DIR = join(ROOT, 'tests', 'fixtures', 'real');

/** 语料清单：name / url / license / maxMB 预算 */
const CORPUS = [
  { name: 'express-master.zip', url: 'https://codeload.github.com/expressjs/express/zip/refs/heads/master', license: 'MIT' },
  { name: 'requests-v2.31.0.zip', url: 'https://codeload.github.com/psf/requests/zip/refs/tags/v2.31.0', license: 'Apache-2.0' },
  { name: 'is-v5.0.0.zip', url: 'https://codeload.github.com/sindresorhus/is/zip/refs/tags/v5.0.0', license: 'MIT' },
  { name: 'lite-master.zip', url: 'https://codeload.github.com/rxi/lite/zip/refs/heads/master', license: 'MIT' },
  { name: 'sqlite-tools-win-x64-3450100.zip', url: 'https://www.sqlite.org/2024/sqlite-tools-win-x64-3450100.zip', license: 'public-domain' },
  { name: 'newtonsoft-json-13.0.3.nupkg', url: 'https://api.nuget.org/v3-flatcontainer/newtonsoft.json/13.0.3/newtonsoft.json.13.0.3.nupkg', license: 'MIT' },
  { name: 'commons-lang3-3.14.0.jar', url: 'https://repo1.maven.org/maven2/org/apache/commons/commons-lang3/3.14.0/commons-lang3-3.14.0.jar', license: 'Apache-2.0' },
  { name: 'certifi-2024.2.2-py3-none-any.whl', url: 'pypi-resolve', pypiPkg: 'certifi', pypiVer: '2024.2.2', license: 'MPL-2.0' },
  { name: 'ripgrep-14.1.0-win64.zip', url: 'https://github.com/BurntSushi/ripgrep/releases/download/14.1.0/ripgrep-14.1.0-x86_64-pc-windows-msvc.zip', license: 'MIT', big: true },
  { name: 'node-v20.12.0-win-x64.zip', url: 'https://nodejs.org/dist/v20.12.0/node-v20.12.0-win-x64.zip', license: 'MIT', big: true },
];

/** certifi 的确切 URL 用 PyPI JSON API 解析（whl 的 exact path 不可预测）。 */
async function resolvePyPIWhl(pkg, version) {
  const meta = await (await fetch(`https://pypi.org/pypi/${pkg}/${version}/json`)).json();
  const whl = meta.urls.find((u) => u.packagetype === 'bdist_wheel');
  if (!whl) throw new Error(`no wheel for ${pkg}`);
  return whl.url;
}

async function fetchOne(item, missingOnly) {
  const dest = join(DIR, item.name);
  if (missingOnly && existsSync(dest)) {
    console.log('skip (cached):', item.name);
    return;
  }
  let url = item.url;
  if (url === 'pypi-resolve') {
    url = await resolvePyPIWhl(item.pypiPkg, item.pypiVer);
  }
  console.log('fetch:', url);
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} for ${url}`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length < 100) throw new Error(`suspiciously small: ${url}`);
  writeFileSync(dest, buf);
  console.log(`  ok ${item.name} ${(buf.length / 1048576).toFixed(2)} MB`);
}

const manifestPath = join(DIR, 'manifest.json');
const old = existsSync(manifestPath) ? JSON.parse(readFileSync(manifestPath, 'utf8')) : { items: [] };

mkdirSync(DIR, { recursive: true });
const missingOnly = process.argv.includes('--missing-only');

for (const item of CORPUS) {
  try {
    await fetchOne(item, missingOnly);
  } catch (e) {
    console.error('FAIL:', item.name, String(e.message));
    if (!existsSync(join(DIR, item.name))) {
      console.error('  -> 该语料缺失，差分 2 将无法运行');
      continue;
    }
  }
}

// 生成 manifest（sha256 + 出处 + 许可 + 大小），供测试校验语料完整性
const items = [];
for (const item of CORPUS) {
  const dest = join(DIR, item.name);
  if (!existsSync(dest)) continue;
  const buf = readFileSync(dest);
  items.push({
    name: item.name,
    url: item.url,
    license: item.license,
    bytes: buf.length,
    sha256: createHash('sha256').update(buf).digest('hex'),
    big: item.big === true,
  });
}
writeFileSync(manifestPath, JSON.stringify({ items }, null, 2));
console.log(`manifest: ${items.length}/${CORPUS.length} 条语料就绪`);
for (const it of items) {
  if (statSync(join(DIR, it.name)).size > 5 * 1048576) console.log('  (大文件，gitignore：)', it.name);
}
