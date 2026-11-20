// ============================================================
// 移植出处：C:\works\deflate\src\inflate.ts（deflate 项目）。原样移植
// （仅加本出处注释；ZIP 语境：inflate 解码 ZIP 方法 8 的裸 DEFLATE 条目流，
// sizeHint 用中央目录的 uncompressed size 预分配）。
// 单元测试随迁：tests/deflate-port.test.ts。
// ============================================================
/**
 * inflate —— 裸 DEFLATE 流解码（RFC 1951）。
 *
 * 结构：BitReader（LSB-first 位流）+ 表驱动 Huffman（buildDecodeTable）
 * + 三种块型（00 stored / 01 fixed / 10 dynamic）。所有畸形输入一律抛错：
 * 坏流必须“抛错或返回”，绝不死循环、绝不越界——这是安全边界。
 * 每个解码步都严格消费位流（每符号至少 1 位），进度单调，故不可能挂死。
 */
import { BitReader } from './bits';
import { buildDecodeTable, type DecodeTable } from './huffman';
import {
  LENGTH_BASE, LENGTH_EXTRA, DIST_BASE, DIST_EXTRA, CODELEN_ORDER,
  FIXED_LIT_LENGTHS, FIXED_DIST_LENGTHS,
} from './tables';

/** 解码输出缓冲：倍增扩容 + 重叠安全的 LZ77 回拷。 */
class OutBuf {
  buf: Uint8Array;
  len = 0;

  constructor(cap: number) {
    this.buf = new Uint8Array(Math.max(64, cap));
  }

  /** 模块内热循环（inflateBlock）直接调用；外部不可见。 */
  grow(need: number): void {
    let cap = this.buf.length;
    while (cap < need) cap *= 2;
    const nb = new Uint8Array(cap);
    nb.set(this.buf.subarray(0, this.len));
    this.buf = nb;
  }

  /** 整段拷入（stored 块数据段）。 */
  writeBytes(src: Uint8Array, start: number, count: number): void {
    if (this.len + count > this.buf.length) this.grow(this.len + count);
    this.buf.set(src.subarray(start, start + count), this.len);
    this.len += count;
  }

  bytes(): Uint8Array {
    return this.buf.subarray(0, this.len);
  }
}

// 固定块的两张解码表，模块级一次构建（litlen 最深 9 位，dist 5 位）。
const FIXED_LIT_TABLE = buildDecodeTable(FIXED_LIT_LENGTHS);
const FIXED_DIST_TABLE = buildDecodeTable(FIXED_DIST_LENGTHS);

/** 表驱动解码一个符号。非法码字 / 位流不足都抛错。 */
function decodeSym(r: BitReader, table: Int32Array, maxLen: number): number {
  const e = table[r.peekBits(maxLen)]!;
  const len = e & 15;
  if (len === 0) throw new Error('DEFLATE：无效的 Huffman 码字');
  r.consumeBits(len);
  return e >>> 4;
}

/**
 * 解码一个 Huffman 块的主体（字面量/长度/距离循环），直到 EOB。
 *
 * 性能关键路径：BitReader/OutBuf 的状态（data/pos/acc/cnt/end 与
 * buf/len/cap）全部提升为局部变量，peek/consume/refill/回拷全部内联，
 * 消除每符号 4 次方法调用的开销。块体解码期间这些状态独占（头解析在
 * 进入本函数前完成），异常路径无需回写——整个解码立即中止。
 */
function inflateBlock(r: BitReader, out: OutBuf, lit: DecodeTable, dist: DecodeTable): void {
  const d = r.data;
  const end = r.end;
  let acc = r.acc;
  let cnt = r.cnt;
  let pos = r.pos;
  let buf = out.buf;
  let len = out.len;
  let cap = buf.length;
  const lt = lit.table;
  const lmMask = (1 << lit.maxLen) - 1;
  const dt = dist.table;
  const dmMask = (1 << dist.maxLen) - 1;

  for (;;) {
    // —— 装载（内联 refill）：退出时 cnt > 24 或字节耗尽 ——
    while (cnt <= 24 && pos < end) {
      acc = (acc | (d[pos++]! << cnt)) >>> 0;
      cnt += 8;
    }
    // —— 解码字面量/长度符号 ——
    const e = lt[acc & lmMask]!;
    const codelen = e & 15;
    if (codelen === 0) throw new Error('DEFLATE：无效的 Huffman 码字');
    if (codelen > cnt) throw new Error('DEFLATE：位流意外结束（Huffman 码不完整）');
    acc >>>= codelen;
    cnt -= codelen;
    const sym = e >>> 4;
    if (sym < 256) {
      // 字面量：直接写入输出缓冲
      if (len === cap) {
        out.len = len;
        out.grow(len + 1);
        buf = out.buf;
        cap = buf.length;
      }
      buf[len++] = sym;
      continue;
    }
    if (sym === 256) break; // 块结束
    if (sym > 285) throw new Error(`DEFLATE：非法字面量/长度符号 ${sym}`);

    // —— 匹配长度（附加位 ≤ 5，通常已在累加器中）——
    const li = sym - 257;
    const lenE = LENGTH_EXTRA[li]!;
    let length = LENGTH_BASE[li]!;
    if (lenE > 0) {
      while (cnt < lenE && pos < end) {
        acc = (acc | (d[pos++]! << cnt)) >>> 0;
        cnt += 8;
      }
      if (cnt < lenE) throw new Error('DEFLATE：位流意外结束（长度扩展位不足）');
      length += acc & ((1 << lenE) - 1);
      acc >>>= lenE;
      cnt -= lenE;
    }

    // —— 距离符号 ——
    while (cnt <= 24 && pos < end) {
      acc = (acc | (d[pos++]! << cnt)) >>> 0;
      cnt += 8;
    }
    const de = dt[acc & dmMask]!;
    const dcode = de & 15;
    if (dcode === 0) throw new Error('DEFLATE：无效的 Huffman 码字');
    if (dcode > cnt) throw new Error('DEFLATE：位流意外结束（Huffman 码不完整）');
    acc >>>= dcode;
    cnt -= dcode;
    const dsym = de >>> 4;
    if (dsym > 29) throw new Error(`DEFLATE：非法距离符号 ${dsym}`);
    const distE = DIST_EXTRA[dsym]!;
    let distv = DIST_BASE[dsym]!;
    if (distE > 0) {
      while (cnt < distE && pos < end) {
        acc = (acc | (d[pos++]! << cnt)) >>> 0;
        cnt += 8;
      }
      if (cnt < distE) throw new Error('DEFLATE：位流意外结束（距离扩展位不足）');
      distv += acc & ((1 << distE) - 1);
      acc >>>= distE;
      cnt -= distE;
    }

    // —— 回拷 ——
    if (distv > len) throw new Error('DEFLATE：距离越界（回看超出已解压输出）');
    const to = len;
    if (to + length > cap) {
      out.len = len;
      out.grow(to + length);
      buf = out.buf;
      cap = buf.length;
    }
    if (distv >= length) {
      buf.copyWithin(to, to - distv, to - distv + length);
    } else if (length <= 32) {
      // 小匹配（文本主流）：纯字节循环最省——每次读的都是刚写好的字节
      for (let k = 0; k < length; k++) buf[to + k] = buf[to + k - distv]!;
    } else {
      let copied = 0;
      for (; copied < distv; copied++) buf[to + copied] = buf[to + copied - distv]!;
      while (copied < length) {
        const c = Math.min(distv, length - copied);
        buf.copyWithin(to + copied, to + copied - distv, to + copied - distv + c);
        copied += c;
      }
    }
    len += length;
  }

  // 回写状态（正常退出块时）
  r.acc = acc;
  r.cnt = cnt;
  r.pos = pos;
  out.len = len;
}

/** 解析动态块头：HLIT/HDIST/HCLEN + code length 表 + 16/17/18 RLE 码长序列。 */
function readDynamicTables(r: BitReader): { lit: DecodeTable; dist: DecodeTable } {
  const nlit = r.readBits(5) + 257;
  const ndist = r.readBits(5) + 1;
  const hclen = r.readBits(4) + 4;
  if (nlit > 286) throw new Error(`DEFLATE：HLIT 越界（litlen 符号数 ${nlit} > 286）`);
  if (ndist > 30) throw new Error(`DEFLATE：HDIST 越界（dist 符号数 ${ndist} > 30）`);

  // code length 字母表的码长（传输顺序见 CODELEN_ORDER）
  const clLens = new Uint8Array(19);
  for (let k = 0; k < hclen; k++) clLens[CODELEN_ORDER[k]!] = r.readBits(3);
  const cl = buildDecodeTable(clLens); // 该表的不完整码一律非法（对齐 zlib）

  // RLE 解码出 litlen + dist 两段合并的码长序列
  const total = nlit + ndist;
  const lens = new Uint8Array(total);
  let i = 0;
  while (i < total) {
    const sym = decodeSym(r, cl.table, cl.maxLen);
    if (sym < 16) {
      lens[i++] = sym;
    } else if (sym === 16) {
      // 复读前一个码长 3..6 次（2 位附加）
      if (i === 0) throw new Error('DEFLATE：code length 16 缺少前值');
      const rep = 3 + r.readBits(2);
      if (i + rep > total) throw new Error('DEFLATE：code length 16 重复越界');
      const prev = lens[i - 1]!;
      for (let j = 0; j < rep; j++) lens[i++] = prev;
    } else if (sym === 17) {
      // 复读 0 共 3..10 次（3 位附加）
      const rep = 3 + r.readBits(3);
      if (i + rep > total) throw new Error('DEFLATE：code length 17 重复越界');
      for (let j = 0; j < rep; j++) lens[i++] = 0;
    } else {
      // 18：复读 0 共 11..138 次（7 位附加）
      const rep = 11 + r.readBits(7);
      if (i + rep > total) throw new Error('DEFLATE：code length 18 重复越界');
      for (let j = 0; j < rep; j++) lens[i++] = 0;
    }
  }

  const litLens = lens.subarray(0, nlit);
  const distLens = lens.subarray(nlit);
  if (litLens[256] === 0) throw new Error('DEFLATE：动态块缺少 end-of-block 码');
  return {
    lit: buildDecodeTable(litLens, { allowIncompleteSingle: true }),
    dist: buildDecodeTable(distLens, { allowIncompleteSingle: true }),
  };
}

export interface InflateRawResult {
  /** 解压输出。 */
  out: Uint8Array;
  /** 最终块结束后的字节对齐位置（gzip 用它定位 trailer）。 */
  endBytePos: number;
}

/**
 * 裸 DEFLATE 解码（内部入口）：从 startByte 起，解码到 BFINAL 块结束。
 * 对外暴露 endBytePos 以支撑 gzip 容器的 trailer 定位。
 */
export function inflateRawImpl(data: Uint8Array, startByte = 0, sizeHint?: number): InflateRawResult {
  const r = new BitReader(data, startByte);
  const out = new OutBuf(sizeHint ?? 1 << 16);

  for (;;) {
    const bfinal = r.readBits(1);
    const btype = r.readBits(2);
    if (btype === 0) {
      // stored：跳到字节边界，LEN/NLEN 互为反码校验，数据整段拷入
      r.alignByte();
      const p = r.bytePos;
      if (p + 4 > data.length) throw new Error('DEFLATE：stored 块头不完整');
      const lenv = data[p]! | (data[p + 1]! << 8);
      const nlen = data[p + 2]! | (data[p + 3]! << 8);
      if ((lenv ^ nlen) !== 0xffff) throw new Error('DEFLATE：stored 块 LEN/NLEN 校验失败');
      const endP = p + 4 + lenv;
      if (endP > data.length) throw new Error('DEFLATE：stored 块数据段越界');
      out.writeBytes(data, p + 4, lenv);
      r.seekByte(endP);
    } else if (btype === 1) {
      inflateBlock(r, out, FIXED_LIT_TABLE, FIXED_DIST_TABLE);
    } else if (btype === 2) {
      const { lit, dist } = readDynamicTables(r);
      inflateBlock(r, out, lit, dist);
    } else {
      throw new Error(`DEFLATE：非法块类型 ${btype}`);
    }
    if (bfinal === 1) break;
  }

  r.alignByte(); // 收尾：丢弃最终块尾的填充位
  return { out: out.bytes(), endBytePos: r.bytePos };
}

/**
 * 解码裸 DEFLATE 流（无 zlib/gzip 头）。
 * sizeHint 是输出缓冲的预分配提示（性能优化，不影响结果）。
 * 最终块之后的尾随字节被忽略（与 node:zlib 的 inflateRaw 行为一致，
 * 已实证：node 对“完整流 + 尾随垃圾”返回解压结果）。
 */
export function inflate(data: Uint8Array, sizeHint?: number): Uint8Array {
  return inflateRawImpl(data, 0, sizeHint).out;
}
