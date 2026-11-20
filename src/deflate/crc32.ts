// ============================================================
// 移植出处：C:\works\deflate\src\crc32.ts（deflate 项目，DEFLATE/gzip 编解码器，
// 零 npm 运行时依赖）。原样移植（仅加本出处注释；ZIP 语境：crc32 用于
// 条目 CRC-32 校验与写入——PKWARE APPNOTE 的 crc32 字段与 RFC 1952 同一算法）。
// 单元测试随迁：tests/deflate-port.test.ts。
// ============================================================
/**
 * CRC-32（RFC 1952 §8 / ISO 3309），反射多项式 0xEDB88320。
 * 切片法（slicing-by-4）：在 256 项基础表之上再派生 3 张表，
 * 每步消化 4 字节，吞吐约为逐字节查表法的 2 倍（实测 300 → 600MB/s）。
 * 已知校验值：crc32("") = 0，crc32("123456789") = 0xCBF43926，
 * crc32("The quick brown fox jumps over the lazy dog") = 0x414FA339。
 */
const T0 = /* @__PURE__ */ (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    t[n] = c >>> 0;
  }
  return t;
})();
const T1 = /* @__PURE__ */ (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    const c = T0[i]!;
    t[i] = ((c >>> 8) ^ T0[c & 0xff]!) >>> 0;
  }
  return t;
})();
const T2 = /* @__PURE__ */ (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    const c = T1[i]!;
    t[i] = ((c >>> 8) ^ T0[c & 0xff]!) >>> 0;
  }
  return t;
})();
const T3 = /* @__PURE__ */ (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    const c = T2[i]!;
    t[i] = ((c >>> 8) ^ T0[c & 0xff]!) >>> 0;
  }
  return t;
})();

/** 计算 data 的 CRC-32（返回无符号 32 位整数）。 */
export function crc32(data: Uint8Array): number {
  let c = -1; // 0xffffffff 的 int32 形式；位运算域内语义与无符号一致
  const len = data.length;
  const n4 = len & ~3;
  let i = 0;
  for (; i < n4; i += 4) {
    c ^= data[i]! | (data[i + 1]! << 8) | (data[i + 2]! << 16) | (data[i + 3]! << 24);
    c = (T3[c & 0xff]! ^ T2[(c >>> 8) & 0xff]! ^ T1[(c >>> 16) & 0xff]! ^ T0[(c >>> 24) & 0xff]!) | 0;
  }
  for (; i < len; i++) {
    c = (T0[(c ^ data[i]!) & 0xff]! ^ (c >>> 8)) | 0;
  }
  return (c ^ -1) >>> 0;
}
