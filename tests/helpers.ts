/**
 * 测试辅助：字节级 ZIP 构造器。
 * 单元/ZIP64/描述符/坏档测试用它获得比 writeZip 更细的字段级控制
 * （哨兵占位、描述符两种模式、CRC 覆盖、注释等）。
 */
import { deflateRaw, crc32 } from '../src/deflate';
import {
  SIG_LFH, SIG_CDH, SIG_EOCD, SIG_EOCD64, SIG_LOC64, SIG_DESC,
  FLAG_DATA_DESC, FLAG_UTF8, U32_MAX, U16_MAX, EID_ZIP64,
} from '../src/struct';

const TE = new TextEncoder();

function w16(b: Uint8Array, p: number, v: number): void {
  b[p] = v & 0xff; b[p + 1] = (v >>> 8) & 0xff;
}
function w32(b: Uint8Array, p: number, v: number): void {
  b[p] = v & 0xff; b[p + 1] = (v >>> 8) & 0xff;
  b[p + 2] = (v >>> 16) & 0xff; b[p + 3] = (v >>> 24) & 0xff;
}
function w64(b: Uint8Array, p: number, v: number): void {
  w32(b, p, v >>> 0); w32(b, p + 4, Math.floor(v / 0x100000000));
}

/** ZIP64 扩展字段体：按 canonical 顺序（usize/csize/offset），只含给出的项。 */
function zip64ExtraBody(f: { usize?: number; csize?: number; offset?: number; includeOffset?: boolean }): Uint8Array {
  const wantOffset = f.includeOffset === true || f.offset !== undefined;
  const b = new Uint8Array(8 + 8 + (wantOffset ? 8 : 0));
  let q = 0;
  w64(b, q, f.usize ?? 0); q += 8;
  w64(b, q, f.csize ?? 0); q += 8;
  if (wantOffset) w64(b, q, f.offset ?? 0);
  return b;
}

/** 把 ZIP64 extra（id 0x0001）打包成 extra 字段字节。 */
function zip64Extra(f: Parameters<typeof zip64ExtraBody>[0]): Uint8Array {
  const body = zip64ExtraBody(f);
  const out = new Uint8Array(4 + body.length);
  w16(out, 0, EID_ZIP64);
  w16(out, 2, body.length);
  out.set(body, 4);
  return out;
}

export interface ManualEntry {
  /** 条目名（rawName 未给时必填）。 */
  name?: string;
  /** 条目数据（未压缩原文；method=8 时内部 deflate）。 */
  data?: Uint8Array;
  /** 直接给压缩后字节（method 仍需为 8）。 */
  payload?: Uint8Array;
  method?: 0 | 8;
  /** 强制置/清 EFS 位；缺省按名字自动。 */
  efs?: boolean;
  /** 直接给名字字节（CP437 测试；绕过 name）。 */
  rawName?: Uint8Array;
  /** 数据描述符模式。 */
  descriptor?: 'none' | 'sig' | 'nosig';
  /** 本地头 ZIP64：给出即置哨兵占位 + 8 字节扩展字段。 */
  lfhZip64?: { usize?: number; csize?: number; offset?: number; includeOffset?: boolean };
  /** 中央目录 ZIP64：同上。 */
  cdZip64?: { usize?: number; csize?: number; offset?: number; includeOffset?: boolean };
  /** 覆盖 CD 与 LFH 的 CRC 字段（坏档用）。 */
  crcOverride?: number;
  /** 只覆盖 CD 的 CRC。 */
  crcOverrideCdOnly?: number;
  /** 覆盖 CD 尺寸字段（32 位直写，制造不一致坏档）。 */
  cdSizeOverride?: { csize?: number; usize?: number };
  /** 覆盖 LFH 名字字节（制造名字不一致坏档）。 */
  lfhNameOverride?: Uint8Array;
  /** 外部属性。 */
  externalAttrs?: number;
  /** 本地头标志位直改（加密位等）。 */
  flagsOverride?: number;
  /** 压缩方法直改（制造非法方法坏档）。 */
  methodOverride?: number;
}

export interface ManualOptions {
  /** 档案注释（写入 EOCD 注释长度字段）。 */
  comment?: string;
  /** ZIP64 EOCD64 + 定位器 + EOCD 哨兵。 */
  eocdZip64?: boolean;
  /** 覆盖 EOCD 条目数字段。 */
  totalOverride?: number;
  /** 覆盖 EOCD 的 CD 偏移字段。 */
  cdOffsetOverride?: number;
  /** 覆盖 EOCD 的 CD 尺寸字段。 */
  cdSizeOverride?: number;
  /** 完全省略 EOCD（坏档）。 */
  omitEOCD?: boolean;
  /** DOS 时间/日期覆盖。 */
  dosTime?: number;
  dosDate?: number;
  /** EOCD 之后追加的垃圾字节（注释内伪签名测试用）。 */
  trailing?: Uint8Array;
  /** 压缩级别。 */
  level?: number;
}

/** 手工构造 ZIP。默认字段值按最普通的无描述符非 ZIP64 档案。 */
export function buildZipManual(entries: ManualEntry[], o: ManualOptions = {}): Uint8Array {
  const chunks: Uint8Array[] = [];
  let total = 0;
  const push = (b: Uint8Array): void => { chunks.push(b); total += b.length; };

  interface Built {
    nameBytes: Uint8Array; lfhNameBytes: Uint8Array; flags: number; method: number;
    crc: number; usize: number; csize: number; payload: Uint8Array;
    desc: Uint8Array | null; lfhExtra: Uint8Array; cdExtra: Uint8Array;
    lfhOffset: number; externalAttrs: number;
  }
  const built: Built[] = [];

  for (const e of entries) {
    if (e.name === undefined && e.rawName === undefined) {
      throw new Error('ManualEntry 需要 name 或 rawName 之一');
    }
    const nameBytes = e.rawName ?? TE.encode(e.name!);
    const lfhNameBytes = e.lfhNameOverride ?? nameBytes;
    const data = e.data ?? new Uint8Array(0);
    const method = e.method ?? 0;
    const payload = e.payload ?? (method === 8 ? deflateRaw(data, o.level ?? 6) : data);
    const usize = e.cdSizeOverride?.usize ?? (e.cdZip64?.usize ?? data.length);
    const crc = e.crcOverride ?? crc32(data);
    const csize = e.cdSizeOverride?.csize !== undefined ? e.cdSizeOverride.csize : payload.length;
    const eUsize = e.cdSizeOverride?.usize ?? usize;
    const hasDesc = (e.descriptor ?? 'none') !== 'none';

    let flags = e.flagsOverride;
    if (flags === undefined) {
      flags = 0;
      const wantsUtf8 = e.efs ?? nameBytes.some((b) => b >= 0x80);
      if (wantsUtf8) flags |= FLAG_UTF8;
      if (hasDesc) flags |= FLAG_DATA_DESC;
    }
    const methodFinal = e.methodOverride ?? method;

    // 描述符
    let desc: Uint8Array | null = null;
    if (hasDesc) {
      const d64 = e.lfhZip64 !== undefined || e.cdZip64 !== undefined;
      const len = e.descriptor === 'sig' ? (d64 ? 20 : 16) : (d64 ? 20 : 12);
      desc = new Uint8Array(len);
      let q = 0;
      if (e.descriptor === 'sig') { w32(desc, q, SIG_DESC); q += 4; }
      w32(desc, q, crc32(data)); q += 4;
      if (d64) { w64(desc, q, payload.length); q += 8; w64(desc, q, usize); }
      else { w32(desc, q, payload.length); q += 4; w32(desc, q, usize); }
    }

    // LFH extra / CD extra
    const lfhExtra = e.lfhZip64 ? zip64Extra(e.lfhZip64) : new Uint8Array(0);
    const cdExtra = e.cdZip64 ? zip64Extra(e.cdZip64) : new Uint8Array(0);

    built.push({
      nameBytes, lfhNameBytes, flags: flags!, method: methodFinal, crc,
      usize: eUsize, csize, payload, desc, lfhExtra, cdExtra,
      lfhOffset: 0, externalAttrs: e.externalAttrs ?? (0o644 << 16),
    });
  }

  // —— LFH ——
  for (let i = 0; i < built.length; i++) {
    const b = built[i]!;
    const lz = entries[i]!.lfhZip64;
    b.lfhOffset = total;
    const lfh = new Uint8Array(30 + b.lfhNameBytes.length + b.lfhExtra.length);
    w32(lfh, 0, SIG_LFH);
    w16(lfh, 4, b.lfhExtra.length > 0 ? 45 : 20);
    w16(lfh, 6, b.flags);
    w16(lfh, 8, b.method);
    w16(lfh, 10, o.dosTime ?? 0);
    w16(lfh, 12, o.dosDate ?? ((44 << 9) | (1 << 5) | 1));
    if ((b.flags & FLAG_DATA_DESC) !== 0) {
      w32(lfh, 14, 0); w32(lfh, 18, 0); w32(lfh, 22, 0);
    } else {
      w32(lfh, 14, b.crc);
      // LFH ZIP64 占位：给出了 lfhZip64 尺寸项 → 字段置哨兵，真值走 extra
      w32(lfh, 18, lz && lz.csize !== undefined ? U32_MAX : b.csize);
      w32(lfh, 22, lz && lz.usize !== undefined ? U32_MAX : b.usize);
    }
    w16(lfh, 26, b.lfhNameBytes.length);
    w16(lfh, 28, b.lfhExtra.length);
    lfh.set(b.lfhNameBytes, 30);
    lfh.set(b.lfhExtra, 30 + b.lfhNameBytes.length);
    push(lfh);
    push(b.payload);
    if (b.desc) push(b.desc);
  }

  // —— CD ——
  const cdStart = total;
  for (let i = 0; i < built.length; i++) {
    const b = built[i]!;
    const e = entries[i]!;
    const cdh = new Uint8Array(46 + b.nameBytes.length + b.cdExtra.length);
    w32(cdh, 0, SIG_CDH);
    w16(cdh, 4, (3 << 8) | 20);
    w16(cdh, 6, b.cdExtra.length > 0 ? 45 : 20);
    w16(cdh, 8, b.flags);
    w16(cdh, 10, b.method);
    w16(cdh, 12, o.dosTime ?? 0);
    w16(cdh, 14, o.dosDate ?? ((44 << 9) | (1 << 5) | 1));
    w32(cdh, 16, e.crcOverrideCdOnly ?? b.crc);
    const cz = e.cdZip64;
    w32(cdh, 20, cz && cz.csize !== undefined ? U32_MAX : b.csize);
    w32(cdh, 24, cz && cz.usize !== undefined ? U32_MAX : b.usize);
    w16(cdh, 28, b.nameBytes.length);
    w16(cdh, 30, b.cdExtra.length);
    w16(cdh, 32, 0);
    w16(cdh, 34, 0);
    w16(cdh, 36, 0);
    w32(cdh, 38, b.externalAttrs);
    w32(cdh, 42, cz && cz.offset !== undefined ? U32_MAX : b.lfhOffset);
    cdh.set(b.nameBytes, 46);
    cdh.set(b.cdExtra, 46 + b.nameBytes.length);
    push(cdh);
  }
  const cdSize = total - cdStart;

  // —— EOCD / ZIP64 EOCD ——
  if (!o.omitEOCD) {
    if (o.eocdZip64) {
      const e64Pos = total;
      const e64 = new Uint8Array(56);
      w32(e64, 0, SIG_EOCD64);
      w64(e64, 4, 44);
      w16(e64, 12, (3 << 8) | 45);
      w16(e64, 14, 45);
      w32(e64, 16, 0);
      w32(e64, 20, 0);
      w64(e64, 24, built.length);
      w64(e64, 32, built.length);
      w64(e64, 40, cdSize);
      w64(e64, 48, cdStart);
      push(e64);
      const loc = new Uint8Array(20);
      w32(loc, 0, SIG_LOC64);
      w32(loc, 4, 0);
      w64(loc, 8, e64Pos);
      w32(loc, 16, 1);
      push(loc);
    }
    const eocd = new Uint8Array(22);
    w32(eocd, 0, SIG_EOCD);
    w16(eocd, 4, 0);
    w16(eocd, 6, 0);
    if (o.eocdZip64) {
      w16(eocd, 8, U16_MAX); w16(eocd, 10, U16_MAX);
      w32(eocd, 12, U32_MAX); w32(eocd, 16, U32_MAX);
    } else {
      w16(eocd, 8, o.totalOverride ?? built.length);
      w16(eocd, 10, o.totalOverride ?? built.length);
      w32(eocd, 12, o.cdSizeOverride ?? cdSize);
      w32(eocd, 16, o.cdOffsetOverride ?? cdStart);
    }
    w16(eocd, 20, 0);
    push(eocd);
    if (o.comment !== undefined || o.trailing !== undefined) {
      // 注释（含长度字段）：注释内容 + trailing 会先写入注释长度
      const commentBytes = o.comment !== undefined ? TE.encode(o.comment) : new Uint8Array(0);
      // 重新组装：把最后 push 的 EOCD 的注释长度字段改写为实际注释长度
      const eocdChunk = chunks[chunks.length - 1]!;
      const extraLen = commentBytes.length + (o.trailing?.length ?? 0);
      w16(eocdChunk, 20, extraLen);
      push(commentBytes);
      if (o.trailing) push(o.trailing);
    }
  }

  const out = new Uint8Array(total);
  let p = 0;
  for (const c of chunks) { out.set(c, p); p += c.length; }
  return out;
}

/** 单字节翻转（坏档变异原语）。 */
export function flipByte(buf: Uint8Array, idx: number, x = 0xff): Uint8Array {
  const out = buf.slice();
  out[idx] = (out[idx]! ^ x) & 0xff;
  return out;
}

/** 按小端写一个 uint32 到副本指定位置。 */
export function poke32(buf: Uint8Array, idx: number, v: number): Uint8Array {
  const out = buf.slice();
  w32(out, idx, v);
  return out;
}
