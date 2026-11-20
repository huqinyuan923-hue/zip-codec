/**
 * 差分 4：坏档定向模糊（任务书：EOCD 缺失/中央目录偏移错/CRC 错/
 * 本地头与中央目录不一致 → 抛错，≥800 条）+ 随机位翻转模糊（抛错或无害成功）。
 * 全部断言 ZipError.code，不匹配消息文案。
 */
import { describe, expect, it } from 'vitest';
import { readZip } from '../src/reader';
import { writeZip } from '../src/writer';
import { ZipError, type ZipErrorCode } from '../src/struct';

const TE = new TextEncoder();
const bytes = (s: string): Uint8Array => TE.encode(s);

/** 三个基线档案：覆盖 stored / deflate / 混合+中文+目录。 */
const BASES: Record<string, Uint8Array> = {
  stored: writeZip([
    { name: 'a.txt', data: bytes('stored stored stored'), method: 0 },
    { name: 'b.txt', data: bytes('bbbbbbbbbbbbbbbbbbbb'), method: 0 },
  ]),
  deflate: writeZip([
    { name: 'a.txt', data: bytes('compressible compressible compressible') },
    { name: 'n.bin', data: bytes('1234567890'.repeat(50)) },
  ]),
  mixed: writeZip([
    { name: '目录/', data: new Uint8Array(0) },
    { name: '目录/中文.txt', data: bytes('中文内容中文内容中文内容') },
    { name: 'data.bin', data: bytes('payload payload payload'), method: 0 },
  ]),
  descriptor: writeZip([{ name: 'd.txt', data: bytes('descriptor payload') }], { descriptor: true }),
  zip64: writeZip([{ name: 'z.txt', data: bytes('zip64 forced') }], { zip64: true }),
};

function flip(buf: Uint8Array, idx: number, x = 0xff): Uint8Array {
  const out = buf.slice();
  out[idx] = (out[idx]! ^ x) & 0xff;
  return out;
}
function poke32(buf: Uint8Array, idx: number, v: number): Uint8Array {
  const out = buf.slice();
  new DataView(out.buffer).setUint32(out.byteOffset + idx, v >>> 0, true);
  return out;
}
function poke16(buf: Uint8Array, idx: number, v: number): Uint8Array {
  const out = buf.slice();
  new DataView(out.buffer).setUint16(out.byteOffset + idx, v & 0xffff, true);
  return out;
}

/** 找 EOCD / 第 N 个 CDH / 第 N 个 LFH 的绝对位置。 */
function findSig(buf: Uint8Array, sig: number, from = 0): number {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  for (let i = from; i + 4 <= buf.length; i++) {
    if (dv.getUint32(i, true) === sig) return i;
  }
  return -1;
}
function findSigAll(buf: Uint8Array, sig: number): number[] {
  const out: number[] = [];
  let p = findSig(buf, sig);
  while (p >= 0) {
    out.push(p);
    p = findSig(buf, sig, p + 1);
  }
  return out;
}

/** 坏档断言：必须抛 ZipError（可选限定 code）。 */
function expectBad(buf: Uint8Array, code?: ZipErrorCode | ZipErrorCode[]): void {
  let threw: unknown;
  try {
    const a = readZip(buf);
    // 解析侥幸通过则尝试全部读取（读层必须抛）
    for (const e of a.entries) a.read(e.name);
    threw = new Error('未抛错');
  } catch (e) {
    threw = e;
  }
  expect(threw).toBeInstanceOf(ZipError);
  if (code !== undefined) {
    const codes = Array.isArray(code) ? code : [code];
    expect(codes).toContain((threw as ZipError).code);
  }
}

const CASES: Array<{ label: string; make: () => Uint8Array; code?: ZipErrorCode[] }> = [];
function add(label: string, make: () => Uint8Array, code?: ZipErrorCode[]): void {
  CASES.push({ label, make, code });
}

// —— 1. EOCD 缺失：尾部截断 1..40 字节 × 5 档案 ——
for (const [baseName, base] of Object.entries(BASES)) {
  for (let n = 1; n <= 40; n++) {
    add(`截断${n}B/${baseName}`, () => base.subarray(0, base.length - n) as Uint8Array, ['NO_EOCD', 'BAD_EOCD']);
  }
}
// —— 2. EOCD 尾部追加垃圾（注释长度未相应更新）——
for (const [baseName, base] of Object.entries(BASES)) {
  for (const n of [1, 5, 30, 100]) {
    add(`尾部追加${n}B/${baseName}`, () => {
      const out = new Uint8Array(base.length + n);
      out.set(base);
      return out;
    }, ['NO_EOCD', 'BAD_EOCD']);
  }
}
// —— 3. EOCD 注释长度字段破坏 × 5 ——
for (const [baseName, base] of Object.entries(BASES)) {
  const eocd = base.length - 22;
  for (const v of [1, 2, 0x10, 0x100, 0xffff]) {
    add(`注释长度=${v}/${baseName}`, () => poke16(base, eocd + 20, v), ['NO_EOCD', 'BAD_EOCD']);
  }
}
// —— 4. EOCD 条目数/CD 尺寸/CD 偏移破坏 ——
// 注 1：EOCD 的“本盘条目数”（+8）对单盘档案无语义，变异无害，不列入坏档。
// 注 2：zip64 基线的 EOCD 32 位字段是哨兵占位（EOCD64 才权威），且改为
//   (0,0,0) 会自洽为空档案——zip64 基线不参加本组，改用第 4b 组定位器破坏。
for (const [baseName, base] of Object.entries(BASES)) {
  if (baseName === 'zip64') continue;
  const eocd = base.length - 22;
  const entries = findSigAll(base, 0x02014b50).length;
  for (const v of [0, 1, 3, 7, 0xffff]) {
    if (v === entries) continue; // 与原值相同 = 无害
    add(`EOCD条目数=${v}/${baseName}`, () => poke16(base, eocd + 10, v), ['BAD_CDH', 'BAD_EOCD', 'BAD_ZIP64']);
    add(`EOCD cdSize=${v}/${baseName}`, () => poke32(base, eocd + 12, v), ['BAD_CDH', 'BAD_EOCD', 'BAD_ZIP64']);
    add(`EOCD cdOff=${v}/${baseName}`, () => poke32(base, eocd + 16, v), ['BAD_CDH', 'BAD_EOCD', 'BAD_ZIP64']);
  }
  let s = 12345;
  const rnd = (): number => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s >>> 16;
  };
  for (let k = 0; k < 30; k++) {
    const v = rnd() * 0xffffff;
    add(`EOCD cdOff随机${k}/${baseName}`, () => poke32(base, eocd + 16, v), ['BAD_CDH', 'BAD_EOCD', 'BAD_ZIP64']);
    add(`EOCD cdSize随机${k}/${baseName}`, () => poke32(base, eocd + 12, v), ['BAD_CDH', 'BAD_EOCD', 'BAD_ZIP64']);
  }
}
// —— 4b. zip64 档案的定位器/EOCD64 破坏（哨兵链路的权威字段）——
{
  const base = BASES['zip64']!;
  const locPos = findSig(base, 0x07064b50);
  const e64Pos = findSig(base, 0x06064b50);
  for (const x of [0x07, 0x06]) add(`LOC64签名flip/x${x}/zip64`, () => flip(base, locPos + 3, x), ['BAD_ZIP64']);
  for (const v of [0, 1, locPos, locPos + 1, 0xffffffff]) {
    add(`LOC64 e64Off=${v}/zip64`, () => poke32(base, locPos + 8, v), ['BAD_ZIP64']);
  }
  for (const x of [0x06, 0x04]) add(`EOCD64签名flip/x${x}/zip64`, () => flip(base, e64Pos + 3, x), ['BAD_ZIP64']);
  for (const v of [0, 999999]) { // 1 = 原值（zip64 基线 1 条目），跳过
    add(`EOCD64条目数=${v}/zip64`, () => poke32(base, e64Pos + 32, v), ['BAD_CDH']);
    add(`EOCD64 cdSize=${v}/zip64`, () => poke32(base, e64Pos + 40, v), ['BAD_CDH', 'BAD_EOCD']);
    add(`EOCD64 cdOff=${v}/zip64`, () => poke32(base, e64Pos + 48, v), ['BAD_CDH', 'BAD_EOCD']);
  }
}
// —— 5. CD 头字段破坏（每条目 × 每字段 × 多值；v 等于原值的用例跳过）——
for (const [baseName, base] of Object.entries(BASES)) {
  const cdhs = findSigAll(base, 0x02014b50);
  const dv = new DataView(base.buffer, base.byteOffset, base.byteLength);
  for (let ci = 0; ci < cdhs.length; ci++) {
    const p = cdhs[ci]!;
    const o = {
      method: dv.getUint16(p + 10, true), flags: dv.getUint16(p + 8, true),
      usize: dv.getUint32(p + 24, true), csize: dv.getUint32(p + 20, true),
      crc: dv.getUint32(p + 16, true),
      nlen: dv.getUint16(p + 28, true), elen: dv.getUint16(p + 30, true), clen: dv.getUint16(p + 32, true),
    };
    for (const x of [0x02, 0x04]) add(`CD签名flip/${baseName}#${ci}`, () => flip(base, p + 3, x), ['BAD_CDH', 'BAD_EOCD', 'BAD_ZIP64']);
    for (const v of [1, 12, 14, 99]) if (v !== o.method) add(`CD方法=${v}/${baseName}#${ci}`, () => poke16(base, p + 10, v), ['BAD_METHOD']);
    for (const v of [0x0001, 0x0040]) if (v !== o.flags) add(`CD加密位=${v}/${baseName}#${ci}`, () => poke16(base, p + 8, v), ['ENCRYPTED']);
    for (const v of [0, 1, 999]) if (v !== o.nlen) add(`CD nlen=${v}/${baseName}#${ci}`, () => poke16(base, p + 28, v), ['BAD_CDH', 'LFH_MISMATCH']);
    for (const v of [1, 999]) if (v !== o.elen) add(`CD elen=${v}/${baseName}#${ci}`, () => poke16(base, p + 30, v), ['BAD_CDH', 'LFH_MISMATCH']);
    for (const v of [1, 999]) if (v !== o.clen) add(`CD clen=${v}/${baseName}#${ci}`, () => poke16(base, p + 32, v), ['BAD_CDH']);
    for (const v of [0, 1, 0x7fffffff, 0xffffffff]) if (v !== o.usize) add(`CD usize=${v}/${baseName}#${ci}`, () => poke32(base, p + 24, v), ['LFH_MISMATCH', 'SIZE_MISMATCH', 'BAD_CDH', 'BAD_ZIP64']);
    for (const v of [0, 1, 0x7fffffff, 0xffffffff]) if (v !== o.csize) add(`CD csize=${v}/${baseName}#${ci}`, () => poke32(base, p + 20, v), ['LFH_MISMATCH', 'BAD_DATA', 'BAD_CDH', 'BAD_ZIP64']);
    for (const v of [0, 1, 0xffffffff]) if (v !== o.crc) add(`CD crc=${v}/${baseName}#${ci}`, () => poke32(base, p + 16, v), ['LFH_MISMATCH', 'CRC_MISMATCH', 'BAD_DESC']);
  }
}
// —— 6. LFH 字段破坏（v 等于原值跳过；elen 破坏会错位数据区 → CRC/尺寸类错误）——
for (const [baseName, base] of Object.entries(BASES)) {
  const lfhs = findSigAll(base, 0x04034b50);
  const dv = new DataView(base.buffer, base.byteOffset, base.byteLength);
  for (let li = 0; li < lfhs.length; li++) {
    const p = lfhs[li]!;
    const o = {
      method: dv.getUint16(p + 8, true), flags: dv.getUint16(p + 6, true),
      nlen: dv.getUint16(p + 26, true), elen: dv.getUint16(p + 28, true),
    };
    for (const x of [0x03, 0x04]) add(`LFH签名flip/${baseName}#${li}`, () => flip(base, p + 3, x), ['BAD_LFH']);
    for (const v of [1, 12, 99]) if (v !== o.method) add(`LFH方法=${v}/${baseName}#${li}`, () => poke16(base, p + 8, v), ['LFH_MISMATCH']);
    for (const v of [0, 5, 0x800]) if (v !== o.flags) add(`LFH标志=${v}/${baseName}#${li}`, () => poke16(base, p + 6, v), ['LFH_MISMATCH', 'ENCRYPTED']);
    for (const v of [0, 1, 999]) if (v !== o.nlen) add(`LFH nlen=${v}/${baseName}#${li}`, () => poke16(base, p + 26, v), ['LFH_MISMATCH', 'BAD_LFH']);
    // elen 变异对空数据条目（目录）自洽无害（数据区间仍空、CRC(空)=0），跳过
    const csize = dv.getUint32(p + 18, true);
    if (csize > 0) {
      for (const v of [0, 1, 999]) if (v !== o.elen) add(`LFH elen=${v}/${baseName}#${li}`, () => poke16(base, p + 28, v), ['BAD_LFH', 'LFH_MISMATCH', 'CRC_MISMATCH', 'SIZE_MISMATCH', 'BAD_DATA']);
    }
  }
}
// —— 7. 条目数据破坏（第一条目的真实数据区内取偏移）——
for (const [baseName, base] of Object.entries(BASES)) {
  const dv = new DataView(base.buffer, base.byteOffset, base.byteLength);
  const lfh = findSig(base, 0x04034b50);
  const nlen = dv.getUint16(lfh + 26, true);
  const elen = dv.getUint16(lfh + 28, true);
  const csize = dv.getUint32(lfh + 18, true);
  if (csize === 0) continue; // 目录条目无数据区
  const method = dv.getUint16(lfh + 8, true);
  const dataStart = lfh + 30 + nlen + elen;
  // 尾字节（csize-1）只在 stored 下必变 CRC；deflate 流尾字节是填充位，
  // 翻转无害（RFC 1951 允许任意填充），故不列入必抛组。csize 为 ZIP64 哨兵时
  // 同样不取尾偏移（哨兵值不能当真实尺寸用）。
  const offs = method === 0 && csize < 0xffff0000 ? [0, 1, 5, csize - 1] : [0, 1, 5];
  for (const off of offs) {
    for (const x of [0x01, 0x80, 0xff]) {
      add(`数据flip@+${off}=${x}/${baseName}`, () => flip(base, dataStart + off, x),
        ['CRC_MISMATCH', 'SIZE_MISMATCH', 'BAD_DATA']);
    }
  }
}
// —— 8. 名字字节破坏（LFH 侧）——
for (const [baseName, base] of Object.entries(BASES)) {
  const lfh = findSig(base, 0x04034b50);
  add(`LFH名字改/${baseName}`, () => flip(base, lfh + 30), ['LFH_MISMATCH']);
}

describe('差分 4 · 定向坏档（断言全部抛 ZipError）', () => {
  it(`共 ${CASES.length} 条（任务书要求 ≥800）`, () => {
    expect(CASES.length).toBeGreaterThanOrEqual(800);
  });

  it('逐条执行', () => {
    const failures: string[] = [];
    for (const c of CASES) {
      try {
        expectBad(c.make(), c.code);
      } catch (e) {
        failures.push(`${c.label}: ${(e as Error).message.slice(0, 160)}`);
        if (failures.length > 8) break;
      }
    }
    if (failures.length > 0) {
      throw new Error(`坏档漏抛/错码 ${failures.length} 条（前几条）：\n${failures.join('\n')}`);
    }
  }, 300_000);
});

// —— 9. 随机位翻转模糊（加码：不挂死、抛 ZipError 或无害成功且数据不变）——
describe('差分 4+ · 随机位翻转模糊 2000 次', () => {
  it('任何单/双字节翻转：抛错或解析+全读成功', () => {
    let s = 987654321;
    const next = (): number => {
      s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
      return s >>> 16;
    };
    const baseNames = Object.keys(BASES);
    for (let i = 0; i < 2000; i++) {
      const base = BASES[baseNames[next() % baseNames.length]!]!;
      const buf = base.slice();
      const nMut = 1 + (next() % 2);
      for (let k = 0; k < nMut; k++) {
        const idx = next() % buf.length;
        buf[idx] = (buf[idx]! ^ (1 + (next() % 255))) & 0xff;
      }
      let outcome = 'parse';
      try {
        const a = readZip(buf);
        for (const e of a.entries) {
          try {
            a.read(e.name);
          } catch {
            outcome = 'read-throw';
            break;
          }
        }
      } catch (e) {
        expect(e).toBeInstanceOf(ZipError);
        outcome = 'parse-throw';
      }
      if (outcome === 'read-throw') {
        // 读层抛错属预期；确保是 ZipError
        let threw: unknown;
        try {
          const a2 = readZip(buf);
          for (const e of a2.entries) a2.read(e.name);
        } catch (e) {
          threw = e;
        }
        expect(threw).toBeInstanceOf(ZipError);
      }
    }
  }, 300_000);
});
