/**
 * M3 ZIP64 全链路测试。
 *
 * 任务书：“合成 >4GB 尺寸字段的映像测试，不真写 4GB”——合成映像由
 * tests/helpers.ts 的字节级构造器产出；写入器 ZIP64 链路用 opts.zip64=true
 * 强制全字段哨兵占位 + 8 字节扩展字段。第三方裁判：adm-zip 与 CPython
 * zipfile（force_zip64 独立写入器）双向互验。
 */
import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import AdmZip from 'adm-zip';
import { readZip } from '../src/reader';
import { writeZip } from '../src/writer';
import { ZipError } from '../src/struct';
import { buildZipManual } from './helpers';

const TE = new TextEncoder();
const BIG = 5_000_000_007; // > 0xFFFFFFFF 的合法合成尺寸

describe('M3 写入器 ZIP64 强制全链路 → 自家读取器往返', () => {
  const files = [
    { name: 'small.txt', data: TE.encode('zip64 forced content') },
    { name: '中文/名字.txt', data: TE.encode('中文内容') },
    { name: 'dir/', data: new Uint8Array(0) },
  ];
  const zip = writeZip(files, { zip64: true });

  it('EOCD64 + 定位器 + 双头哨兵占位结构齐全', () => {
    const dv = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
    const sigAt = (s: number): number => {
      for (let i = 0; i < zip.length - 4; i++) {
        if (dv.getUint32(i, true) === s) return i;
      }
      return -1;
    };
    // 定位器与 EOCD64 都存在，EOCD 条目数字段为哨兵
    expect(sigAt(0x07064b50)).toBeGreaterThan(0);
    expect(sigAt(0x06064b50)).toBeGreaterThan(0);
    const eocdPos = zip.length - 22;
    expect(dv.getUint16(eocdPos + 10, true)).toBe(0xffff);
  });

  it('自家读取器往返一致', () => {
    const a = readZip(zip);
    expect(a.entries.map((e) => e.name)).toEqual(files.map((f) => f.name));
    for (const f of files) expect(a.read(f.name)).toEqual(f.data);
  });

  it('adm-zip 读我们的 ZIP64 强制档案（互验方向一）', () => {
    const az = new AdmZip(Buffer.from(zip));
    const names = az.getEntries().map((e) => e.entryName);
    expect(names).toEqual(files.map((f) => f.name));
    for (const f of files) {
      expect(az.getEntry(f.name)!.getData()).toEqual(Buffer.from(f.data));
    }
  });

  it('CPython zipfile 读我们的 ZIP64 强制档案（互验方向一）', () => {
    const dir = mkdtempSync(join(tmpdir(), 'zip64-ours-'));
    try {
      const p = join(dir, 'ours.zip');
      writeFileSync(p, zip);
      const out = execFileSync('python', ['.tmp/py-zip64.py', 'read', p], { encoding: 'utf8' });
      expect(out).toContain('PY-READ-OK');
      const infos = JSON.parse(out.substring(0, out.indexOf('PY-READ-OK'))) as Array<{ name: string; size: number }>;
      expect(infos.map((i) => i.name)).toEqual(files.map((f) => f.name));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('M3 CPython force_zip64 写 → 我们读（互验方向二）', () => {
  it('force_zip64 全链路（LFH/CD 扩展字段 + EOCD64）解析且数据一致', () => {
    const dir = mkdtempSync(join(tmpdir(), 'zip64-py-'));
    try {
      const p = join(dir, 'py.zip');
      execFileSync('python', ['.tmp/py-zip64.py', 'write', p]);
      const bytes = readFileSync(p);
      const a = readZip(new Uint8Array(bytes));
      expect(a.entries.map((e) => e.name)).toEqual(['py-zip64-deflated.txt', 'py-zip64-stored.bin']);
      expect(new TextDecoder().decode(a.read('py-zip64-deflated.txt'))).toBe('python zip64 payload 中文');
      expect(a.read('py-zip64-stored.bin')).toEqual(Uint8Array.from({ length: 256 }, (_, i) => i));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('M3 合成 >4GB 尺寸字段映像（不真写 4GB）', () => {
  it('LFH+CD 双哨兵 + 8 字节扩展字段：解析成功且 entries 元数据反映 64 位尺寸', () => {
    const zip = buildZipManual([
      {
        name: 'huge.bin',
        data: TE.encode('actual small payload'),
        method: 8,
        lfhZip64: { usize: BIG, csize: 4096, includeOffset: false },
        cdZip64: { usize: BIG, csize: 4096 },
      },
    ]);
    const a = readZip(zip);
    expect(a.entries.length).toBe(1);
    expect(a.entries[0]!.size).toBe(BIG);
    expect(a.entries[0]!.compressedSize).toBe(4096);
    // 注意：不调用 read() —— 声明尺寸与真实数据不符是合成映像的本质
    // （真值只能由真 4GB 数据产生），read() 会按设计抛 BAD_DATA。
    expect(() => a.read('huge.bin')).toThrow(ZipError);
  });

  it('EOCD 哨兵 + 定位器 + EOCD64 全链路合成（声明值与真实数据一致）', () => {
    const zip = buildZipManual(
      [{ name: 'a.txt', data: TE.encode('x'), cdZip64: { usize: 1, csize: 1 } }],
      { eocdZip64: true },
    );
    const a = readZip(zip);
    expect(a.entries.map((e) => e.name)).toEqual(['a.txt']);
    expect(a.read('a.txt')).toEqual(TE.encode('x'));
  });

  it('CD 偏移哨兵 + 偏移扩展字段消费链路', () => {
    // includeOffset 使 CD 的 lfhOffset 字段置哨兵，真值从 extra 消费
    const zip = buildZipManual([
      { name: 'a.txt', data: TE.encode('offset via extra'), cdZip64: { offset: 0, includeOffset: true } },
    ]);
    // helpers 里 cdZip64.offset 语义：哨兵占位，extra 携带 offset 值（0 = 占位，
    // 实际 LFH 偏移在构建时回填不了哨兵位置——这里手工把 extra 的 offset 修正为真实值）
    // 简化：直接断言解析失败与否都可定位——此用例目标仅仅是消费链路本身。
    const a = readZip(zip);
    expect(a.entries.map((e) => e.name)).toEqual(['a.txt']);
    expect(a.read('a.txt')).toEqual(TE.encode('offset via extra'));
  });

  it('EOCD 哨兵但定位器缺失 → BAD_ZIP64', () => {
    const zip = buildZipManual(
      [{ name: 'a.txt', data: TE.encode('x'), cdZip64: { usize: 3, csize: 3 } }],
      { eocdZip64: true, omitEOCD: true },
    );
    // 手工补一个哨兵 EOCD（无定位器、无 EOCD64）
    const eocd = new Uint8Array(22);
    const dv = new DataView(eocd.buffer);
    dv.setUint32(0, 0x06054b50, true);
    dv.setUint16(8, 0xffff, true);
    dv.setUint16(10, 0xffff, true);
    dv.setUint32(12, 0xffffffff, true);
    dv.setUint32(16, 0xffffffff, true);
    const bad = new Uint8Array(zip.length + 22);
    bad.set(zip);
    bad.set(eocd, zip.length);
    try {
      readZip(bad);
      throw new Error('应当抛错');
    } catch (e) {
      expect((e as ZipError).code).toBe('BAD_ZIP64');
    }
  });

  it('EOCD64 签名损坏 → BAD_ZIP64', () => {
    const zip = buildZipManual(
      [{ name: 'a.txt', data: TE.encode('x'), cdZip64: { usize: 3, csize: 3 } }],
      { eocdZip64: true },
    );
    // 定位 EOCD64 签名（0x06064b50）并翻转一位
    const dv = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
    for (let i = 0; i < zip.length - 4; i++) {
      if (dv.getUint32(i, true) === 0x06064b50) {
        const bad = zip.slice();
        bad[i] = (bad[i]! ^ 0x02) & 0xff; // 0x06 → 0x04
        try {
          readZip(bad);
          throw new Error('应当抛错');
        } catch (e) {
          expect((e as ZipError).code).toBe('BAD_ZIP64');
        }
        return;
      }
    }
    throw new Error('未找到 EOCD64（测试自身故障）');
  });
});
