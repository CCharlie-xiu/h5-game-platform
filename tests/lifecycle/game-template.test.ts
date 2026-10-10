import { describe, expect, it } from 'vitest';

import { ActionType, createInitialState, endTurn, reduce } from '@h5/game-template';

describe('@h5/game-template 规则骨架', () => {
  it('初始状态为第 0 回合、0 号玩家、未结束', () => {
    expect(createInitialState()).toEqual({
      turn: 0,
      currentPlayer: 0,
      finished: false,
    });
  });

  it('endTurn 递增回合数', () => {
    const next = reduce(createInitialState(), endTurn());
    expect(next.turn).toBe(1);
  });

  it('reducer 保持纯函数，不修改传入状态', () => {
    const state = createInitialState();
    reduce(state, endTurn());
    expect(state.turn).toBe(0);
  });

  it('未知动作返回原状态对象', () => {
    const state = createInitialState();
    // @ts-expect-error 故意传入未定义动作，用于验证 reducer 的兜底分支
    expect(reduce(state, { type: 'unknown' })).toBe(state);
  });

  it('动作类型常量与 reducer 分支一致', () => {
    expect(ActionType.EndTurn).toBe('endTurn');
  });
});
