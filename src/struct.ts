/**
 * ZIP 结构常量（PKWARE APPNOTE.TXT 6.3.x 视角）。
 * 签名值全部为小端字节序读取后的 uint32。
 */

/** 本地文件头 PK\x03\x04。 */
export const SIG_LFH = 0x04034b50;
/** 中央目录文件头 PK\x01\x02。 */
export const SIG_CDH = 0x02014b50;
/** EOCD PK\x05\x06。 */
export const SIG_EOCD = 0x06054b50;
/** ZIP64 EOCD 记录 PK\x06\x06。 */
export const SIG_EOCD64 = 0x06064b50;
/** ZIP64 EOCD 定位器 PK\x06\x07。 */
export const SIG_LOC64 = 0x07064b50;
/** 数据描述符签名 PK\x07\x08（可选出现——两种描述符模式的区别所在）。 */
export const SIG_DESC = 0x08074b50;

/** 压缩方法：stored。 */
export const METHOD_STORED = 0;
/** 压缩方法：deflate。 */
export const METHOD_DEFLATE = 8;

/** 通用标志位 bit0：加密（本实现只解析并拒绝，不做解密）。 */
export const FLAG_ENCRYPTED = 1 << 0;
/** 通用标志位 bit3：数据后随数据描述符（写时 sizes/crc 未知）。 */
export const FLAG_DATA_DESC = 1 << 3;
/** 通用标志位 bit6：强加密（同 bit0，拒绝）。 */
export const FLAG_STRONG_ENCRYPTED = 1 << 6;
/** 通用标志位 bit11（0x800）：文件名为 UTF-8（EFS）；未置位按 CP437 解释。 */
export const FLAG_UTF8 = 1 << 11;

/** 32 位占位值：ZIP64 扩展字段必须出现的哨兵。 */
export const U32_MAX = 0xffffffff;
/** 16 位占位值（条目数/盘号）。 */
export const U16_MAX = 0xffff;

/** ZIP64 扩展字段 header id。 */
export const EID_ZIP64 = 0x0001;

/** EOCD 记录最小长度（注释长度 0）。 */
export const EOCD_MIN_LEN = 22;
/** ZIP64 定位器长度。 */
export const LOC64_LEN = 20;
/** 中央目录头定长部分。 */
export const CDH_FIXED_LEN = 46;
/** 本地文件头定长部分。 */
export const LFH_FIXED_LEN = 30;
/** EOCD64 定长部分。 */
export const EOCD64_FIXED_LEN = 56;

/** 读侧错误码：坏档差分按 code 断言，不按消息文本断言。 */
export type ZipErrorCode =
  | 'NO_EOCD'            // EOCD 签名未找到（含注释长度校验失败的扫描穷尽）
  | 'BAD_EOCD'           // EOCD 存在但字段自相矛盾（如条目数与 CD 区间不符）
  | 'BAD_ZIP64'          // ZIP64 链路（定位器/EOCD64）缺失、签名错或字段矛盾
  | 'BAD_CDH'            // 中央目录头签名错误 / 区间越界 / 条目数不符
  | 'BAD_LFH'            // 本地文件头签名错误 / 偏移越界
  | 'LFH_MISMATCH'       // 本地头与中央目录字段不一致
  | 'BAD_DATA'           // 条目数据区间越界
  | 'BAD_METHOD'         // 不支持的压缩方法
  | 'ENCRYPTED'          // 加密条目（bit0/bit6），本实现不做解密
  | 'BAD_DESC'           // 数据描述符缺失或校验失败
  | 'CRC_MISMATCH'       // 解压后 CRC 与登记值不符
  | 'SIZE_MISMATCH'      // 解压长度与登记值不符
  | 'BAD_NAME';          // 名字长度越界等

/** 统一错误类型：差分与模糊测试断言 code，不匹配消息文案。 */
export class ZipError extends Error {
  code: ZipErrorCode;
  constructor(code: ZipErrorCode, message: string) {
    super(message);
    this.name = 'ZipError';
    this.code = code;
  }
}
