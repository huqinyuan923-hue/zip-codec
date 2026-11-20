/**
 * ZIP 写入器（M4）。
 *
 * 结构决策（详见 REPORT.md）：
 *  - 名字编码：ASCII 原样；含非 ASCII 一律 UTF-8 字节 + EFS 位（bit11）。
 *    不产出 CP437 编码名（语义含糊区，UTF-8 覆盖任务书停止规则）。
 *  - 默认方法 deflate（8），目录条目（名字尾 '/'）强制 stored 且数据为空。
 *  - 数据描述符：opts.descriptor=true 时置 bit3、本地头 CRC/尺寸写 0、
 *    数据后追加【带签名】PK\x07\x08 描述符。无签名模式属于读取侧兼容范围
 *    （见 reader.ts 与合成测试），写侧统一产出带签名模式。
 *  - ZIP64：opts.zip64=true 强制全链路（EOCD64 + 定位器 + 每条目两处
 *    8 字节扩展字段），在不需要真写 4GB 的前提下覆盖完整 ZIP64 写出链；
 *    尺寸/偏移/条目数越界时自动启用（此时扩展字段只出现在哨兵占位的头里）。
 *  - 时间戳：固定 DOS 值（2024-01-01 00:00:00），产出确定性字节流。
 */
import { deflateRaw, crc32 } from './deflate';
import {
  SIG_LFH, SIG_CDH, SIG_EOCD, SIG_EOCD64, SIG_LOC64, SIG_DESC,
  METHOD_STORED, METHOD_DEFLATE,
  FLAG_DATA_DESC, FLAG_UTF8,
  U32_MAX, U16_MAX, EID_ZIP64,
  EOCD_MIN_LEN, LOC64_LEN, CDH_FIXED_LEN, LFH_FIXED_LEN, EOCD64_FIXED_LEN,
  ZipError,
} from './struct';

/** 单个待写入条目（任务书公开 API 的输入形状）。 */
export interface ZipInput {
  name: string;
  data: Uint8Array;
  /** 0 stored / 8 deflate；缺省 8（目录条目强制 0）。 */
  method?: 0 | 8;
}

/** writeZip 可选参数（任务书签名的可加性扩展）。 */
export interface WriteOptions {
  /** bit3 数据描述符模式（带签名 PK\x07\x08）。 */
  descriptor?: boolean;
  /** 强制 ZIP64 全链路写出。 */
  zip64?: boolean;
  /** deflate 级别 1..9，默认 6。 */
  level?: number;
}

/** 固定 DOS 时间戳：2024-01-01 00:00:00 → time=0，date=(44<<9)|(1<<5)|1。 */
const DOS_TIME = 0;
const DOS_DATE = (44 << 9) | (1 << 5) | 1;

/** 版本号：stored/deflate 需要 2.0；ZIP64 需要 4.5。宿主 = Unix(3)。 */
const VER_STORED_DEFLATE = 20;
const VER_ZIP64 = 45;
const HOST_UNIX = 3;

const UTF8_ENCODER = new TextEncoder();

/** 内部条目准备结果。 */
interface Prepared {
  nameBytes: Uint8Array;
  isDir: boolean;
  method: 0 | 8;
  flags: number;
  crc: number;
  usize: number;
  csize: number;
  payload: Uint8Array;          // 压缩（或原样）数据
  descriptor: Uint8Array | null; // bit3 模式下追加在数据后的描述符
  /** 本条目必须走 ZIP64 扩展字段（尺寸越界），与“强制模式全体走”相区别。 */
  needZip64: boolean;
  lfhOffset: number;
}

// —— 小端写入原语 ——

function w16(b: Uint8Array, p: number, v: number): void {
  b[p] = v & 0xff;
  b[p + 1] = (v >>> 8) & 0xff;
}
function w32(b: Uint8Array, p: number, v: number): void {
  b[p] = v & 0xff;
  b[p + 1] = (v >>> 8) & 0xff;
  b[p + 2] = (v >>> 16) & 0xff;
  b[p + 3] = (v >>> 24) & 0xff;
}
/** 64 位值拆两个 32 位写入（本实现的数值域 ≤ 2^53，Number 精度内）。 */
function w64(b: Uint8Array, p: number, v: number): void {
  w32(b, p, v >>> 0);
  w32(b, p + 4, Math.floor(v / 0x100000000));
}

/**
 * 阶段 1：压缩、定名、算 CRC，收集每条目的字节级事实。
 */
function prepare(files: ZipInput[], opts: WriteOptions): { recs: Prepared[]; zip64: boolean; forceAll: boolean } {
  const recs: Prepared[] = [];
  const forceAll = opts.zip64 === true;
  let zip64 = forceAll;

  for (const f of files) {
    const nameBytes = UTF8_ENCODER.encode(f.name);
    if (nameBytes.length > U16_MAX) {
      throw new ZipError('BAD_NAME', `条目名 UTF-8 字节数 ${nameBytes.length} 超过 65535 上限`);
    }
    const isDir = f.name.endsWith('/') || f.name.endsWith('\\');
    const method: 0 | 8 = isDir ? METHOD_STORED : (f.method ?? METHOD_DEFLATE);
    const data = isDir ? new Uint8Array(0) : f.data;

    let flags = 0;
    for (const b of nameBytes) if (b >= 0x80) { flags |= FLAG_UTF8; break; }

    const crc = crc32(data);
    const usize = data.length;
    const payload = method === METHOD_DEFLATE && !isDir ? deflateRaw(data, opts.level ?? 6) : data;
    const csize = payload.length;

    let descriptor: Uint8Array | null = null;
    if (opts.descriptor === true && !isDir) {
      flags |= FLAG_DATA_DESC;
      const d64 = forceAll || usize > U32_MAX || csize > U32_MAX;
      descriptor = new Uint8Array(d64 ? 20 : 16);
      w32(descriptor, 0, SIG_DESC);
      w32(descriptor, 4, crc);
      if (d64) {
        w64(descriptor, 8, csize);
        w64(descriptor, 16, usize);
      } else {
        w32(descriptor, 8, csize);
        w32(descriptor, 12, usize);
      }
    }

    const needZip64 = usize > U32_MAX || csize > U32_MAX;
    if (needZip64) zip64 = true;
    recs.push({
      nameBytes, isDir, method, flags, crc, usize, csize,
      payload, descriptor, needZip64, lfhOffset: 0,
    });
  }
  return { recs, zip64, forceAll };
}

/**
 * 阶段 2：累计本地头偏移（含 ZIP64 extra 的字节数——与 assemble 的
 * useLocal 判定严格一致，否则偏移漂移）；偏移越界或条目数超 16 位时
 * 自动升级 ZIP64。
 */
function assignOffsets(recs: Prepared[], zip64: boolean, forceAll: boolean): boolean {
  let off = 0;
  let z = zip64;
  for (const r of recs) {
    r.lfhOffset = off;
    const useLocal = z && (forceAll || r.needZip64);
    const extraLen = useLocal ? 4 + 16 + (off > U32_MAX ? 8 : 0) : 0;
    off += LFH_FIXED_LEN + r.nameBytes.length + extraLen + r.payload.length + (r.descriptor?.length ?? 0);
    if (r.lfhOffset > U32_MAX) z = true;
  }
  if (recs.length > U16_MAX) z = true;
  return z;
}

/**
 * 阶段 3：拼装字节流。
 * localExtra：ZIP64 本地头扩展。强制模式全体携带（覆盖 LFH 占位链路）；
 * 自动模式仅 needZip64 条目携带。CD 扩展：强制模式全体携带 16 字节体
 * （usize/csize 占位），偏移越界再补 8 字节；自动模式同理按需。
 */
function assemble(recs: Prepared[], zip64: boolean, forceAll: boolean): Uint8Array {
  const chunks: Uint8Array[] = [];
  let total = 0;
  const push = (b: Uint8Array): void => { chunks.push(b); total += b.length; };

  for (const r of recs) {
    // —— 本地文件头 ——
    const useLocal = zip64 && (forceAll || r.needZip64);
    const offsetTooBig = r.lfhOffset > U32_MAX;
    // extra 字段总长 = 4 字节头（id+size）+ 体；体按哨兵占位项计
    const extraLen = useLocal ? 4 + 16 + (offsetTooBig ? 8 : 0) : 0;
    const lfh = new Uint8Array(LFH_FIXED_LEN + r.nameBytes.length + extraLen);
    w32(lfh, 0, SIG_LFH);
    w16(lfh, 4, zip64 ? VER_ZIP64 : VER_STORED_DEFLATE);
    w16(lfh, 6, r.flags);
    w16(lfh, 8, r.method);
    w16(lfh, 10, DOS_TIME);
    w16(lfh, 12, DOS_DATE);
    if (r.descriptor !== null) {
      // bit3 模式：本地头 CRC/尺寸写 0（写时未知语义）
      w32(lfh, 14, 0);
      w32(lfh, 18, 0);
      w32(lfh, 22, 0);
    } else {
      w32(lfh, 14, r.crc);
      if (useLocal) {
        w32(lfh, 18, U32_MAX);
        w32(lfh, 22, U32_MAX);
      } else {
        w32(lfh, 18, r.csize);
        w32(lfh, 22, r.usize);
      }
    }
    w16(lfh, 26, r.nameBytes.length);
    w16(lfh, 28, extraLen);
    lfh.set(r.nameBytes, LFH_FIXED_LEN);
    if (useLocal) {
      const x = LFH_FIXED_LEN + r.nameBytes.length;
      w16(lfh, x, EID_ZIP64);
      w16(lfh, x + 2, extraLen - 4); // extra 自身 size 字段 = 体长（不含 4 字节头）
      w64(lfh, x + 4, r.usize);
      w64(lfh, x + 12, r.csize);
    }
    push(lfh);
    push(r.payload);
    if (r.descriptor) push(r.descriptor);
  }

  // —— 中央目录 ——
  const cdStart = total;
  for (const r of recs) {
    const offsetTooBig = r.lfhOffset > U32_MAX;
    const bodyLen = zip64 ? 16 + (offsetTooBig ? 8 : 0) : 0;
    const extraLen = zip64 ? 4 + bodyLen : 0;
    const cdh = new Uint8Array(CDH_FIXED_LEN + r.nameBytes.length + extraLen);
    w32(cdh, 0, SIG_CDH);
    w16(cdh, 4, (HOST_UNIX << 8) | (zip64 ? VER_ZIP64 : VER_STORED_DEFLATE));
    w16(cdh, 6, zip64 ? VER_ZIP64 : VER_STORED_DEFLATE);
    w16(cdh, 8, r.flags);
    w16(cdh, 10, r.method);
    w16(cdh, 12, DOS_TIME);
    w16(cdh, 14, DOS_DATE);
    w32(cdh, 16, r.crc);
    if (zip64) {
      w32(cdh, 20, U32_MAX);
      w32(cdh, 24, U32_MAX);
    } else {
      w32(cdh, 20, r.csize);
      w32(cdh, 24, r.usize);
    }
    w16(cdh, 28, r.nameBytes.length);
    w16(cdh, 30, extraLen);
    w16(cdh, 32, 0);     // 注释长度
    w16(cdh, 34, 0);     // 起始盘号
    w16(cdh, 36, 0);     // 内部属性
    // 外部属性：高 16 位 Unix 权限，低 16 位 DOS 属性（目录置 0x10）
    w32(cdh, 38, r.isDir ? (0o755 << 16) | 0x10 : (0o644 << 16));
    w32(cdh, 42, offsetTooBig ? U32_MAX : r.lfhOffset);
    cdh.set(r.nameBytes, CDH_FIXED_LEN);
    if (zip64) {
      const x = CDH_FIXED_LEN + r.nameBytes.length;
      w16(cdh, x, EID_ZIP64);
      w16(cdh, x + 2, bodyLen);
      let q = x + 4;
      w64(cdh, q, r.usize); q += 8;
      w64(cdh, q, r.csize); q += 8;
      if (offsetTooBig) w64(cdh, q, r.lfhOffset);
    }
    push(cdh);
  }
  const cdSize = total - cdStart;

  // —— ZIP64：EOCD64 + 定位器 ——
  if (zip64) {
    const eocd64Pos = total; // push(e64) 前记录，供定位器引用
    const e64 = new Uint8Array(EOCD64_FIXED_LEN);
    w32(e64, 0, SIG_EOCD64);
    w64(e64, 4, EOCD64_FIXED_LEN - 12); // 记录尺寸字段 = 记录长度 - 12
    w16(e64, 12, (HOST_UNIX << 8) | VER_ZIP64);
    w16(e64, 14, VER_ZIP64);
    w32(e64, 16, 0); // 本盘号
    w32(e64, 20, 0); // 中央目录所在盘
    w64(e64, 24, recs.length);
    w64(e64, 32, recs.length);
    w64(e64, 40, cdSize);
    w64(e64, 48, cdStart);
    push(e64);

    const loc = new Uint8Array(LOC64_LEN);
    w32(loc, 0, SIG_LOC64);
    w32(loc, 4, 0);              // EOCD64 所在盘
    w64(loc, 8, eocd64Pos);      // EOCD64 绝对偏移
    w32(loc, 16, 1);             // 总盘数
    push(loc);
  }

  // —— EOCD（ZIP64 时条目数/CD 尺寸/偏移全部哨兵占位）——
  const eocd = new Uint8Array(EOCD_MIN_LEN);
  w32(eocd, 0, SIG_EOCD);
  w16(eocd, 4, 0);
  w16(eocd, 6, 0);
  if (zip64) {
    w16(eocd, 8, U16_MAX);
    w16(eocd, 10, U16_MAX);
    w32(eocd, 12, U32_MAX);
    w32(eocd, 16, U32_MAX);
  } else {
    w16(eocd, 8, recs.length);
    w16(eocd, 10, recs.length);
    w32(eocd, 12, cdSize);
    w32(eocd, 16, cdStart);
  }
  w16(eocd, 20, 0);
  push(eocd);

  const out = new Uint8Array(total);
  let p = 0;
  for (const c of chunks) {
    out.set(c, p);
    p += c.length;
  }
  return out;
}

/**
 * 公开入口：从条目列表产出 ZIP 字节流（stored/deflate、bit3 描述符、
 * UTF-8 名、ZIP64 全链路）。
 */
export function writeZip(files: ZipInput[], opts?: WriteOptions): Uint8Array {
  const o = opts ?? {};
  if (o.level !== undefined && (!Number.isInteger(o.level) || o.level < 1 || o.level > 9)) {
    throw new ZipError('BAD_METHOD', `level 必须是 1..9 的整数，收到 ${String(o.level)}`);
  }
  const { recs, zip64: z0, forceAll } = prepare(files, o);
  const zip64 = assignOffsets(recs, z0, forceAll);
  return assemble(recs, zip64, forceAll);
}
