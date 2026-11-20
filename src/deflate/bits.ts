// ============================================================
// 移植出处：C:\works\deflate\src\bits.ts（deflate 项目，DEFLATE/gzip 编解码器，
// 零 npm 运行时依赖）。原样移植（仅加本出处注释；ZIP 语境：BitReader/BitWriter
// 是 deflate/inflate 的底座，服务 ZIP 方法 8 的压缩/解压）。
// 单元测试随迁：tests/deflate-port.test.ts。
// ============================================================
/**
 * 位级 I/O —— DEFLATE 一切字段的公共底座。
 *
 * RFC 1951 §3.1.1 的端序陷阱：
 *  - 字节内的位按 LSB-first 进入流（bit0 最先被读到）；
 *  - 普通字段（块头、扩展位、LEN/NLEN、gzip 头字段）整体按 LSB-first 打包；
 *  - Huffman 码字却按 MSB-first 打包（码字最高位先进入流）。
 *
 * 应对方案（读向统一）：位累加器始终按 LSB-first 消费流。
 *  - 普通字段直接 readBits(n) 得到数值；
 *  - Huffman 码在解码端用“反转填表”消化：表下标 = 后续 N 个流位按
 *    LSB-first 累积出的整数，而码字 MSB-first 意味着它在下标里恰好
 *    位反转——建表时预先反转，热循环零反转成本（见 huffman.ts）；
 *  - 编码端 writeCode(code, len) 等价于 writeBits(reverseBits(code, len), len)。
 */

/** 反转 code 的低 len 位。 */
export function reverseBits(code: number, len: number): number {
  let r = 0;
  for (let i = 0; i < len; i++) {
    r = (r << 1) | (code & 1);
    code >>>= 1;
  }
  return r;
}

/**
 * 位读取器。32 位累加器按需装载字节；不变式：acc 的低 cnt 位是有效位、
 * 更高位恒为 0。“虚拟 0 填充”只发生在 peekBits 的返回值上，不污染累加器，
 * 因此真实位数是否充足始终可由 consumeBits / readBits 按 cnt 裁决。
 *
 * 字段对本模块开放（非 private）：inflate 的热循环会把
 * data/pos/acc/cnt/end 提升为局部变量以消除方法调用开销——这是
 * 刻意的性能优化，除 src/inflate.ts 的 inflateBlock 外不要直接触碰。
 */
export class BitReader {
  data: Uint8Array;
  pos: number; // 下一个待装载字节的下标
  acc = 0;     // 位累加器：bit0 是下一个待消费的流位
  cnt = 0;     // acc 中尚未消费的有效位数
  end: number;

  constructor(data: Uint8Array, startByte = 0) {
    this.data = data;
    this.pos = startByte;
    this.end = data.length;
  }

  /** 已消费的位数。 */
  get bitPos(): number {
    return this.pos * 8 - this.cnt;
  }

  /** 尽量装载：退出时要么 cnt > 24，要么字节已耗尽。 */
  private refill(): void {
    const d = this.data;
    while (this.cnt <= 24 && this.pos < this.end) {
      this.acc = (this.acc | (d[this.pos++]! << this.cnt)) >>> 0;
      this.cnt += 8;
    }
  }

  /** 读 n 位普通字段（LSB-first，n ≤ 24）。真实位数不足时抛错。 */
  readBits(n: number): number {
    this.refill();
    if (this.cnt < n) {
      throw new Error(`DEFLATE：位流意外结束（还差 ${n - this.cnt} 位）`);
    }
    const v = this.acc & ((1 << n) - 1);
    this.acc = this.acc >>> n;
    this.cnt -= n;
    return v;
  }

  /**
   * 窥探 n 位（n ≤ 15），不足的位按 0 虚拟填充——专用于表驱动 Huffman
   * 解码。下标里混入的虚拟 0 只影响“查到哪一项”；查到的码字是否真的
   * 存在于流中，由 consumeBits 按 cnt 裁决。
   */
  peekBits(n: number): number {
    this.refill();
    return this.acc & ((1 << n) - 1);
  }

  /** 消费一个码字的 n 位（配合 peekBits）。真实位数不足时抛错。 */
  consumeBits(n: number): void {
    if (this.cnt < n) {
      throw new Error('DEFLATE：位流意外结束（Huffman 码不完整）');
    }
    this.acc = this.acc >>> n;
    this.cnt -= n;
  }

  /** 丢弃到字节边界（stored 块进入前 / 块尾对齐）。 */
  alignByte(): void {
    const drop = this.cnt & 7;
    this.acc = this.acc >>> drop;
    this.cnt -= drop;
  }

  /** 当前字节对齐位置（调用前应 alignByte）。 */
  get bytePos(): number {
    return this.pos - (this.cnt >> 3);
  }

  /** 跳到绝对字节位置（stored 块数据段越过 / gzip 定位 trailer）。 */
  seekByte(bytePos: number): void {
    this.pos = bytePos;
    this.acc = 0;
    this.cnt = 0;
  }
}

/**
 * 位写入器——读取器的镜像。writeBits 按 LSB-first 打包普通字段；
 * Huffman 码字用 writeCode（先位反转再写），使码字 MSB-first 进流。
 * finish() 把最后不足 8 位的悬空位以 0 补齐成整字节。
 */
export class BitWriter {
  private buf: Uint8Array;
  private len = 0; // 已提交字节数
  private acc = 0; // 待打包位（低位在前）
  private cnt = 0; // acc 有效位数（跨调用时恒 < 8）

  constructor(initialCap = 1 << 16) {
    this.buf = new Uint8Array(Math.max(64, initialCap));
  }

  private ensure(extraBytes: number): void {
    const need = this.len + extraBytes;
    if (need <= this.buf.length) return;
    let cap = this.buf.length;
    while (cap < need) cap *= 2;
    const nb = new Uint8Array(cap);
    nb.set(this.buf.subarray(0, this.len));
    this.buf = nb;
  }

  /** 写 n 位（n ≤ 24，LSB-first；调用方保证 v 只含 n 个有效位，这里再兜底掩码）。 */
  writeBits(v: number, n: number): void {
    this.ensure(4); // 7 悬空位 + 24 新位最多溢出 4 字节
    this.acc = (this.acc | ((v & ((1 << n) - 1)) << this.cnt)) >>> 0;
    this.cnt += n;
    const b = this.buf;
    let l = this.len;
    while (this.cnt >= 8) {
      b[l++] = this.acc & 0xff;
      this.acc = this.acc >>> 8;
      this.cnt -= 8;
    }
    this.len = l;
  }

  /** 写 Huffman 码字：writeBits(reverseBits(code, len), len) 的语义糖。 */
  writeCode(code: number, len: number): void {
    this.writeBits(reverseBits(code, len), len);
  }

  /**
   * 对齐字节边界：把悬空位以 0 补齐成整字节并提交（写入端的“对齐”是
   * 补零落盘，读取端的 alignByte 才是丢弃——stored 块头部的 3 个位是
   * 真实流内容，绝不能丢）。
   */
  alignByte(): void {
    if (this.cnt > 0) {
      this.ensure(1);
      this.buf[this.len++] = this.acc & 0xff;
      this.acc = 0;
      this.cnt = 0;
    }
  }

  /** 前提：已对齐（cnt === 0，即刚调用过 alignByte）。整字节拷入（stored 块数据段）。 */
  writeBytes(src: Uint8Array, start: number, count: number): void {
    this.ensure(count);
    this.buf.set(src.subarray(start, start + count), this.len);
    this.len += count;
  }

  /** 收尾：把悬空位补齐成整字节后返回输出（视图，允许与内部缓冲共享）。 */
  finish(): Uint8Array {
    this.alignByte();
    return this.buf.subarray(0, this.len);
  }
}
