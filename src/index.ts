/**
 * zip-codec 公共入口（任务书公开 API）。
 *
 *   readZip(bytes)                          → { entries, read(name) }
 *   writeZip(files, opts?)                  → Uint8Array
 *
 * 零 npm 运行时依赖：DEFLATE 引擎为 deflate 项目的移植（见 src/deflate/）。
 * ZipError 为统一错误类型（code 字段供差分/模糊断言）。
 */
export type { ZipEntry } from './reader';
export { readZip, ZipError } from './reader';
export type { ZipErrorCode } from './struct';
export { writeZip } from './writer';
export type { ZipInput, WriteOptions } from './writer';
