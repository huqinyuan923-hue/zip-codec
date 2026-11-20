/**
 * 差分 1 分片 1/8（250 组）+ 差分 3 的 50-100MB 边界双向。
 * 其余 7 片见 diff-admzip-2..8.test.ts（同构，种子不同）。
 */
import { describe, expect, it } from 'vitest';
import AdmZip from 'adm-zip';
import { crossCheck, genFileSet, mulberry32, bufEq } from './diff-engine';
import { readZip, writeZip } from '../src/index';

describe.each([0])('差分 1 · 分片 1（种子基 20260101）', (shard: number) => {
  it(`250 组随机文件集三方向互验（shard=${shard}）`, () => {
    const rnd = mulberry32(20260101 + shard);
    for (let g = 0; g < 250; g++) {
      crossCheck(genFileSet(rnd));
    }
  }, 600_000);
});

describe('差分 1 · 大文件边界（0B-100MB 范围高段）', () => {
  it('50MB 伪随机 deflate：我写它读 / 它写我读', () => {
    const size = 50 * 1024 * 1024;
    const data = new Uint8Array(size);
    let s = 123456789;
    for (let i = 0; i < size; i++) {
      s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
      data[i] = s >>> 24;
    }
    // 我写它读
    const mine = writeZip([{ name: '50mb.bin', data }]);
    const az = new AdmZip(Buffer.from(mine));
    expect(bufEq(az.getEntry('50mb.bin')!.getData(), data)).toBe(true);
    // 它写我读
    const azw = new AdmZip();
    azw.addFile('50mb.bin', Buffer.from(data));
    const theirBytes = azw.toBuffer();
    const a = readZip(new Uint8Array(theirBytes.buffer, theirBytes.byteOffset, theirBytes.byteLength));
    expect(bufEq(a.read('50mb.bin'), data)).toBe(true);
  }, 300_000);

  it('100MB 全零 deflate：我写它读 / 它写我读', () => {
    const data = new Uint8Array(100 * 1024 * 1024);
    const mine = writeZip([{ name: 'zeros.bin', data }]);
    const az = new AdmZip(Buffer.from(mine));
    expect(az.getEntry('zeros.bin')!.getData().length).toBe(data.length);
    expect(bufEq(az.getEntry('zeros.bin')!.getData(), data)).toBe(true);

    const azw = new AdmZip();
    azw.addFile('zeros.bin', Buffer.from(data));
    const theirBytes = azw.toBuffer();
    const a = readZip(new Uint8Array(theirBytes.buffer, theirBytes.byteOffset, theirBytes.byteLength));
    expect(bufEq(a.read('zeros.bin'), data)).toBe(true);
  }, 300_000);

  it('100MB stored：我写 → 它读 + 自读（任务书 0B-100MB 上限）', () => {
    const size = 100 * 1024 * 1024;
    const data = new Uint8Array(size);
    for (let i = 0; i < size; i += 7919) data[i] = (i >>> 8) & 0xff;
    const mine = writeZip([{ name: 'stored100.bin', data, method: 0 }]);
    const az = new AdmZip(Buffer.from(mine));
    expect(bufEq(az.getEntry('stored100.bin')!.getData(), data)).toBe(true);
    const a = readZip(mine);
    expect(bufEq(a.read('stored100.bin'), data)).toBe(true);
  }, 300_000);
});

describe('差分 1 · oracle 限制契约化（重名）', () => {
  it('adm-zip 读含重名档案必须抛 DUPLICATE_ENTRY（oracle 立场，REPORT 记录）', () => {
    const mine = writeZip([
      { name: 'dup.txt', data: new TextEncoder().encode('first') },
      { name: 'dup.txt', data: new TextEncoder().encode('second') },
    ]);
    const az = new AdmZip(Buffer.from(mine));
    expect(() => az.getEntries()).toThrow(/Duplicate entry name/);
    // 自有实现对同一档案语义：两条都在，读第一个
    const a = readZip(mine);
    expect(a.entries.length).toBe(2);
    expect(new TextDecoder().decode(a.read('dup.txt'))).toBe('first');
  });
});
