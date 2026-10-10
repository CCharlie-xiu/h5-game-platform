import { ErrorCode, GamePhase } from '@h5/game-protocol';
import {
  LifecycleTrigger,
  allowedTriggers,
  canAcceptGameActions,
  evaluateReadyPhase,
  isTerminal,
  transition,
} from '@h5/game-core';
import type { TransitionContext } from '@h5/game-core';
import { describe, expect, it } from 'vitest';

const HOST = 'p_host';

function context(overrides: Partial<TransitionContext> = {}): TransitionContext {
  return {
    actorPlayerId: HOST,
    hostPlayerId: HOST,
    playerCount: 2,
    minPlayers: 2,
    allReady: true,
    ...overrides,
  };
}

describe('生命周期：阶段与终态', () => {
  it('FINISHED 为终态', () => {
    expect(isTerminal(GamePhase.FINISHED)).toBe(true);
    expect(isTerminal(GamePhase.PLAYING)).toBe(false);
  });

  it('仅 PLAYING 接受游戏操作', () => {
    expect(canAcceptGameActions(GamePhase.PLAYING)).toBe(true);
    for (const phase of [GamePhase.WAITING, GamePhase.READY, GamePhase.PAUSED, GamePhase.FINISHED]) {
      expect(canAcceptGameActions(phase)).toBe(false);
    }
  });

  it('转换表：终态无任何合法触发器', () => {
    expect(allowedTriggers(GamePhase.FINISHED)).toHaveLength(0);
  });

  it('转换表：各阶段允许的触发器', () => {
    expect(allowedTriggers(GamePhase.WAITING)).toEqual([LifecycleTrigger.PlayersChanged]);
    expect(allowedTriggers(GamePhase.READY)).toEqual([
      LifecycleTrigger.PlayersChanged,
      LifecycleTrigger.Start,
    ]);
    expect(allowedTriggers(GamePhase.PLAYING)).toEqual([
      LifecycleTrigger.Pause,
      LifecycleTrigger.End,
    ]);
    expect(allowedTriggers(GamePhase.PAUSED)).toEqual([
      LifecycleTrigger.Resume,
      LifecycleTrigger.End,
    ]);
  });
});

describe('生命周期：WAITING ⇄ READY', () => {
  it('人数与准备都满足时进入 READY', () => {
    expect(evaluateReadyPhase({ playerCount: 3, minPlayers: 2, allReady: true })).toBe(
      GamePhase.READY,
    );
  });

  it('人数不足时保持 WAITING', () => {
    expect(evaluateReadyPhase({ playerCount: 1, minPlayers: 2, allReady: true })).toBe(
      GamePhase.WAITING,
    );
  });

  it('有人未准备时保持 WAITING', () => {
    expect(evaluateReadyPhase({ playerCount: 3, minPlayers: 2, allReady: false })).toBe(
      GamePhase.WAITING,
    );
  });

  it('PLAYERS_CHANGED 由 WAITING 转为 READY', () => {
    const result = transition(GamePhase.WAITING, LifecycleTrigger.PlayersChanged, context());
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.phase).toBe(GamePhase.READY);
      expect(result.changed).toBe(true);
    }
  });

  it('PLAYERS_CHANGED 由 READY 退回 WAITING', () => {
    const result = transition(
      GamePhase.READY,
      LifecycleTrigger.PlayersChanged,
      context({ allReady: false }),
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.phase).toBe(GamePhase.WAITING);
    }
  });
});

describe('生命周期：开始游戏', () => {
  it('房主在 READY 阶段可以开始', () => {
    const result = transition(GamePhase.READY, LifecycleTrigger.Start, context());
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.phase).toBe(GamePhase.PLAYING);
    }
  });

  it('非房主不得发起开始游戏', () => {
    const result = transition(
      GamePhase.READY,
      LifecycleTrigger.Start,
      context({ actorPlayerId: 'p_other' }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe(ErrorCode.NotHost);
    }
  });

  it('人数不足时拒绝开始', () => {
    const result = transition(
      GamePhase.READY,
      LifecycleTrigger.Start,
      context({ playerCount: 1 }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe(ErrorCode.NotEnoughPlayers);
    }
  });

  it('有人未准备时拒绝开始', () => {
    const result = transition(
      GamePhase.READY,
      LifecycleTrigger.Start,
      context({ allReady: false }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe(ErrorCode.PlayersNotReady);
    }
  });

  it('WAITING 阶段即使条件满足也不能开始（阶段不合法）', () => {
    const result = transition(GamePhase.WAITING, LifecycleTrigger.Start, context());
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe(ErrorCode.InvalidTransition);
    }
  });
});

describe('生命周期：暂停 / 继续 / 结束', () => {
  it('PLAYING 阶段房主可暂停', () => {
    const result = transition(GamePhase.PLAYING, LifecycleTrigger.Pause, context());
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.phase).toBe(GamePhase.PAUSED);
    }
  });

  it('游戏未开始不得暂停', () => {
    for (const phase of [GamePhase.WAITING, GamePhase.READY]) {
      const result = transition(phase, LifecycleTrigger.Pause, context());
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe(ErrorCode.InvalidTransition);
      }
    }
  });

  it('非房主不得暂停', () => {
    const result = transition(
      GamePhase.PLAYING,
      LifecycleTrigger.Pause,
      context({ actorPlayerId: 'p_other' }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe(ErrorCode.NotHost);
    }
  });

  it('PAUSED 阶段房主可继续', () => {
    const result = transition(GamePhase.PAUSED, LifecycleTrigger.Resume, context());
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.phase).toBe(GamePhase.PLAYING);
    }
  });

  it('非 PAUSED 状态不得继续', () => {
    for (const phase of [GamePhase.WAITING, GamePhase.READY, GamePhase.PLAYING]) {
      const result = transition(phase, LifecycleTrigger.Resume, context());
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe(ErrorCode.InvalidTransition);
      }
    }
  });

  it('PLAYING 与 PAUSED 都可以结束', () => {
    for (const phase of [GamePhase.PLAYING, GamePhase.PAUSED]) {
      const result = transition(phase, LifecycleTrigger.End, context());
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.phase).toBe(GamePhase.FINISHED);
      }
    }
  });

  it('FINISHED 状态不得恢复游戏', () => {
    const result = transition(GamePhase.FINISHED, LifecycleTrigger.Resume, context());
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe(ErrorCode.InvalidTransition);
    }
  });

  it('已结束对局不再接受任何触发器', () => {
    const triggers = [
      LifecycleTrigger.PlayersChanged,
      LifecycleTrigger.Start,
      LifecycleTrigger.Pause,
      LifecycleTrigger.Resume,
      LifecycleTrigger.End,
    ];
    for (const trigger of triggers) {
      const result = transition(GamePhase.FINISHED, trigger, context());
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe(ErrorCode.InvalidTransition);
      }
    }
  });
});
