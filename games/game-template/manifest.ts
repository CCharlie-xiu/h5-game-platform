import type { GameManifest } from '@h5/game-sdk';

/**
 * 游戏元信息。
 *
 * 复制 `game-template` 创建新游戏时，必须先修改这里的
 * `id` / `name` / `minPlayers` / `maxPlayers`。
 */
export const manifest: GameManifest = {
  id: 'game-template',
  name: '游戏模板',
  version: '0.1.0',
  minPlayers: 2,
  maxPlayers: 4,
};
