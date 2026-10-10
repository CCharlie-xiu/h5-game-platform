/**
 * 动作定义。
 *
 * 模板只提供一个示例动作 `endTurn`，用于演示「动作构造器 + 判别联合」的写法。
 * 真实游戏在这里补充自己的动作集合。
 */

/** 动作类型常量。 */
export const ActionType = {
  /** 结束当前回合。 */
  EndTurn: 'endTurn',
} as const;

/** 动作类型。 */
export type ActionType = (typeof ActionType)[keyof typeof ActionType];

/** 结束当前回合。 */
export interface EndTurnAction {
  readonly type: typeof ActionType.EndTurn;
}

/** 模板游戏的全部动作。 */
export type GameAction = EndTurnAction;

/** 构造一个 `endTurn` 动作。 */
export function endTurn(): EndTurnAction {
  return { type: ActionType.EndTurn };
}
