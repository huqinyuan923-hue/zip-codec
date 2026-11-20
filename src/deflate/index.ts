// ============================================================
// 移植出处：C:\works\deflate\src\index.ts（deflate 项目公共入口）。
// 裁剪移植：ZIP 只需要 inflate / deflateRaw / crc32 三个函数，
// gzip/gunzip（RFC 1952 容器）不属于 ZIP 语义，未随迁。
// ============================================================
export { inflate, inflateRawImpl } from './inflate';
export { deflateRaw } from './deflate';
export { crc32 } from './crc32';
