/**
 * 差分 2：真实世界 ZIP 语料（10 个，开源许可，出处见 manifest.json）。
 * 判据：readZip 解析成功 + 文件集与 `unzip -Z1` 一致 + 全条目 CRC 验证 +
 * adm-zip 条目集互证 + `unzip -t` 完整性。
 * 语料缺失（如克隆后未跑 fetch-corpus）时对应档案 skip，不假装通过。
 */
import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import AdmZip from 'adm-zip';
import { readZip } from '../src/reader';

const HERE = dirname(fileURLToPath(import.meta.url));
const DIR = join(HERE, 'fixtures', 'real');

interface ManifestItem { name: string; url: string; license: string; bytes: number; sha256: string; big?: boolean }

const manifestPath = join(DIR, 'manifest.json');
if (!existsSync(manifestPath)) {
  describe.skip('差分 2（语料未抓取：node scripts/fetch-corpus.mjs）', () => {
    it('占位', () => { expect(true).toBe(true); });
  });
} else {
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as { items: ManifestItem[] };

  // sha256 完整性（防语料被意外改动/截断）
  const { createHash } = await import('node:crypto');
  for (const item of manifest.items) {
    const p = join(DIR, item.name);
    const ok = existsSync(p) &&
      createHash('sha256').update(readFileSync(p)).digest('hex') === item.sha256;
    const run = ok ? describe : describe.skip;
    run(`差分 2 · ${item.name}（${item.license}）`, () => {
      const bytes = () => new Uint8Array(readFileSync(p));

      it('unzip -t 完整性（第三方裁判）', () => {
        execFileSync('unzip', ['-t', '-qq', p], { stdio: 'pipe' });
      });

      it('readZip 解析成功且文件集与 unzip -Z1 一致', () => {
        const a = readZip(bytes());
        const unzipNames = execFileSync('unzip', ['-Z1', p], { encoding: 'utf8' })
          .split(/\r?\n/)
          .filter((s) => s.length > 0);
        expect(a.entries.map((e) => e.name).sort()).toEqual(unzipNames.sort());
      });

      it('全条目读取 + CRC 验证（任务书判据）', () => {
        const a = readZip(bytes());
        let total = 0;
        for (const e of a.entries) {
          if (e.name.endsWith('/')) {
            expect(e.size).toBe(0);
            continue;
          }
          const data = a.read(e.name); // 内含长度 + CRC 双验证
          expect(data.length).toBe(e.size);
          total += e.size;
        }
        expect(total).toBeGreaterThan(0);
      }, 300_000);

      it('adm-zip 条目集互证（oracle 裁判）', () => {
        const az = new AdmZip(readFileSync(p));
        const azNames = az.getEntries().map((e) => e.entryName).sort();
        const a = readZip(bytes());
        expect(a.entries.map((e) => e.name).sort()).toEqual(azNames);
      }, 120_000);
    });
  }
}
