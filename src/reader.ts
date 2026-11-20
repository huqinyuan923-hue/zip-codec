/**
 * ZIP 解析与读取（PKWARE APPNOTE 本地文件头 + 中央目录模型）。
 *
 * 读取管线：
 *   1. EOCD 定位——从文件尾向前扫描，签名与“注释长度字段恰好填满文件尾”
 *      双重校验，杜绝把注释内容里的伪签名当成 EOCD（64K 注释边界全覆盖）；
 *   2. ZIP64 链路——EOCD 出现 0xFFFF/0xFFFFFFFF 哨兵，或 EOCD 前恰有
 *      定位器签名时，走 定位器 → EOCD64 → 64 位条目数/CD 尺寸/CD 偏移；
 *   3. 中央目录逐条解析（名字 CP437/UTF-8、ZIP64 扩展字段按哨兵占位顺序消费）；
 *   4. 本地文件头对齐校验——签名、名字字节、方法、标志、时间戳、
 *      CRC/尺寸（bit3 时允许 0 = 写时未知）逐字段对齐；
 *   5. 惰性读取——read(name) 才解压，CRC 与长度双重验证，bit3 时
 *      继续解析数据描述符（带签名 12/20 字节与无签名两种模式）。
 *
 * 安全边界：一切区间先验证后访问；解压输出长度受登记值约束；
 * 加密（bit0/bit6）与未知压缩方法在解析期即拒绝（任务书：只解析标志并抛“不支持”）。
 */
import { inflate } from './deflate';
import { crc32 } from './deflate';
import { cp437Decode } from './cp437';
import {
  SIG_LFH, SIG_CDH, SIG_EOCD, SIG_EOCD64, SIG_LOC64, SIG_DESC,
  METHOD_STORED, METHOD_DEFLATE,
  FLAG_ENCRYPTED, FLAG_DATA_DESC, FLAG_STRONG_ENCRYPTED, FLAG_UTF8,
  U32_MAX, U16_MAX, EID_ZIP64,
  EOCD_MIN_LEN, LOC64_LEN, CDH_FIXED_LEN, LFH_FIXED_LEN, EOCD64_FIXED_LEN,
  ZipError, type ZipErrorCode,
} from './struct';

/** 公开条目元数据（任务书固定字段）。 */
export interface ZipEntry {
  name: string;
  /** 未压缩尺寸（字节）。 */
  size: number;
  /** 压缩后尺寸（字节）。 */
  compressedSize: number;
  /** 压缩方法：0 stored / 8 deflate。 */
  method: 0 | 8;
  /** CRC-32（无符号）。 */
  crc: number;
}

/** 解析期内部条目：在 ZipEntry 之上补齐读取所需的定位信息。 */
interface EntryRec extends ZipEntry {
  flags: number;
  /** DOS 时间/日期原始字段（本实现不转换，保持字节语义）。 */
  dosTime: number;
  dosDate: number;
  lfhOffset: number;
  /** 条目注释（按名字同款编码规则解码）。 */
  comment: string;
  /** 外部属性（Unix 权限位于高 16 位）。 */
  externalAttrs: number;
  /** 版本 made by（高 8 位宿主系统）。 */
  madeBy: number;
  /** 压缩数据起始绝对偏移（解析 LFH 后得出）。 */
  dataStart: number;
  /** bit3：数据后随描述符。 */
  hasDescriptor: boolean;
}

/** readZip 返回结构：条目元数据数组 + 惰性内容读取。 */
export interface ZipArchive {
  entries: ZipEntry[];
  /** 按名字读条目内容并验证 CRC；重名取第一个；未知名抛错。 */
  read(name: string): Uint8Array;
}

/** 中央目录 / 本地头共用的哨兵占位信息（ZIP64 扩展字段消费顺序的依据）。 */
interface RawSizes {
  usize: number;
  csize: number;
  lfhOffset: number;
  diskStart: number;
}

const UTF8_DECODER = new TextDecoder('utf-8', { fatal: false });

// —— 小端读取辅助（全部带边界前置校验，绝不越界） ——

function u16(u8: Uint8Array, p: number): number {
  return u8[p]! | (u8[p + 1]! << 8);
}

function u32(u8: Uint8Array, p: number): number {
  return (u8[p]! | (u8[p + 1]! << 8) | (u8[p + 2]! << 16) | (u8[p + 3]! << 24)) >>> 0;
}

/** 无符号 64 位（低 32 + 高 32 × 2^32）。超出 Number.MAX_SAFE_INTEGER 时仍精确。 */
function u64(u8: Uint8Array, p: number): number {
  const lo = u32(u8, p);
  const hi = u32(u8, p + 4);
  return hi * 0x100000000 + lo;
}

/** EOCD / EOCD64 定位结果。 */
interface EocdInfo {
  total: number;
  cdSize: number;
  cdOffset: number;
  /** EOCD 记录前的档案级注释。 */
  comment: string;
  zip64: boolean;
}

/**
 * 步骤 1：EOCD 定位。
 * 扫描区间 [max(0, len-22-65535), len-22]，候选需过两道校验：
 *   a) 签名 + “22 字节记录 + 注释恰好到文件尾”互证；
 *   b) 候选指向的中央目录起点签名正确（或 ZIP64 链路完整）。
 * 注释内容里的伪 EOCD 记录（恰好落在文件尾的 22 字节）会因 b) 被跳过。
 * ZIP64 链路失败的候选先记录，扫描穷尽后作为最终错误抛出。
 */
function locateEOCD(u8: Uint8Array): EocdInfo {
  const len = u8.length;
  const lowest = Math.max(0, len - EOCD_MIN_LEN - 65535);
  let zip64CandidateError: ZipError | null = null;
  let cdVerifyFailed = false; // 存在过候选但 CD 互证全部失败

  for (let p = len - EOCD_MIN_LEN; p >= lowest; p--) {
    if (u32(u8, p) !== SIG_EOCD) continue;
    const commentLen = u16(u8, p + 20);
    if (p + EOCD_MIN_LEN + commentLen !== len) continue; // 注释长度与位置互证
    let total = u16(u8, p + 10);
    let cdSize = u32(u8, p + 12);
    let cdOffset = u32(u8, p + 16);
    const commentBytes = u8.subarray(p + EOCD_MIN_LEN, p + EOCD_MIN_LEN + commentLen);
    let zip64 = false;

    // 步骤 2：ZIP64。哨兵出现 → 定位器/EOCD64 必须存在；否则机会式探测
    // （部分写入器恒写 ZIP64 结构，即使值未超 32 位）。
    const sentinel =
      total === U16_MAX || cdSize === U32_MAX || cdOffset === U32_MAX;
    const locPos = p - LOC64_LEN;
    const hasLocator = locPos >= 0 && u32(u8, locPos) === SIG_LOC64;
    if (sentinel || hasLocator) {
      try {
        if (!hasLocator) {
          throw new ZipError('BAD_ZIP64', 'EOCD 含 ZIP64 哨兵但定位器缺失');
        }
        const e64Off = u64(u8, locPos + 8);
        if (e64Off + EOCD64_FIXED_LEN > p) {
          throw new ZipError('BAD_ZIP64', `EOCD64 偏移 ${e64Off} 越过定位器位置`);
        }
        if (u32(u8, e64Off) !== SIG_EOCD64) {
          throw new ZipError('BAD_ZIP64', `EOCD64 签名错误 @${e64Off}`);
        }
        total = u64(u8, e64Off + 32);
        cdSize = u64(u8, e64Off + 40);
        cdOffset = u64(u8, e64Off + 48);
        zip64 = true;
      } catch (e) {
        // 该候选是伪记录或链路损坏：记录后继续向前扫（真 EOCD 可能更靠前）
        if (e instanceof ZipError && zip64CandidateError === null) {
          zip64CandidateError = e;
        }
        continue;
      }
    } else {
      // 非 ZIP64 候选：中央目录起点签名互证（空档案豁免）
      const emptyArchive = total === 0 && cdSize === 0 && cdOffset === 0;
      if (!emptyArchive) {
        if (cdOffset + cdSize > p || u32(u8, cdOffset) !== SIG_CDH) {
          cdVerifyFailed = true;
          continue; // 伪记录：继续扫描
        }
      }
    }
    return { total, cdSize, cdOffset, comment: decodeName(commentBytes, FLAG_UTF8), zip64 };
  }
  if (zip64CandidateError !== null) throw zip64CandidateError;
  if (cdVerifyFailed) {
    throw new ZipError('BAD_EOCD', 'EOCD 候选存在但中央目录互证失败（伪记录或 CD 偏移损坏）');
  }
  throw new ZipError('NO_EOCD', 'EOCD 未找到（含 64K 注释边界扫描穷尽）');
}

/** 文件名解码：EFS 位 → UTF-8；否则 CP437（APPNOTE 附录 D）。 */
function decodeName(bytes: Uint8Array, flags: number): string {
  return (flags & FLAG_UTF8) !== 0
    ? UTF8_DECODER.decode(bytes)
    : cp437Decode(bytes);
}

/**
 * 消费 ZIP64 扩展字段（header id 0x0001）。
 * APPNOTE：字段按「未压缩尺寸、压缩尺寸、本地头偏移、盘号」固定顺序出现，
 * 且只为本头中取哨兵值的字段存在。不按哨兵占位对齐的消费一律视为损坏。
 */
function consumeZip64Extra(
  extra: Uint8Array,
  raw: RawSizes,
  where: string,
): void {
  let p = 0;
  while (p + 4 <= extra.length) {
    const id = u16(extra, p);
    const sz = u16(extra, p + 2);
    const body = p + 4;
    if (body + sz > extra.length) {
      throw new ZipError('BAD_CDH', `${where}：extra 字段长度越界`);
    }
    if (id === EID_ZIP64) {
      let q = body;
      const end = body + sz;
      if (raw.usize === U32_MAX) {
        if (q + 8 > end) throw new ZipError('BAD_ZIP64', `${where}：ZIP64 extra 缺未压缩尺寸字段`);
        raw.usize = u64(extra, q); q += 8;
      }
      if (raw.csize === U32_MAX) {
        if (q + 8 > end) throw new ZipError('BAD_ZIP64', `${where}：ZIP64 extra 缺压缩尺寸字段`);
        raw.csize = u64(extra, q); q += 8;
      }
      if (raw.lfhOffset === U32_MAX) {
        if (q + 8 > end) throw new ZipError('BAD_ZIP64', `${where}：ZIP64 extra 缺本地头偏移字段`);
        raw.lfhOffset = u64(extra, q); q += 8;
      }
      if (raw.diskStart === U16_MAX) {
        if (q + 4 > end) throw new ZipError('BAD_ZIP64', `${where}：ZIP64 extra 缺盘号字段`);
        raw.diskStart = u32(extra, q); q += 4;
      }
      // 容忍尾随多余字节：真实写入器（Info-ZIP/Python 等）有时在非哨兵字段
      // 也写全量 8 字节值（对齐 Python zipfile 的“按哨兵消费、余量忽略”）。
    }
    p = body + sz;
  }
}

/**
 * 步骤 3+4：解析中央目录，并对每个条目做本地文件头对齐校验。
 * 校验失败即抛错（M1 的“本地头对齐校验”在解析期完成，readZip 成功 ⇒ 结构可信）。
 */
function parseCentralDirectory(u8: Uint8Array, info: EocdInfo): EntryRec[] {
  const len = u8.length;
  if (info.cdOffset > len || info.cdSize > len - info.cdOffset) {
    throw new ZipError('BAD_CDH', `中央目录区间越界：offset=${info.cdOffset} size=${info.cdSize} 文件=${len}`);
  }
  // 条目数健全性：每条至少 46 字节，声称的条目数不可能超过 CD 区间容量
  if (info.total > Math.floor(info.cdSize / CDH_FIXED_LEN)) {
    throw new ZipError('BAD_CDH', `条目数 ${info.total} 超出中央目录区间容量`);
  }

  const entries: EntryRec[] = [];
  let p = info.cdOffset;
  const cdEnd = info.cdOffset + info.cdSize;

  for (let k = 0; k < info.total; k++) {
    if (p + CDH_FIXED_LEN > cdEnd) {
      throw new ZipError('BAD_CDH', `中央目录第 ${k} 条头部越界`);
    }
    if (u32(u8, p) !== SIG_CDH) {
      throw new ZipError('BAD_CDH', `中央目录第 ${k} 条签名错误 @${p}`);
    }
    const madeBy = u16(u8, p + 4);
    const flags = u16(u8, p + 8);
    const method = u16(u8, p + 10);
    const dosTime = u16(u8, p + 12);
    const dosDate = u16(u8, p + 14);
    const crc = u32(u8, p + 16);
    const raw: RawSizes = {
      usize: u32(u8, p + 24),
      csize: u32(u8, p + 20),
      lfhOffset: u32(u8, p + 42),
      diskStart: u16(u8, p + 34),
    };
    const nlen = u16(u8, p + 28);
    const elen = u16(u8, p + 30);
    const clen = u16(u8, p + 32);
    const externalAttrs = u32(u8, p + 38);

    if (p + CDH_FIXED_LEN + nlen + elen + clen > cdEnd) {
      throw new ZipError('BAD_CDH', `中央目录第 ${k} 条可变段越界`);
    }
    const nameBytes = u8.subarray(p + CDH_FIXED_LEN, p + CDH_FIXED_LEN + nlen);
    const extraBytes = u8.subarray(p + CDH_FIXED_LEN + nlen, p + CDH_FIXED_LEN + nlen + elen);
    const commentBytes = u8.subarray(
      p + CDH_FIXED_LEN + nlen + elen,
      p + CDH_FIXED_LEN + nlen + elen + clen,
    );

    // —— 解析期即拒绝的“不支持”语义（任务书：只解析标志并抛“不支持”）——
    if ((flags & FLAG_ENCRYPTED) !== 0 || (flags & FLAG_STRONG_ENCRYPTED) !== 0) {
      throw new ZipError('ENCRYPTED', `条目 "${decodeName(nameBytes, flags)}" 带加密标志（bit${(flags & FLAG_ENCRYPTED) !== 0 ? 0 : 6}），本实现不支持解密`);
    }
    if (method !== METHOD_STORED && method !== METHOD_DEFLATE) {
      throw new ZipError('BAD_METHOD', `条目 "${decodeName(nameBytes, flags)}" 使用不支持的压缩方法 ${method}（只支持 stored=0 / deflate=8）`);
    }

    consumeZip64Extra(extraBytes, raw, `中央目录第 ${k} 条`);
    const name = decodeName(nameBytes, flags);

    // —— 步骤 4：本地文件头对齐校验 ——
    if (raw.lfhOffset + LFH_FIXED_LEN > len) {
      throw new ZipError('BAD_LFH', `条目 "${name}" 本地头偏移 ${raw.lfhOffset} 越界`);
    }
    if (u32(u8, raw.lfhOffset) !== SIG_LFH) {
      throw new ZipError('BAD_LFH', `条目 "${name}" 本地文件头签名错误 @${raw.lfhOffset}`);
    }
    const lFlags = u16(u8, raw.lfhOffset + 6);
    const lMethod = u16(u8, raw.lfhOffset + 8);
    // LFH 定长区偏移：10=time 12=date 14=crc 18=csize 22=usize 26=nlen 28=elen
    const lTime = u16(u8, raw.lfhOffset + 10);
    const lDate = u16(u8, raw.lfhOffset + 12);
    const lCrc = u32(u8, raw.lfhOffset + 14);
    const lRaw: RawSizes = {
      usize: u32(u8, raw.lfhOffset + 22),
      csize: u32(u8, raw.lfhOffset + 18),
      lfhOffset: raw.lfhOffset, // LFH 无偏移字段，占位不消费
      diskStart: 0,             // LFH 无盘号字段：非哨兵初值，extra 不含盘号
    };
    const lNlen = u16(u8, raw.lfhOffset + 26);
    const lElen = u16(u8, raw.lfhOffset + 28);
    if (raw.lfhOffset + LFH_FIXED_LEN + lNlen + lElen > len) {
      throw new ZipError('BAD_LFH', `条目 "${name}" 本地头可变段越界`);
    }
    const lNameBytes = u8.subarray(raw.lfhOffset + LFH_FIXED_LEN, raw.lfhOffset + LFH_FIXED_LEN + lNlen);
    const lExtraBytes = u8.subarray(raw.lfhOffset + LFH_FIXED_LEN + lNlen, raw.lfhOffset + LFH_FIXED_LEN + lNlen + lElen);

    // 名字：中央目录与本地头必须逐字节一致（以中央目录字节为基准）
    if (lNameBytes.length !== nameBytes.length ||
        !nameBytes.every((b, i) => lNameBytes[i] === b)) {
      throw new ZipError('LFH_MISMATCH', `条目 "${name}" 本地头名字与中央目录不一致`);
    }
    // 方法/标志/时间戳：一致语义（bit3 等所有位原样比对）
    if (lMethod !== method) {
      throw new ZipError('LFH_MISMATCH', `条目 "${name}" 本地头方法 ${lMethod} 与中央目录 ${method} 不一致`);
    }
    if (lFlags !== flags) {
      throw new ZipError('LFH_MISMATCH', `条目 "${name}" 本地头标志 0x${lFlags.toString(16)} 与中央目录 0x${flags.toString(16)} 不一致`);
    }
    if (lTime !== dosTime || lDate !== dosDate) {
      throw new ZipError('LFH_MISMATCH', `条目 "${name}" 本地头时间戳与中央目录不一致`);
    }
    // CRC/尺寸：bit3 时允许本地头为 0（写时未知）；否则逐字段相等
    consumeZip64Extra(lExtraBytes, lRaw, `条目 "${name}" 本地头`);
    if ((flags & FLAG_DATA_DESC) === 0) {
      if (lCrc !== crc) {
        throw new ZipError('LFH_MISMATCH', `条目 "${name}" 本地头 CRC 0x${lCrc.toString(16)} 与中央目录 0x${crc.toString(16)} 不一致`);
      }
      if (lRaw.csize !== raw.csize || lRaw.usize !== raw.usize) {
        throw new ZipError('LFH_MISMATCH', `条目 "${name}" 本地头尺寸 (${lRaw.csize}/${lRaw.usize}) 与中央目录 (${raw.csize}/${raw.usize}) 不一致`);
      }
    } else {
      const unknown = (v: number): boolean => v === 0 || v === U32_MAX;
      if (!unknown(lCrc) && lCrc !== crc) {
        throw new ZipError('LFH_MISMATCH', `条目 "${name}" 本地头 CRC（bit3 已知值）与中央目录不一致`);
      }
      if (!unknown(lRaw.csize) && lRaw.csize !== raw.csize) {
        throw new ZipError('LFH_MISMATCH', `条目 "${name}" 本地头压缩尺寸（bit3 已知值）与中央目录不一致`);
      }
      if (!unknown(lRaw.usize) && lRaw.usize !== raw.usize) {
        throw new ZipError('LFH_MISMATCH', `条目 "${name}" 本地头未压缩尺寸（bit3 已知值）与中央目录不一致`);
      }
    }

    entries.push({
      name,
      size: raw.usize,
      compressedSize: raw.csize,
      method: method as 0 | 8,
      crc,
      flags,
      dosTime,
      dosDate,
      lfhOffset: raw.lfhOffset,
      comment: decodeName(commentBytes, flags),
      externalAttrs,
      madeBy,
      dataStart: raw.lfhOffset + LFH_FIXED_LEN + lNlen + lElen,
      hasDescriptor: (flags & FLAG_DATA_DESC) !== 0,
    });
    p += CDH_FIXED_LEN + nlen + elen + clen;
  }

  // 恰好在声明条目数处结束才可信（CD 区间尾部多余内容 = 结构损坏）
  if (p !== cdEnd) {
    throw new ZipError('BAD_CDH', `中央目录消费结束位置 ${p} 与声明区间终点 ${cdEnd} 不符`);
  }
  return entries;
}

/**
 * 步骤 5：解压并验证单个条目。
 * stored → 区间切片；deflate → 移植库 inflate（sizeHint 预分配，封顶 256MB
 * 防损坏登记值撑爆内存）；输出长度与 CRC 双验证；bit3 时继续消费数据描述符。
 */
function readEntry(u8: Uint8Array, e: EntryRec): Uint8Array {
  const len = u8.length;
  const dataEnd = e.dataStart + e.compressedSize;
  if (dataEnd > len) {
    throw new ZipError('BAD_DATA', `条目 "${e.name}" 数据区间越界（[${e.dataStart}, ${dataEnd}) > ${len}）`);
  }
  const compressed = u8.subarray(e.dataStart, dataEnd);

  let out: Uint8Array;
  if (e.method === METHOD_STORED) {
    out = compressed;
  } else {
    // 预分配提示按登记值，但封顶——损坏档案的 0xFFFFFFFF 登记值不该触发 4GB 分配
    const hint = Math.min(e.size, 256 * 1024 * 1024);
    out = inflate(compressed, hint);
  }

  if (out.length !== e.size) {
    throw new ZipError('SIZE_MISMATCH', `条目 "${e.name}" 解压长度 ${out.length} 与登记值 ${e.size} 不符`);
  }
  const actualCrc = crc32(out);
  if (actualCrc !== e.crc) {
    throw new ZipError('CRC_MISMATCH', `条目 "${e.name}" CRC 校验失败（实际 0x${actualCrc.toString(16)} ≠ 登记 0x${e.crc.toString(16)}）`);
  }

  // 数据描述符（bit3）：带签名（12/20 字节）与无签名两种模式。
  // 无签名模式的判定依据：紧随数据后的字段值必须与实算 CRC/登记尺寸相符。
  if (e.hasDescriptor) {
    const dPos = dataEnd;
    if (dPos + 4 > len) {
      throw new ZipError('BAD_DESC', `条目 "${e.name}" bit3 声明描述符但数据后无空间`);
    }
    const needZip64 = e.size > U32_MAX || e.compressedSize > U32_MAX;
    const descLen = needZip64 ? 20 : 12; // 不含签名时的长度
    if (u32(u8, dPos) === SIG_DESC) {
      if (dPos + 4 + descLen > len) {
        throw new ZipError('BAD_DESC', `条目 "${e.name}" 描述符区间越界`);
      }
      const dCrc = u32(u8, dPos + 4);
      const dCsize = needZip64 ? u64(u8, dPos + 8) : u32(u8, dPos + 8);
      const dUsize = needZip64 ? u64(u8, dPos + 16) : u32(u8, dPos + 12);
      if (dCrc !== actualCrc || dCsize !== e.compressedSize || dUsize !== e.size) {
        throw new ZipError('BAD_DESC', `条目 "${e.name}" 描述符字段与实算值不符`);
      }
    } else {
      if (dPos + descLen > len) {
        throw new ZipError('BAD_DESC', `条目 "${e.name}" 描述符（无签名模式）区间越界`);
      }
      const dCrc = u32(u8, dPos);
      const dCsize = needZip64 ? u64(u8, dPos + 4) : u32(u8, dPos + 4);
      const dUsize = needZip64 ? u64(u8, dPos + 12) : u32(u8, dPos + 8);
      if (dCrc !== actualCrc || dCsize !== e.compressedSize || dUsize !== e.size) {
        throw new ZipError('BAD_DESC', `条目 "${e.name}" 描述符缺失且无签名模式下字段值不符`);
      }
    }
  }
  return out;
}

/**
 * 公开入口：解析 ZIP 档案。
 * 成功返回条目元数据（解析期已含本地头对齐校验）+ 惰性内容读取函数。
 */
export function readZip(bytes: Uint8Array): ZipArchive {
  const info = locateEOCD(bytes);
  const recs = parseCentralDirectory(bytes, info);
  const byName = new Map<string, EntryRec>();
  for (const r of recs) {
    if (!byName.has(r.name)) byName.set(r.name, r);
  }
  const entries: ZipEntry[] = recs.map((r) => ({
    name: r.name, size: r.size, compressedSize: r.compressedSize,
    method: r.method, crc: r.crc,
  }));
  return {
    entries,
    read(name: string): Uint8Array {
      const rec = byName.get(name);
      if (rec === undefined) {
        throw new ZipError('BAD_NAME', `条目 "${name}" 不存在`);
      }
      return readEntry(bytes, rec);
    },
  };
}

/** 供 Web UI 使用的富元数据（注释/属性/目录标记/标志位），非任务书公开 API。 */
export interface ZipEntryDetail extends ZipEntry {
  isDir: boolean;
  comment: string;
  externalAttrs: number;
  madeBy: number;
  flags: number;
  dosTime: number;
  dosDate: number;
}

export interface ZipArchiveDetail extends ZipArchive {
  entriesDetail: ZipEntryDetail[];
  /** 档案级注释。 */
  archiveComment: string;
  /** 是否走了 ZIP64 链路。 */
  zip64: boolean;
}

/** Web UI 入口：同一解析管线，附带富元数据与惰性读取共享缓存。 */
export function readZipDetail(bytes: Uint8Array): ZipArchiveDetail {
  const info = locateEOCD(bytes);
  const recs = parseCentralDirectory(bytes, info);
  const byName = new Map<string, EntryRec>();
  for (const r of recs) if (!byName.has(r.name)) byName.set(r.name, r);
  const cache = new Map<string, Uint8Array>();
  const read = (name: string): Uint8Array => {
    const hit = cache.get(name);
    if (hit !== undefined) return hit;
    const rec = byName.get(name);
    if (rec === undefined) throw new ZipError('BAD_NAME', `条目 "${name}" 不存在`);
    const out = readEntry(bytes, rec);
    cache.set(name, out);
    return out;
  };
  return {
    entries: recs.map((r) => ({
      name: r.name, size: r.size, compressedSize: r.compressedSize,
      method: r.method, crc: r.crc,
    })),
    read,
    entriesDetail: recs.map((r) => ({
      name: r.name, size: r.size, compressedSize: r.compressedSize,
      method: r.method, crc: r.crc,
      isDir: r.name.endsWith('/'),
      comment: r.comment,
      externalAttrs: r.externalAttrs,
      madeBy: r.madeBy,
      flags: r.flags,
      dosTime: r.dosTime,
      dosDate: r.dosDate,
    })),
    archiveComment: info.comment,
    zip64: info.zip64,
  };
}

/** 供 Web UI / 测试复用的错误类型与错误码。 */
export { ZipError };
export type { ZipErrorCode };
