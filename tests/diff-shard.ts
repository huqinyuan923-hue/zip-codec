/** 差分 1 分片 runner：每片 250 组，种子 = 基数 + 片号（可复现）。 */
import { describe, it } from 'vitest';
import { crossCheck, genFileSet, mulberry32 } from './diff-engine';

export function runShard(shard: number): void {
  describe(`差分 1 · 分片 ${shard + 1}（种子 ${20260101 + shard}）`, () => {
    it('250 组随机文件集三方向互验', () => {
      const rnd = mulberry32(20260101 + shard);
      for (let g = 0; g < 250; g++) {
        crossCheck(genFileSet(rnd));
      }
    }, 600_000);
  });
}
