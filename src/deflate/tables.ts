// ============================================================
// 移植出处：C:\works\deflate\src\tables.ts（deflate 项目）。原样移植
// （仅加本出处注释）；单元测试随迁：tests/deflate-port.test.ts。
// ============================================================
/**
 * RFC 1951 固定码表与扩展位表（inflate/deflate 共用）。
 * 全部为模块级常量，一次构建，只读。
 */

/** 长度码 257..285 的基础长度（RFC 1951 §3.2.5）。 */
export const LENGTH_BASE = new Uint16Array([
  3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59,
  67, 83, 99, 115, 131, 163, 195, 227, 258,
]);

/** 长度码的扩展位数。 */
export const LENGTH_EXTRA = new Uint8Array([
  0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3,
  4, 4, 4, 4, 5, 5, 5, 5, 0,
]);

/** 距离码 0..29 的基础距离。 */
export const DIST_BASE = new Uint16Array([
  1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193,
  257, 385, 513, 769, 1025, 1537, 2049, 3073, 4097, 6145, 8193, 12289, 16385, 24577,
]);

/** 距离码的扩展位数。 */
export const DIST_EXTRA = new Uint8Array([
  0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8,
  9, 9, 10, 10, 11, 11, 12, 12, 13, 13,
]);

/** 距离 d ∈ [1, 32768] → 距离码符号（0..29）。O(1) 查表，32769 项。 */
export const DIST_SYM = /* @__PURE__ */ (() => {
  const t = new Uint8Array(32769);
  for (let s = 0; s < 30; s++) {
    const lo = DIST_BASE[s]!;
    const hi = s < 29 ? DIST_BASE[s + 1]! - 1 : 32768;
    for (let d = lo; d <= hi; d++) t[d] = s;
  }
  return t;
})();

/** 匹配长度 len ∈ [3, 258] → 长度码符号（257..285）。
 *  注意必须是 Uint16Array：符号值 257..285 超出 Uint8 范围，
 *  用 Uint8Array 会被静默截断成 sym-256（实测踩过的坑）。 */
export const LEN_SYM = /* @__PURE__ */ (() => {
  const t = new Uint16Array(259);
  for (let s = 0; s < 29; s++) {
    const lo = LENGTH_BASE[s]!;
    const hi = s < 28 ? LENGTH_BASE[s + 1]! - 1 : 258;
    for (let l = lo; l <= hi; l++) t[l] = 257 + s;
  }
  return t;
})();

/** code length 字母表的传输顺序（RFC 1951 §3.2.7）。 */
export const CODELEN_ORDER = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15] as const;

/** 固定 Huffman：字面量/长度码长表（RFC 1951 §3.2.6），288 项。 */
export const FIXED_LIT_LENGTHS = /* @__PURE__ */ (() => {
  const a = new Uint8Array(288);
  for (let i = 0; i < 144; i++) a[i] = 8;
  for (let i = 144; i < 256; i++) a[i] = 9;
  for (let i = 256; i < 280; i++) a[i] = 7;
  for (let i = 280; i < 288; i++) a[i] = 8;
  return a;
})();

/** 固定 Huffman：距离码长表，32 项（0..29 有效；30/31 码字存在但符号非法）。 */
export const FIXED_DIST_LENGTHS = new Uint8Array(32).fill(5);
