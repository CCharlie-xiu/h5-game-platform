import type { GameManifest, GamePlugin } from '@h5/game-sdk';

/**
 * 扩散大师。
 *
 * 阶段 1 仅登记元信息。
 * **游戏规则、场景、动画均尚未实现**，前端据此展示为「未实现」入口。
 */

/** 游戏元信息。 */
export const manifest: GameManifest = {
  id: 'diffusion-master',
  name: '扩散大师',
  version: '0.1.0',
  minPlayers: 2,
  maxPlayers: 6,
};

/** 是否已实现。阶段 1 固定为 `false`，实现后改为 `true`。 */
export const implemented = false;

/** 插件实例（当前仅含元信息）。 */
export const plugin: GamePlugin = {
  manifest,
};
