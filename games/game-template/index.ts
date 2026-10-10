import type { GamePlugin } from '@h5/game-sdk';

import { defaultConfig } from './config';
import type { GameConfig } from './config';
import { manifest } from './manifest';
import { ActionType, endTurn } from './rules/actions';
import type { EndTurnAction, GameAction } from './rules/actions';
import { createInitialState } from './rules/initial-state';
import type { GameState } from './rules/initial-state';
import { reduce } from './rules/reducer';

export { defaultConfig, manifest };
export type { GameConfig };
export { ActionType, createInitialState, endTurn, reduce };
export type { EndTurnAction, GameAction, GameState };

/**
 * 模板插件实例。
 *
 * 新游戏应当以本模板为起点：复制目录 → 修改 manifest → 实现 rules/scenes。
 */
export const gameTemplate: GamePlugin = {
  manifest,
};
