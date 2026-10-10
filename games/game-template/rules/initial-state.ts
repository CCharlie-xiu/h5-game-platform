/**
 * 游戏初始状态。
 *
 * 模板只保留最小字段，用于演示状态形状；
 * 具体游戏的完整状态在各自游戏内定义。
 */
export interface GameState {
  /** 已完成的回合数。 */
  readonly turn: number;
  /** 当前行动玩家的座位号（从 0 开始）。 */
  readonly currentPlayer: number;
  /** 对局是否已结束。 */
  readonly finished: boolean;
}

/** 构造模板的初始状态。 */
export function createInitialState(): GameState {
  return {
    turn: 0,
    currentPlayer: 0,
    finished: false,
  };
}
