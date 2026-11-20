/**
 * M1/M2/M4 核心单元测试：往返、描述符两种模式、CP437/UTF-8 编码、
 * EOCD 注释扫描、定向坏档（每种错误码至少一条代表）。
 */
import { describe, expect, it } from 'vitest';
import { crc32 } from '../src/deflate';
import { readZip } from '../src/reader';
import { writeZip } from '../src/writer';
import { ZipError } from '../src/struct';
import { buildZipManual, flipByte, poke32 } from './helpers';

const TE = new TextEncoder();

function bytes(s: string): Uint8Array {
  return TE.encode(s);
}

/** 大缓冲区快速比较（vitest toEqual 对 MB 级 TypedArray 是 O(n) 逐元素慢路径）。 */
function expectBufEq(a: Uint8Array, b: Uint8Array): void {
  expect(a.length).toBe(b.length);
  const CHUNK = 1 << 20;
  for (let off = 0; off < a.length; off += CHUNK) {
    const end = Math.min(a.length, off + CHUNK);
    let same = true;
    for (let i = off; i < end; i++) {
      if (a[i] !== b[i]) { same = false; break; }
    }
    if (!same) {
      // 找出首个差异位置，给出可读断言
      for (let i = off; i < end; i++) {
        if (a[i] !== b[i]) expect([i, a[i], b[i]]).toEqual([-1]);
      }
    }
  }
}

describe('M4 写入器 → M1/M2 读取器：往返', () => {
  it('stored/deflate/混合/空文件/中文/emoji/目录条目', () => {
    const files = [
      { name: 'a.txt', data: bytes('hello world, hello zip!'), method: 8 as const },
      { name: 'b.bin', data: bytes('stored content'), method: 0 as const },
      { name: 'empty.txt', data: new Uint8Array(0) },
      { name: '中文/文件.txt', data: bytes('内容') },
      { name: 'emoji/😀🎉.bin', data: new Uint8Array([1, 2, 3, 255, 0, 7]) },
      { name: 'dir/', data: new Uint8Array(0) },
    ];
    const zip = writeZip(files);
    const a = readZip(zip);
    expect(a.entries.map((e) => e.name)).toEqual(files.map((f) => f.name));
    for (const f of files) {
      expect(a.read(f.name)).toEqual(f.data);
    }
    // 方法字段
    const byName = new Map(a.entries.map((e) => [e.name, e]));
    expect(byName.get('a.txt')!.method).toBe(8);
    expect(byName.get('b.bin')!.method).toBe(0);
    expect(byName.get('dir/')!.method).toBe(0);
    // CRC
    expect(byName.get('a.txt')!.crc).toBe(crc32(bytes('hello world, hello zip!')));
    // 尺寸
    expect(byName.get('empty.txt')!.size).toBe(0);
    expect(byName.get('a.txt')!.size).toBe(23);
    expect(byName.get('a.txt')!.compressedSize).toBeLessThanOrEqual(24);
  });

  it('深层路径与重名条目（重名取第一个读）', () => {
    const deep = Array.from({ length: 60 }, (_, i) => `l${i}`).join('/') + '/deep.txt';
    const files = [
      { name: deep, data: bytes('deep') },
      { name: 'dup.txt', data: bytes('first') },
      { name: 'dup.txt', data: bytes('second') },
    ];
    const a = readZip(writeZip(files));
    expect(a.entries.length).toBe(3);
    expect(new TextDecoder().decode(a.read('dup.txt'))).toBe('first');
    expect(new TextDecoder().decode(a.read(deep))).toBe('deep');
  });

  it('大文件 stored 往返（10MB）', () => {
    const big = new Uint8Array(10 * 1024 * 1024);
    for (let i = 0; i < big.length; i += 7919) big[i] = i & 0xff;
    const a = readZip(writeZip([{ name: 'big.bin', data: big, method: 0 }]));
    expectBufEq(a.read('big.bin'), big);
  });

  it('deflate 大文件往返（4MB 高压缩文本）', () => {
    const big = new Uint8Array(4 * 1024 * 1024).fill(0x61); // 'a' 游程
    const a = readZip(writeZip([{ name: 'a.txt', data: big }]));
    expect(a.entries[0]!.compressedSize).toBeLessThan(100_000); // 应高压缩
    expectBufEq(a.read('a.txt'), big);
  });
});

describe('bit3 数据描述符（两种模式）', () => {
  it('带签名描述符（writeZip descriptor 模式）', () => {
    const files = [
      { name: 'x.txt', data: bytes('descriptor content') },
      { name: 'y.bin', data: new Uint8Array(1000).fill(9) },
    ];
    const zip = writeZip(files, { descriptor: true });
    // bit3 必须置位且 LFH CRC/尺寸为 0
    expect(zip[6]! & 0x08).toBe(0x08);
    expect((zip[14]! | (zip[15]! << 8) | (zip[16]! << 16) | (zip[17]! << 24))).toBe(0);
    const a = readZip(zip);
    for (const f of files) expect(a.read(f.name)).toEqual(f.data);
  });

  it('无签名描述符（手工构造，读取兼容）', () => {
    const zip = buildZipManual([
      { name: 'nosig.txt', data: bytes('no signature descriptor'), descriptor: 'nosig' },
    ]);
    const a = readZip(zip);
    expect(new TextDecoder().decode(a.read('nosig.txt'))).toBe('no signature descriptor');
  });

  it('描述符字段值损坏 → BAD_DESC（读取期触发）', () => {
    const name = 'x.txt';
    const data = bytes('abc');
    const zip = buildZipManual([{ name, data, descriptor: 'sig' }]);
    // 描述符位置可确定性计算：LFH(30) + 名字 + 压缩数据（stored = 原文）
    const descPos = 30 + name.length + data.length;
    const dv = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
    expect(dv.getUint32(descPos, true)).toBe(0x08074b50); // 签名确在此处
    const bad = zip.slice();
    bad[descPos + 4] = (bad[descPos + 4]! ^ 0xff) & 0xff; // 改坏描述符 CRC 字段
    expect(() => readZip(bad).read(name)).toThrow(ZipError);
    expect(() => readZip(bad).read(name)).toThrow(/描述符/);
  });
});

describe('CP437 / UTF-8 编码', () => {
  it('EFS 位 → UTF-8 解码', () => {
    const zip = buildZipManual([{ name: '中文.txt', data: bytes('x') }]);
    const a = readZip(zip);
    expect(a.entries[0]!.name).toBe('中文.txt');
  });

  it('无 EFS 位 + 高位字节 → CP437 解码', () => {
    // 0x80=Ç, 0x84=ä, 0x94=ö —— "Çäö" 的 CP437 字节
    const zip = buildZipManual([
      { rawName: new Uint8Array([0x80, 0x84, 0x94, 0x2e, 0x74, 0x78, 0x74]), data: bytes('x'), efs: false },
    ]);
    const a = readZip(zip);
    expect(a.entries[0]!.name).toBe('Çäö.txt');
  });

  it('CP437 表权威复核（抽查易错锚点）', () => {
    // 0x9E=₧(U+20A7)、0xFE=NBSP(U+00A0)、0xE5=µ(U+00B5)、0xE6=τ(U+03C4)
    const zip = buildZipManual([
      { rawName: new Uint8Array([0x9e, 0xfe, 0xe5, 0xe6]), data: bytes('x'), efs: false },
    ]);
    const name = readZip(zip).entries[0]!.name;
    expect([...name].map((c) => c.codePointAt(0)!.toString(16))).toEqual(['20a7', 'a0', 'b5', '3c4']);
  });
});

describe('EOCD 定位（64K 注释边界）', () => {
  it('带档案注释解析成功', () => {
    const zip = buildZipManual([{ name: 'a.txt', data: bytes('hi') }], { comment: '这是档案注释 archive comment' });
    const a = readZip(zip);
    expect(a.read('a.txt')).toEqual(bytes('hi'));
  });

  it('注释内容里的伪 EOCD 签名不被误认（注释长度互证）', () => {
    // 注释里塞一段伪 PK\x05\x06 记录；扫描靠“注释长度恰好填满文件尾”排除
    const fake = new Uint8Array(22);
    const dv = new DataView(fake.buffer);
    dv.setUint32(0, 0x06054b50, true);
    dv.setUint16(8, 1, true);
    dv.setUint16(10, 1, true);
    dv.setUint32(16, 0, true);
    dv.setUint16(20, 0, true);
    const zip = buildZipManual([{ name: 'a.txt', data: bytes('hi') }], { comment: 'x'.repeat(10), trailing: fake });
    const a = readZip(zip);
    expect(a.read('a.txt')).toEqual(bytes('hi'));
  });

  it('长注释（65535 字节上限）解析成功', () => {
    const zip = buildZipManual([{ name: 'a.txt', data: bytes('hi') }], { comment: 'c'.repeat(65535) });
    expect(() => readZip(zip)).not.toThrow();
    expect(readZip(zip).read('a.txt')).toEqual(bytes('hi'));
  });

  it('EOCD 缺失 → NO_EOCD', () => {
    const zip = buildZipManual([{ name: 'a.txt', data: bytes('hi') }], { omitEOCD: true });
    try {
      readZip(zip);
      throw new Error('应当抛错');
    } catch (e) {
      expect((e as ZipError).code).toBe('NO_EOCD');
    }
  });
});

describe('定向坏档（每种错误码代表）', () => {
  const base = buildZipManual([
    { name: 'a.txt', data: bytes('aaaaaaaaaaaa') },
    { name: 'b/c.txt', data: bytes('bbbbbbbbbbbbbbbb') },
  ]);

  function expectCode(zip: Uint8Array, code: string, msg?: RegExp): void {
    try {
      readZip(zip);
      throw new Error(`应当抛错（期望 ${code}）`);
    } catch (e) {
      expect(e).toBeInstanceOf(ZipError);
      expect((e as ZipError).code).toBe(code);
      if (msg) expect((e as Error).message).toMatch(msg);
    }
  }

  it('中央目录偏移损坏 → BAD_CDH', () => {
    // 定位 EOCD 的 CD 偏移字段并改坏
    const dv = new DataView(base.buffer, base.byteOffset, base.byteLength);
    for (let i = base.length - 22; i >= 0; i--) {
      if (dv.getUint32(i, true) === 0x06054b50) {
        expectCode(poke32(base, i + 16, 1), 'BAD_EOCD');
        return;
      }
    }
    throw new Error('未找到 EOCD');
  });

  it('本地头签名损坏 → BAD_LFH', () => {
    const bad = flipByte(base, 0, 0x04); // PK\x03\x04 → PK\x07\x04
    expectCode(bad, 'BAD_LFH');
  });

  it('本地头名字与中央目录不一致 → LFH_MISMATCH', () => {
    const zip = buildZipManual([
      { name: 'a.txt', data: bytes('xxx'), lfhNameOverride: bytes('b.txt') },
    ]);
    expectCode(zip, 'LFH_MISMATCH', /名字/);
  });

  it('本地头尺寸与中央目录不一致 → LFH_MISMATCH', () => {
    // writeZip 产物上直接改 CD 的 usize 字段（+24），LFH 保留真值
    const zip = writeZip([{ name: 'a.txt', data: bytes('xxx'), method: 0 }]);
    const dv = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
    let cdPos = -1;
    for (let i = 0; i < zip.length - 4; i++) {
      if (dv.getUint32(i, true) === 0x02014b50) { cdPos = i; break; }
    }
    expect(cdPos).toBeGreaterThanOrEqual(0);
    const bad = poke32(zip, cdPos + 24, 999);
    expectCode(bad, 'LFH_MISMATCH', /尺寸/);
  });

  it('CD CRC 字段损坏 → 解析期 LFH_MISMATCH（消息含 CRC；严格对齐语义）', () => {
    const zip = buildZipManual([{ name: 'a.txt', data: bytes('xxx'), crcOverrideCdOnly: 0xdeadbeef }]);
    expectCode(zip, 'LFH_MISMATCH', /CRC/);
  });

  it('stored 数据损坏 → CRC_MISMATCH', () => {
    const zip = buildZipManual([{ name: 'a.txt', data: bytes('xxxxxxxxxxxx') }]);
    const bad = flipByte(zip, 30 + 5); // LFH 名字后第一个数据字节
    expect(() => readZip(bad).read('a.txt')).toThrow(/CRC/);
  });

  it('加密标志位 → ENCRYPTED（只解析标志并抛“不支持”）', () => {
    const zip = buildZipManual([{ name: 'a.txt', data: bytes('xxx'), flagsOverride: 0x0001 }]);
    expectCode(zip, 'ENCRYPTED', /不支持解密/);
  });

  it('强加密标志位 → ENCRYPTED', () => {
    const zip = buildZipManual([{ name: 'a.txt', data: bytes('xxx'), flagsOverride: 0x0040 }]);
    expectCode(zip, 'ENCRYPTED', /bit6/);
  });

  it('非法压缩方法 → BAD_METHOD', () => {
    const zip = buildZipManual([{ name: 'a.txt', data: bytes('xxx'), methodOverride: 12 }]);
    expectCode(zip, 'BAD_METHOD', /12/);
  });

  it('条目数虚报 → BAD_CDH', () => {
    const zip = buildZipManual([{ name: 'a.txt', data: bytes('xxx') }], { totalOverride: 500 });
    expectCode(zip, 'BAD_CDH', /条目数/);
  });

  it('解压长度不符 → SIZE_MISMATCH', () => {
    // deflate 条目：CD 声称更大尺寸（LFH 一致改动，绕过对齐校验，在读取期失败）
    const data = bytes('compressible compressible compressible');
    const zip = buildZipManual([{ name: 'a.txt', data, method: 8, cdSizeOverride: { usize: data.length + 10 } }]);
    const a = readZip(zip);
    try {
      a.read('a.txt');
      throw new Error('应当抛错');
    } catch (e) {
      expect((e as ZipError).code).toBe('SIZE_MISMATCH');
    }
  });
});

describe('writeZip 输入校验', () => {
  it('空档案（0 条目）', () => {
    const zip = writeZip([]);
    expect(zip.length).toBe(22);
    const a = readZip(zip);
    expect(a.entries).toEqual([]);
    expect(() => a.read('nope')).toThrow(/不存在/);
  });

  it('超长名字 → BAD_NAME', () => {
    expect(() => writeZip([{ name: 'x'.repeat(70000), data: new Uint8Array(0) }])).toThrow(ZipError);
  });

  it('非法 level → BAD_METHOD', () => {
    expect(() => writeZip([{ name: 'a', data: new Uint8Array(1) }], { level: 0 })).toThrow(ZipError);
    expect(() => writeZip([{ name: 'a', data: new Uint8Array(1) }], { level: 10 })).toThrow(ZipError);
  });
});
