import { ActionType } from './actions';
import type { GameAction } from './actions';
import type { GameState } from './initial-state';

/**
 * 纯函数 reducer：接收当前状态与动作，返回新状态。
 *
 * 阶段 1 仅实现示例动作 `endTurn`，不包含任何真实游戏规则。
 * 真实游戏在此实现完整规则；reducer 必须保持纯函数，不得产生副作用。
 */
export function reduce(state: GameState, action: GameAction): GameState {
  switch (action.type) {
    case ActionType.EndTurn:
      return {
        ...state,
        turn: state.turn + 1,
      };
    default:
      return state;
  }
}
