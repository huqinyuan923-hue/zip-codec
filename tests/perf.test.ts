/**
 * 性能基准（防性能坍塌的烟雾下限；精确吞吐进 REPORT）。
 * 注意：npm test 全量并行时 worker 抢占 CPU，吞吐约为单跑的 1/2~1/3，
 * 下限按“全量并行”环境标定（单跑数据以 console 输出为准）。
 */
import { describe, expect, it } from 'vitest';
import { deflateRaw, inflate, crc32 } from '../src/deflate';
import { readZip, writeZip } from '../src/index';

const TE = new TextEncoder();

function pseudoRandom(n: number): Uint8Array {
  const b = new Uint8Array(n);
  let s = 0x12345678;
  for (let i = 0; i < n; i++) {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    b[i] = s >>> 24;
  }
  return b;
}

function mbps(bytes: number, ms: number): number {
  return (bytes / 1048576) / (ms / 1000);
}

describe('性能基准', () => {
  it('deflate 8MB 伪随机 ≥ 3MB/s（并行安全下限）', () => {
    const data = pseudoRandom(8 << 20);
    const t0 = performance.now();
    const z = deflateRaw(data, 1); // level 1（不可压数据走 stored 快路径）
    const ms = performance.now() - t0;
    const rate = mbps(data.length, ms);
    expect(rate).toBeGreaterThan(3);
    console.log(`deflate(random,8MB,L1): ${rate.toFixed(1)} MB/s`);
    expect(inflate(z, data.length).length).toBe(data.length);
  });

  it('deflate 8MB 高压缩文本 ≥ 4MB/s', () => {
    const data = new Uint8Array(8 << 20);
    const word = TE.encode('the quick brown fox jumps over the lazy dog 中文 ');
    for (let i = 0; i < data.length; i++) data[i] = word[i % word.length]!;
    const t0 = performance.now();
    const z = deflateRaw(data, 6);
    const ms = performance.now() - t0;
    const rate = mbps(data.length, ms);
    expect(rate).toBeGreaterThan(4);
    console.log(`deflate(text,8MB,L6): ${rate.toFixed(1)} MB/s, ratio ${(z.length / data.length * 100).toFixed(1)}%`);
  });

  it('inflate 8MB（高压缩流）≥ 30MB/s', () => {
    const data = new Uint8Array(8 << 20);
    const word = TE.encode('the quick brown fox jumps over the lazy dog 中文 ');
    for (let i = 0; i < data.length; i++) data[i] = word[i % word.length]!;
    const z = deflateRaw(data, 6);
    const t0 = performance.now();
    const out = inflate(z, data.length);
    const ms = performance.now() - t0;
    const rate = mbps(data.length, ms);
    expect(out.length).toBe(data.length);
    expect(rate).toBeGreaterThan(30);
    console.log(`inflate(8MB): ${rate.toFixed(1)} MB/s`);
  });

  it('crc32 64MB ≥ 100MB/s（并行安全下限）', () => {
    const data = pseudoRandom(64 << 20);
    const t0 = performance.now();
    const c = crc32(data);
    const ms = performance.now() - t0;
    const rate = mbps(data.length, ms);
    expect(c).toBeGreaterThan(0);
    expect(rate).toBeGreaterThan(100);
    console.log(`crc32(64MB): ${rate.toFixed(0)} MB/s`);
  });

  it('readZip 解析 500 条目档案 < 100ms（结构解析吞吐）', () => {
    const files = Array.from({ length: 500 }, (_, i) => ({
      name: `dir${i % 20}/file-${i}.txt`,
      data: TE.encode(`content of file ${i} `.repeat(20)),
    }));
    const zip = writeZip(files);
    const t0 = performance.now();
    const a = readZip(zip);
    const ms = performance.now() - t0;
    expect(a.entries.length).toBe(500);
    expect(ms).toBeLessThan(100);
    console.log(`parse(500 entries, ${((zip.length / 1048576) * 1).toFixed(2)} MB): ${ms.toFixed(1)} ms`);
  });
});
