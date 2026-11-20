// ============================================================
// 移植出处：C:\works\deflate\src\huffman.ts（deflate 项目）。原样移植
// （仅加本出处注释）；单元测试随迁：tests/deflate-port.test.ts。
// ============================================================
/**
 * Huffman 编解码核心：规范码分配、表驱动解码表、频率 → 受限码长。
 *
 * 关键认识：Huffman 码按 MSB-first 进入流，而位流按 LSB-first 消费，
 * 两者相差一个位反转。解码端把这个反转一次性做进填表步骤，热循环里
 * 用“直接查表”代替逐位走树；编码端发射前反转一次码字。
 */
import { reverseBits } from './bits';

export const MAX_CODE_BITS = 15;

/** 解码表：table[idx] = 码长 | (符号 << 4)；码长 0 表示非法码字。 */
export interface DecodeTable {
  table: Int32Array;
  maxLen: number;
}

/**
 * 由码长数组构建“全展开”表驱动解码表。
 *
 * lengths[sym] = 码长（0 = 符号未使用）。表尺寸 2^maxLen，下标是“后续
 * maxLen 个流位按 LSB-first 累积的整数”。校验规则对齐 zlib（inftrees.c）：
 *  - 超订（over-subscribed）：一律非法；
 *  - 不完整（incomplete）：非法，除非恰好只有一个长度为 1 的码
 *    （allowIncompleteSingle —— RFC 1951 §3.2.2 允许的单距离码特例）；
 *  - 全零空表放行，非法性推迟到解码命中时报错（与 zlib 一致）。
 */
export function buildDecodeTable(
  lengths: ArrayLike<number>,
  opts: { allowIncompleteSingle?: boolean } = {},
): DecodeTable {
  // 1) 统计各码长的符号数
  const count = new Uint16Array(MAX_CODE_BITS + 1);
  let maxLen = 0;
  for (let sym = 0; sym < lengths.length; sym++) {
    const l = lengths[sym]!;
    if (l === 0) continue;
    if (l > MAX_CODE_BITS) throw new Error(`Huffman：码长 ${l} 超过上限 ${MAX_CODE_BITS}`);
    count[l]!++;
    if (l > maxLen) maxLen = l;
  }
  // 2) Kraft 校验
  let left = 1;
  for (let l = 1; l <= MAX_CODE_BITS; l++) {
    left = (left << 1) - count[l]!;
    if (left < 0) throw new Error('Huffman：码字超订（over-subscribed）');
  }
  if (left > 0 && maxLen > 0 && !(opts.allowIncompleteSingle === true && maxLen === 1)) {
    throw new Error('Huffman：码字不完整（incomplete）');
  }
  // 3) 规范码分配（RFC 1951 §3.2.2）
  const nextCode = new Uint16Array(MAX_CODE_BITS + 1);
  let code = 0;
  for (let l = 1; l <= MAX_CODE_BITS; l++) {
    code = (code + count[l - 1]!) << 1;
    nextCode[l] = code;
  }
  // 4) 填表：码字按 MSB-first 进流 → 在 LSB-first 下标空间里位反转；
  //    高位是前瞻位（对匹配无关），全部展开填入。
  const size = 1 << maxLen; // maxLen === 0 → 1 项，全部非法
  const table = new Int32Array(size);
  for (let sym = 0; sym < lengths.length; sym++) {
    const l = lengths[sym]!;
    if (l === 0) continue;
    const c = nextCode[l]!++;
    const idx = reverseBits(c, l);
    const entry = l | (sym << 4);
    for (let i = idx; i < size; i += 1 << l) table[i] = entry;
  }
  return { table, maxLen };
}

/**
 * 由码长分配规范码字（编码端）。返回 codes[sym]：MSB-first 语义的整数值。
 * 与 buildDecodeTable 用同一套 RFC 分配算法，编解码天然互通。
 */
export function buildCodes(lengths: ArrayLike<number>): Uint16Array {
  const count = new Uint16Array(MAX_CODE_BITS + 1);
  for (let s = 0; s < lengths.length; s++) {
    const l = lengths[s]!;
    if (l > 0) count[l]!++;
  }
  const nextCode = new Uint16Array(MAX_CODE_BITS + 1);
  let code = 0;
  for (let l = 1; l <= MAX_CODE_BITS; l++) {
    code = (code + count[l - 1]!) << 1;
    nextCode[l] = code;
  }
  const codes = new Uint16Array(lengths.length);
  for (let s = 0; s < lengths.length; s++) {
    const l = lengths[s]!;
    if (l > 0) codes[s] = nextCode[l]!++;
  }
  return codes;
}

/**
 * 由符号频率构建长度受限（≤ maxLen）的 Huffman 码长。
 *
 * 策略：最小堆建普通 Huffman 树，叶子深度即码长；若最大深度超限，
 * 把全部活跃频率减半（向上取整）后重建。频率越均匀树越平衡，收敛到
 * 全 1 时深度 ≤ ceil(log2(288)) = 9 < 15，循环必然终止。相比
 * package-merge 有轻微质量损失，换来极简的核心逻辑与可证明的收敛性。
 */
export function buildCodeLengths(freq: ArrayLike<number>, maxLen: number): Uint8Array {
  const n = freq.length;
  const lens = new Uint8Array(n);
  const syms: number[] = [];
  for (let s = 0; s < n; s++) if (freq[s]! > 0) syms.push(s);
  const k = syms.length;
  if (k === 0) return lens;
  if (k === 1) {
    lens[syms[0]!] = 1; // 单符号：规定 1 位（RFC 对单距离码的要求）
    return lens;
  }

  const work = new Float64Array(n);
  for (const s of syms) work[s] = freq[s]!;

  // 节点池：0..k-1 为叶子（syms[i] 的别名），k.. 为内部节点
  const nCap = 2 * k;
  const nfreq = new Float64Array(nCap);
  const lchild = new Int32Array(nCap);
  const rchild = new Int32Array(nCap);
  const heap = new Int32Array(k);

  for (;;) {
    for (let i = 0; i < k; i++) {
      nfreq[i] = work[syms[i]!]!;
      lchild[i] = -1;
      rchild[i] = -1;
    }
    let hn = 0;
    let nodeCount = k;
    const less = (a: number, b: number): boolean =>
      nfreq[a]! < nfreq[b]! || (nfreq[a] === nfreq[b] && a < b);
    const push = (x: number): void => {
      heap[hn] = x;
      let i = hn++;
      while (i > 0) {
        const p = (i - 1) >> 1;
        if (!less(heap[i]!, heap[p]!)) break;
        const tmp = heap[i]!; heap[i] = heap[p]!; heap[p] = tmp;
        i = p;
      }
    };
    const pop = (): number => {
      const top = heap[0]!;
      heap[0] = heap[--hn]!;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        const r = l + 1;
        let m = i;
        if (l < hn && less(heap[l]!, heap[m]!)) m = l;
        if (r < hn && less(heap[r]!, heap[m]!)) m = r;
        if (m === i) break;
        const tmp = heap[i]!; heap[i] = heap[m]!; heap[m] = tmp;
        i = m;
      }
      return top;
    };
    for (let i = 0; i < k; i++) push(i);
    while (hn > 1) {
      const a = pop();
      const b = pop();
      nfreq[nodeCount] = nfreq[a]! + nfreq[b]!;
      lchild[nodeCount] = a;
      rchild[nodeCount] = b;
      push(nodeCount++);
    }
    const root = pop();

    // 叶子深度 = 码长（显式栈遍历，避免递归）
    lens.fill(0);
    let maxDepth = 0;
    const stack: number[] = [root];
    const depthStack: number[] = [0];
    while (stack.length > 0) {
      const nd = stack.pop()!;
      const d = depthStack.pop()!;
      if (lchild[nd] === -1) {
        lens[syms[nd]!] = d;
        if (d > maxDepth) maxDepth = d;
      } else {
        stack.push(lchild[nd]!, rchild[nd]!);
        depthStack.push(d + 1, d + 1);
      }
    }
    if (maxDepth <= maxLen) return lens;
    // 频率减半（向上取整），重建
    for (const s of syms) work[s] = Math.ceil(work[s]! / 2);
  }
}
