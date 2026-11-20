/**
 * 差分 1 共享引擎：随机文件集生成 + 三方向互验。
 * oracle（adm-zip）只当裁判，绝不进入 src/。
 *
 * 已知 oracle 限制（探针实证，REPORT 记录）：adm-zip 0.6.1 不支持重名条目
 * （写入时同名替换、读取时抛 DUPLICATE_ENTRY），差分用例的名字池去重；
 * 重名语义由自有 writeZip→readZip 往返覆盖（tests/core.test.ts）。
 */
import AdmZip from 'adm-zip';
import { readZip, writeZip, type ZipInput } from '../src/index';

/** mulberry32 种子化 PRNG（差分可复现）。 */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return (): number => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
}

/** 大缓冲快速相等（chunked）。 */
export function bufEq(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

const NAME_SEGMENTS = [
  'a', 'b', 'bin', 'doc', 'data', '图片', '档案', '测试', '🎉', '😀',
  '数据', 'logs', 'x', 'l0', 'l1', 'l2', 'src', 'lib', 'util', 'tmp',
];

/** 生成一组随机文件（名字去重；目录条目 = 尾斜杠）。 */
export function genFileSet(rnd: () => number): ZipInput[] {
  const count = Math.floor(rnd() * 60); // 0..59 文件（组均 ~30，2000 组总文件量可控）
  const names = new Set<string>();
  const files: ZipInput[] = [];
  let guard = 0;
  while (files.length < count && guard++ < count * 30) {
    const deep = rnd() < 0.08;
    const segs = deep ? 20 + Math.floor(rnd() * 25) : 1 + Math.floor(rnd() * 6);
    let name = '';
    for (let i = 0; i < segs; i++) {
      name += NAME_SEGMENTS[Math.floor(rnd() * NAME_SEGMENTS.length)]!;
      if (i < segs - 1) name += '/';
    }
    if (rnd() < 0.05) name += '/'; // 目录条目
    if (rnd() < 0.4) name += '.' + ['txt', 'bin', 'json', 'dat', 'md'][Math.floor(rnd() * 5)]!;
    if (names.has(name)) continue;
    names.add(name);

    // 尺寸分布：75% ≤4KB，20% 4KB-64KB，4% 64KB-1MB，1% 1MB-8MB
    const r = rnd();
    let size: number;
    if (r < 0.75) size = Math.floor(rnd() * 4096);
    else if (r < 0.95) size = 4096 + Math.floor(rnd() * 60 * 1024);
    else if (r < 0.99) size = 64 * 1024 + Math.floor(rnd() * (1024 * 1024 - 64 * 1024));
    else size = 1024 * 1024 + Math.floor(rnd() * 7 * 1024 * 1024);

    const kind = rnd();
    const isDirEntry = name.endsWith('/');
    const data = new Uint8Array(isDirEntry ? 0 : size); // 目录条目按定义无数据
    if (!isDirEntry) {
      if (kind < 0.35) {
        // 伪随机（不可压）
        let s = (rnd() * 0xffffffff) >>> 0;
        for (let i = 0; i < size; i++) {
          s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
          data[i] = s >>> 24;
        }
      } else if (kind < 0.7) {
        // 重复文本（高压缩）
        const word = 'the quick brown fox 中文测试 ';
        const wb = new TextEncoder().encode(word);
        for (let i = 0; i < size; i++) data[i] = wb[i % wb.length]!;
      } else if (kind < 0.85) {
        // 稀疏（长距离匹配）
        for (let i = 0; i < size; i += 4096) data[i] = (i >> 12) & 0xff;
      } // 其余全零（stored 块决策压力）
    }

    files.push({ name, data, method: !isDirEntry && rnd() < 0.5 ? 0 : undefined });
  }
  return files;
}

function admEntries(az: AdmZip): Array<{ name: string; data: Uint8Array }> {
  return az.getEntries().map((e) => ({ name: e.entryName, data: e.getData() }));
}

function byName(list: Array<{ name: string; data: Uint8Array }>): Map<string, Uint8Array> {
  return new Map(list.map((e) => [e.name, e.data]));
}

/** 三方向互验一组文件集。条目以名字集合对拍——zip 格式不定义条目顺序，
 *  且 adm-zip 0.6.1 读取时默认 localeCompare 重排（zipFile.js sortEntries，
 *  noSort 选项可关），顺序本身不在差分语义内；数据按名字索引逐字节比较。 */
export function crossCheck(files: ZipInput[]): void {
  // —— 方向 A：我写它读 ——
  const mine = writeZip(files);
  const az = new AdmZip(Buffer.from(mine));
  const theirs = admEntries(az);
  expect(theirs.length).toBe(files.length);
  const tmap = byName(theirs);
  expect([...tmap.keys()].sort()).toEqual(files.map((f) => f.name).sort());
  for (const f of files) {
    expect(bufEq(tmap.get(f.name)!, f.data)).toBe(true);
  }

  // —— 方向 B：它写我读 ——
  const azw = new AdmZip();
  for (const f of files) azw.addFile(f.name, Buffer.from(f.data));
  const theirBytes = azw.toBuffer();
  const mine2 = readZip(new Uint8Array(theirBytes.buffer, theirBytes.byteOffset, theirBytes.byteLength));
  expect(mine2.entries.length).toBe(files.length);
  expect(mine2.entries.map((e) => e.name).sort()).toEqual(files.map((f) => f.name).sort());
  for (const f of files) {
    expect(bufEq(mine2.read(f.name), f.data)).toBe(true);
  }

  // —— 方向 C：混合链（它写我读我重写它再读）——
  const rewritten = writeZip(files.map((f) => ({ name: f.name, data: mine2.read(f.name) })));
  const az2 = new AdmZip(Buffer.from(rewritten));
  const reread = admEntries(az2);
  expect(reread.length).toBe(files.length);
  const rmap = byName(reread);
  for (const f of files) {
    expect(bufEq(rmap.get(f.name)!, f.data)).toBe(true);
  }
}
