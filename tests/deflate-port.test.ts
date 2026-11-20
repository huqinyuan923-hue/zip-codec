/**
 * deflate 移植随迁单元测试（出处：deflate 项目 tests/ 的代表性子集）。
 * node:zlib 仅作为测试期裁判（oracle），不进入 src/。
 */
import { describe, expect, it } from 'vitest';
import { inflateRawSync, deflateRawSync } from 'node:zlib';
import { inflate, deflateRaw, crc32 } from '../src/deflate';

/** 三类代表性语料：重复文本（高压缩）、伪随机（不可压）、稀疏（长距离匹配）。 */
function sample(k: 'text' | 'random' | 'sparse', n: number): Uint8Array {
  const b = new Uint8Array(n);
  if (k === 'text') {
    const word = 'the quick brown fox jumps over the lazy dog ';
    for (let i = 0; i < n; i++) b[i] = word.charCodeAt(i % word.length) & 0xff;
  } else if (k === 'random') {
    let s = 0x12345678;
    for (let i = 0; i < n; i++) {
      s = (s * 1103515245 + 12345) >>> 0;
      b[i] = s >>> 24;
    }
  } else {
    for (let i = 0; i < n; i += 4096) b[i] = (i / 4096) & 0xff; // 每 4KB 一个字节
  }
  return b;
}

describe('crc32 移植', () => {
  it('已知校验值', () => {
    expect(crc32(new Uint8Array(0))).toBe(0);
    expect(crc32(new TextEncoder().encode('123456789'))).toBe(0xcbf43926);
    expect(crc32(new TextEncoder().encode('The quick brown fox jumps over the lazy dog'))).toBe(0x414fa339);
  });
});

describe('deflate/inflate 移植：往返', () => {
  const cases: Array<[string, Uint8Array]> = [
    ['空输入', new Uint8Array(0)],
    ['单字节', new Uint8Array([0x42])],
    ['短文本', new TextEncoder().encode('hello, ZIP world! hello, ZIP world! hello!')],
    ['重复文本 1MB', sample('text', 1 << 20)],
    ['伪随机 256KB', sample('random', 1 << 18)],
    ['稀疏 1MB', sample('sparse', 1 << 20)],
    ['全零 1MB', new Uint8Array(1 << 20)],
    ['255 游程 300KB', new Uint8Array(300_000).fill(255)],
  ];
  for (const [label, data] of cases) {
    it(`往返一致：${label}`, () => {
      for (const level of [1, 6, 9]) {
        const z = deflateRaw(data, level);
        expect(inflate(z, data.length)).toEqual(data);
      }
    });
  }

  it('stored 块路径（不可压数据走 stored 块）', () => {
    const rnd = sample('random', 100_000); // 伪随机：stored 应胜出
    const z = deflateRaw(rnd, 1);
    expect(inflate(z)).toEqual(rnd);
    // zlib 也能解我们的裸流（互验）
    expect(inflateRawSync(Buffer.from(z))).toEqual(Buffer.from(rnd));
  });

  it('跨 65535 stored 切片边界（>64KB 不可压数据）', () => {
    const rnd = sample('random', 200_000);
    const z = deflateRaw(rnd, 1);
    expect(inflate(z)).toEqual(rnd);
  });
});

describe('deflate 移植：与 node:zlib 互验', () => {
  it('我们的 deflate 流 zlib 能解；zlib 的流我们能解', () => {
    const data = sample('text', 64_000);
    const ours = deflateRaw(data, 6);
    expect(inflateRawSync(Buffer.from(ours))).toEqual(Buffer.from(data));

    const theirs = deflateRawSync(data);
    expect(inflate(theirs, data.length)).toEqual(data);
  });

  it('9 个压缩级别产出均可解', () => {
    const data = sample('text', 30_000);
    for (let level = 1; level <= 9; level++) {
      const z = deflateRaw(data, level);
      expect(inflate(z)).toEqual(data);
      expect(inflateRawSync(Buffer.from(z))).toEqual(Buffer.from(data));
    }
  });
});

describe('inflate 移植：畸形输入一律抛错', () => {
  it('截断位流', () => {
    const z = deflateRaw(sample('text', 5000), 6);
    expect(() => inflate(z.subarray(0, z.length >> 1))).toThrow();
  });
  it('尾随垃圾被忽略（与 zlib inflateRaw 行为一致）', () => {
    const data = sample('text', 1000);
    const z = deflateRaw(data, 6);
    const dirty = new Uint8Array(z.length + 7);
    dirty.set(z);
    dirty.set([1, 2, 3, 4, 5, 6, 7], z.length);
    expect(inflate(dirty)).toEqual(data);
  });
  it('非法块类型 11 抛错', () => {
    // 0x07 = BFINAL 1 + BTYPE 11（保留）
    expect(() => inflate(new Uint8Array([0x07]))).toThrow(/非法块类型/);
  });
});
