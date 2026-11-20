// ============================================================
// 移植出处：C:\works\deflate\src\deflate.ts（deflate 项目）。原样移植
// （仅加本出处注释；ZIP 语境：deflateRaw 是 ZIP 方法 8 的压缩引擎，
// 写入器按条目调用；level 参数映射到 LZ77 搜索强度 1..9）。
// 单元测试随迁：tests/deflate-port.test.ts。
// ============================================================
/**
 * deflate —— 裸 DEFLATE 流编码（RFC 1951）。
 *
 * 流水线：懒匹配 LZ77（hash chain，窗口 32768，最小匹配 3，最大 258）
 * → 符号频率统计 → 三种块型的精确位成本比较（stored / fixed / dynamic）
 * → 选总位最少者发射。动态块用“频率减半重试”构建长度受限（≤15）码长；
 * 头部（HLIT/HDIST/HCLEN + code length 表 + 16/17/18 RLE）的成本估算与
 * 实际发射共用同一份 planDynamicHeader 结果，保证两者永不脱节。
 */
import { BitWriter, reverseBits } from './bits';
import { buildCodeLengths, buildCodes } from './huffman';
import {
  LENGTH_BASE, LENGTH_EXTRA, DIST_BASE, DIST_EXTRA, DIST_SYM, LEN_SYM,
  CODELEN_ORDER, FIXED_LIT_LENGTHS, FIXED_DIST_LENGTHS,
} from './tables';

/** 搜索强度参数（形制对齐 zlib 的 configuration_table）。insertLim 为
 *  zlib max_insert_length 同款策略：超过该长度的匹配只补插尾部；
 *  maxLazy 同 max_lazy_match：达到该长度的匹配立即发射，跳过懒匹配
 *  探测（懒探测会使匹配位置的搜索开销翻倍）。 */
interface LevelParams {
  chain: number;
  nice: number;
  good: number;
  lazy: boolean;
  insertLim: number;
  maxLazy: number;
}

const LEVELS: LevelParams[] = [
  /* 1 */ { chain: 4,    nice: 8,   good: 4,   lazy: false, insertLim: 8,   maxLazy: 8 },
  /* 2 */ { chain: 8,    nice: 16,  good: 6,   lazy: false, insertLim: 16,  maxLazy: 16 },
  /* 3 */ { chain: 32,   nice: 32,  good: 10,  lazy: false, insertLim: 32,  maxLazy: 32 },
  /* 4 */ { chain: 16,   nice: 16,  good: 10,  lazy: true,  insertLim: 16,  maxLazy: 16 },
  /* 5 */ { chain: 64,   nice: 64,  good: 16,  lazy: true,  insertLim: 32,  maxLazy: 32 },
  /* 6 */ { chain: 128,  nice: 128, good: 32,  lazy: true,  insertLim: 64,  maxLazy: 64 },
  /* 7 */ { chain: 256,  nice: 258, good: 64,  lazy: true,  insertLim: 128, maxLazy: 128 },
  /* 8 */ { chain: 1024, nice: 258, good: 128, lazy: true,  insertLim: 258, maxLazy: 258 },
  /* 9 */ { chain: 4096, nice: 258, good: 258, lazy: true,  insertLim: 258, maxLazy: 258 },
];

const WINDOW = 32768;
const MIN_MATCH = 3;
const MAX_MATCH = 258;

/** LZ77 符号流：三条平行数组。literal: sym=字节值；match: sym=长度码, len/dist 有效。
 *  按输入规模预分配（每 token 至少消耗 1 个输入字节 ⇒ token 数 ≤ n），
 *  避免大输入下反复倍增拷贝制造 GC 垃圾（实测 8MB 时曾因此损失近半吞吐）。 */
class TokenBuf {
  sym: Uint16Array;
  len: Uint16Array;
  dist: Uint16Array;
  n = 0;

  constructor(n: number) {
    const cap = Math.min(Math.max(n, 1 << 12), 1 << 24);
    this.sym = new Uint16Array(cap);
    this.len = new Uint16Array(cap);
    this.dist = new Uint16Array(cap);
  }

  private grow(): void {
    const cap = this.sym.length * 2;
    const s = new Uint16Array(cap); s.set(this.sym); this.sym = s;
    const l = new Uint16Array(cap); l.set(this.len); this.len = l;
    const d = new Uint16Array(cap); d.set(this.dist); this.dist = d;
  }

  addLiteral(b: number): void {
    if (this.n === this.sym.length) this.grow();
    this.sym[this.n++] = b;
  }

  addMatch(len: number, dist: number): void {
    if (this.n === this.sym.length) this.grow();
    this.len[this.n] = len;
    this.dist[this.n] = dist;
    this.sym[this.n++] = LEN_SYM[len]!;
  }
}

/**
 * 懒匹配 LZ77。
 * hash chain：3 字节折叠哈希（zlib 同款 (b0<<10)^(b1<<5)^b2），head 32768
 * 桶 + prev 环形链。懒匹配：当前位置的匹配若短于下一位置的匹配，改发
 * 字面量并挂起下一位置的匹配。匹配覆盖到的每个位置都入链，保证后续
 * 可引用；链带 chain 预算与 nice 提前退出，杜绝病态数据的性能坍塌
 * （预算上限同时是防自环/防重复访问的硬兜底）。
 */
function lz77(data: Uint8Array, p: LevelParams): TokenBuf {
  const n = data.length;
  const t = new TokenBuf(n);
  const HM = (1 << 15) - 1;
  const head = new Int32Array(1 << 15).fill(-1);
  const prev = new Int32Array(WINDOW).fill(-1);

  // insPtr = 下一个待入链位置；不变式：所有 < insPtr 的位置已入链且仅入链一次。
  // 哈希用 UPDATE_HASH 式滚动更新：h(p+1) = ((h(p) << 5) ^ data[p+3]) & HM，
  // 每位置只读 1 个新字节（直算式需要 3 读 2 位移）。
  let insPtr = 0;
  const flushInserts = (upto: number): void => {
    const lim = Math.min(upto, n - 3); // 哈希需要 3 个完整字节
    if (insPtr <= lim) {
      let h = ((data[insPtr]! << 10) ^ (data[insPtr + 1]! << 5) ^ data[insPtr + 2]!) & HM;
      for (; insPtr <= lim; insPtr++) {
        prev[insPtr & HM] = head[h]!;
        head[h] = insPtr;
        if (insPtr < lim) h = ((h << 5) ^ data[insPtr + 3]!) & HM;
      }
    }
    if (insPtr < upto) insPtr = upto; // 尾部不足 3 字节的位置跳过
  };

  const findMatch = (pos: number): { len: number; dist: number } | null => {
    if (pos + 2 >= n) return null;
    const maxLen = Math.min(MAX_MATCH, n - pos);
    // 搜索期扩展上限：链上每个候选最多比到 nice 位，避免逐候选长扩展；
    // 中选者走出链后再单独补齐到 maxLen（一次 O(258) ，摊还可忽略）
    const maxLenS = p.nice < maxLen ? p.nice : maxLen;
    const limit = pos - WINDOW;
    let cand = head[((data[pos]! << 10) ^ (data[pos + 1]! << 5) ^ data[pos + 2]!) & HM]!;
    if (cand === pos) cand = prev[pos & HM]!; // 本位置刚入链，跳过自身
    let best = 2;
    let bestDist = 0;
    let chain = p.chain;
    while (cand >= 0 && cand >= limit && chain-- > 0) {
      // 快速拒绝：先比“当前最佳长度处”的两个字节（zlib 的 scan_end 技巧）
      if (data[cand + best] === data[pos + best] &&
          data[cand + best - 1] === data[pos + best - 1] &&
          data[cand] === data[pos] &&
          data[cand + 1] === data[pos + 1] &&
          data[cand + 2] === data[pos + 2]) {
        let l = 3;
        while (l < maxLenS && data[cand + l] === data[pos + l]) l++;
        if (l > best) {
          best = l;
          bestDist = pos - cand;
          if (l >= maxLenS) break;
          if (l >= p.good && chain > (p.chain >> 2)) chain = p.chain >> 2; // zlib 式预算削减
        }
      }
      cand = prev[cand & HM]!;
    }
    if (best >= MIN_MATCH && best === maxLenS && maxLenS < maxLen) {
      // 赢家补齐扩展：越过 nice 上限继续延伸（仅一次）
      const cand = pos - bestDist;
      let l = best;
      while (l < maxLen && data[cand + l] === data[pos + l]) l++;
      best = l;
    }
    return best >= MIN_MATCH ? { len: best, dist: bestDist } : null;
  };

  let i = 0;
  let pending: { len: number; dist: number } | null = null;
  while (i < n) {
    flushInserts(i);
    let m = pending;
    pending = null;
    if (m === null) m = findMatch(i);
    if (m === null) {
      t.addLiteral(data[i]!);
      i++;
      continue;
    }
    if (p.lazy && m.len < p.maxLazy && i + 1 < n) {
      flushInserts(i + 1);
      const m2 = findMatch(i + 1);
      if (m2 !== null && m2.len > m.len) {
        t.addLiteral(data[i]!); // 懒匹配：下一位置的匹配更长 → 发字面量
        pending = m2;
        i++;
        continue;
      }
    }
    t.addMatch(m.len, m.dist);
    if (m.len > p.insertLim) {
      // zlib max_insert_length 策略：长匹配只补插尾部两个位置，
      // 内部位置跳过（后续匹配几乎总能从更近处找到等长候选）
      if (insPtr < i + m.len - 2) insPtr = i + m.len - 2;
      flushInserts(i + m.len - 1);
    } else {
      flushInserts(i + m.len); // 匹配覆盖到的位置全部入链
    }
    i += m.len;
  }
  return t;
}

// 固定块码表（模块级构建一次）：规范码值 + 预反转版本（热路径免逐位反转）
const FIXED_LIT_CODES = buildCodes(FIXED_LIT_LENGTHS);
const FIXED_LIT_REV = /* @__PURE__ */ (() => {
  const t = new Uint16Array(288);
  for (let s = 0; s < 288; s++) t[s] = reverseBits(FIXED_LIT_CODES[s]!, FIXED_LIT_LENGTHS[s]!);
  return t;
})();
const FIXED_DIST_REV = /* @__PURE__ */ (() => {
  const t = new Uint16Array(30);
  for (let s = 0; s < 30; s++) t[s] = reverseBits(s, 5);
  return t;
})();

/**
 * 动态块头的预计算结果——成本估算与实际发射共用，保证两者永不脱节。
 */
interface DynHeader {
  nlit: number;
  ndist: number;
  clSyms: number[];      // code length 字母表的 RLE 符号流
  clExtraVal: number[];  // 对应附加位数值
  clExtraBits: number[]; // 对应附加位宽度（0/2/3/7）
  clLens: Uint8Array;    // code length 字母表的码长（≤7）
  clCodes: Uint16Array;  // 对应规范码
  hclen: number;
  streamBits: number;    // RLE 流的总编码位数
}

/** 预计算动态块头：裁剪 HLIT/HDIST、16/17/18 RLE 扫描、构建/裁剪 code length 表。 */
function planDynamicHeader(litLen: Uint8Array, distLen: Uint8Array): DynHeader {
  let nlit = 286;
  while (nlit > 257 && litLen[nlit - 1] === 0) nlit--;
  let ndist = 30;
  while (ndist > 1 && distLen[ndist - 1] === 0) ndist--;

  const total = nlit + ndist;
  const get = (idx: number): number => (idx < nlit ? litLen[idx]! : distLen[idx - nlit]!);

  const clSyms: number[] = [];
  const clExtraVal: number[] = [];
  const clExtraBits: number[] = [];
  const freqCL = new Uint32Array(19);
  const emitCL = (sym: number, ev: number, eb: number): void => {
    clSyms.push(sym);
    clExtraVal.push(ev);
    clExtraBits.push(eb);
    freqCL[sym] = freqCL[sym]! + 1;
  };

  let i = 0;
  while (i < total) {
    const v = get(i);
    let run = 1;
    while (i + run < total && get(i + run) === v) run++;
    i += run;
    if (v === 0) {
      // 零游程：18（11..138）→ 17（3..10）→ 逐个 0
      while (run >= 11) { const c = Math.min(138, run); emitCL(18, c - 11, 7); run -= c; }
      while (run >= 3) { const c = Math.min(10, run); emitCL(17, c - 3, 3); run -= c; }
      for (; run > 0; run--) emitCL(0, 0, 0);
    } else {
      // 非零游程：先发真值，再用 16 复读（3..6），余量 1..2 直接发真值
      emitCL(v, 0, 0);
      run--;
      while (run >= 3) { const c = Math.min(6, run); emitCL(16, c - 3, 2); run -= c; }
      for (; run > 0; run--) emitCL(v, 0, 0);
    }
  }

  const clLens = buildCodeLengths(freqCL, 7);
  const clCodes = buildCodes(clLens);
  let hclen = 19;
  while (hclen > 4 && clLens[CODELEN_ORDER[hclen - 1]!] === 0) hclen--;

  let streamBits = 0;
  for (let k = 0; k < clSyms.length; k++) {
    streamBits += clLens[clSyms[k]!]! + clExtraBits[k]!;
  }
  return { nlit, ndist, clSyms, clExtraVal, clExtraBits, clLens, clCodes, hclen, streamBits };
}

function emitStored(w: BitWriter, data: Uint8Array): void {
  const n = data.length;
  let off = 0;
  do {
    const c = Math.min(65535, n - off);
    const final = off + c >= n ? 1 : 0;
    w.writeBits(final, 1);
    w.writeBits(0, 2); // BTYPE = 00
    w.alignByte(); // stored 块的数据段从字节边界开始
    w.writeBits(c, 16);
    w.writeBits(~c & 0xffff, 16); // NLEN = LEN 的反码
    w.writeBytes(data, off, c);
    off += c;
  } while (off < n);
}

function emitFixed(w: BitWriter, t: TokenBuf): void {
  w.writeBits(1, 1); // BFINAL
  w.writeBits(1, 2); // BTYPE = 01
  for (let k = 0; k < t.n; k++) {
    const s = t.sym[k]!;
    w.writeBits(FIXED_LIT_REV[s]!, FIXED_LIT_LENGTHS[s]!);
    if (s >= 257) {
      const li = s - 257;
      const lenE = LENGTH_EXTRA[li]!;
      if (lenE > 0) w.writeBits(t.len[k]! - LENGTH_BASE[li]!, lenE);
      const ds = DIST_SYM[t.dist[k]!]!;
      w.writeBits(FIXED_DIST_REV[ds]!, 5);
      const de = DIST_EXTRA[ds]!;
      if (de > 0) w.writeBits(t.dist[k]! - DIST_BASE[ds]!, de);
    }
  }
  w.writeBits(FIXED_LIT_REV[256]!, 7); // EOB
}

function emitDynamic(
  w: BitWriter,
  t: TokenBuf,
  hdr: DynHeader,
  litLen: Uint8Array,
  litRev: Uint16Array,
  distLen: Uint8Array,
  distRev: Uint16Array,
): void {
  w.writeBits(1, 1); // BFINAL
  w.writeBits(2, 2); // BTYPE = 10
  w.writeBits(hdr.nlit - 257, 5);
  w.writeBits(hdr.ndist - 1, 5);
  w.writeBits(hdr.hclen - 4, 4);
  for (let k = 0; k < hdr.hclen; k++) {
    w.writeBits(hdr.clLens[CODELEN_ORDER[k]!]!, 3);
  }
  for (let k = 0; k < hdr.clSyms.length; k++) {
    const s = hdr.clSyms[k]!;
    w.writeBits(reverseBits(hdr.clCodes[s]!, hdr.clLens[s]!), hdr.clLens[s]!);
    const eb = hdr.clExtraBits[k]!;
    if (eb > 0) w.writeBits(hdr.clExtraVal[k]!, eb);
  }
  for (let k = 0; k < t.n; k++) {
    const s = t.sym[k]!;
    w.writeBits(litRev[s]!, litLen[s]!);
    if (s >= 257) {
      const li = s - 257;
      const lenE = LENGTH_EXTRA[li]!;
      if (lenE > 0) w.writeBits(t.len[k]! - LENGTH_BASE[li]!, lenE);
      const ds = DIST_SYM[t.dist[k]!]!;
      w.writeBits(distRev[ds]!, distLen[ds]!);
      const de = DIST_EXTRA[ds]!;
      if (de > 0) w.writeBits(t.dist[k]! - DIST_BASE[ds]!, de);
    }
  }
  w.writeBits(litRev[256]!, litLen[256]!); // EOB
}

/**
 * 裸 DEFLATE 编码。level 1..9 只影响 LZ77 搜索强度；块型决策对每种块型
 * 精确计位（动态块含头部与 RLE 流），选总位最少的发射。整份输入作为一个
 * 逻辑块（stored 会按 65535 切片），BFINAL 置于最后一片。
 */
export function deflateRaw(data: Uint8Array, level = 6): Uint8Array {
  if (typeof level !== 'number' || !Number.isInteger(level) || level < 1 || level > 9) {
    throw new Error(`deflate：level 必须是 1..9 的整数，收到 ${String(level)}`);
  }
  const p = LEVELS[level - 1]!;
  const n = data.length;
  const t = lz77(data, p);

  // —— 频率统计（EOB 恒出现一次）——
  const freqLit = new Uint32Array(286);
  const freqDist = new Uint32Array(30);
  for (let k = 0; k < t.n; k++) {
    const s = t.sym[k]!;
    freqLit[s] = freqLit[s]! + 1;
    if (s >= 257) {
      const ds = DIST_SYM[t.dist[k]!]!;
      freqDist[ds] = freqDist[ds]! + 1;
    }
  }
  freqLit[256] = freqLit[256]! + 1;

  const litLen = buildCodeLengths(freqLit, 15);
  const distLen = buildCodeLengths(freqDist, 15);
  const litCodes = buildCodes(litLen);
  const distCodes = buildCodes(distLen);
  const litRev = new Uint16Array(286);
  for (let s = 0; s < 286; s++) litRev[s] = reverseBits(litCodes[s]!, litLen[s]!);
  const distRev = new Uint16Array(30);
  for (let s = 0; s < 30; s++) distRev[s] = reverseBits(distCodes[s]!, distLen[s]!);

  // —— 三种块型的精确位成本 ——
  let fixedBits = 3 + FIXED_LIT_LENGTHS[256]!; // 块头 + EOB
  let dynBits = 0;
  for (let k = 0; k < t.n; k++) {
    const s = t.sym[k]!;
    if (s < 256) {
      fixedBits += FIXED_LIT_LENGTHS[s]!;
      dynBits += litLen[s]!;
    } else {
      const li = s - 257;
      const lenE = LENGTH_EXTRA[li]!;
      const ds = DIST_SYM[t.dist[k]!]!;
      fixedBits += FIXED_LIT_LENGTHS[s]! + lenE + 5 + DIST_EXTRA[ds]!;
      dynBits += litLen[s]! + lenE + distLen[ds]! + DIST_EXTRA[ds]!;
    }
  }
  const hdr = planDynamicHeader(litLen, distLen);
  dynBits += 3 + 5 + 5 + 4 + 3 * hdr.hclen + hdr.streamBits + litLen[256]!;

  const chunks = Math.max(1, Math.ceil(n / 65535));
  const storedBits = 40 * chunks + 8 * n + 7; // 含对齐余量

  const w = new BitWriter(n + (n >>> 3) + 4096);

  if (storedBits <= fixedBits && storedBits <= dynBits) {
    emitStored(w, data);
  } else if (fixedBits <= dynBits) {
    emitFixed(w, t);
  } else {
    emitDynamic(w, t, hdr, litLen, litRev, distLen, distRev);
  }
  return w.finish();
}
