import { ErrorCode, GamePhase, protocolError } from '@h5/game-protocol';
import type { GamePhase as GamePhaseValue, ProtocolError } from '@h5/game-protocol';

export { GamePhase };
export type { GamePhaseValue };

/**
 * 生命周期触发器。
 *
 * `PLAYERS_CHANGED` 由人数 / 准备状态变化隐式触发（WAITING ⇄ READY），
 * 其余触发器均由客户端显式请求。
 */
export const LifecycleTrigger = {
  /** 玩家加入 / 离开 / 准备状态变化后重新评估阶段 */
  PlayersChanged: 'PLAYERS_CHANGED',
  /** 房主开始游戏 */
  Start: 'START',
  /** 房主暂停 */
  Pause: 'PAUSE',
  /** 房主继续 */
  Resume: 'RESUME',
  /** 房主结束对局 */
  End: 'END',
} as const;

/** 触发器类型。 */
export type LifecycleTrigger = (typeof LifecycleTrigger)[keyof typeof LifecycleTrigger];

/** 转换所需的上下文。 */
export interface TransitionContext {
  /** 发起者玩家标识 */
  readonly actorPlayerId: string;
  /** 房主玩家标识 */
  readonly hostPlayerId: string;
  /** 当前玩家总数 */
  readonly playerCount: number;
  /** 最少开局人数 */
  readonly minPlayers: number;
  /** 除房主外的玩家是否全部已准备（空房间视为 true） */
  readonly allReady: boolean;
}

/** 转换结果。 */
export type PhaseResult =
  | { readonly ok: true; readonly phase: GamePhaseValue; readonly changed: boolean }
  | { readonly ok: false; readonly error: ProtocolError };

/**
 * 合法转换表：`阶段 → 该阶段允许的触发器`。
 *
 * 终态 `FINISHED` 不接受任何触发器。
 */
export const ALLOWED_TRANSITIONS: Readonly<Record<GamePhaseValue, readonly LifecycleTrigger[]>> = {
  WAITING: [LifecycleTrigger.PlayersChanged],
  READY: [LifecycleTrigger.PlayersChanged, LifecycleTrigger.Start],
  PLAYING: [LifecycleTrigger.Pause, LifecycleTrigger.End],
  PAUSED: [LifecycleTrigger.Resume, LifecycleTrigger.End],
  FINISHED: [],
};

/** 返回某阶段允许的触发器（供 UI 决定按钮可用性）。 */
export function allowedTriggers(phase: GamePhaseValue): readonly LifecycleTrigger[] {
  return ALLOWED_TRANSITIONS[phase] ?? [];
}

/** 是否为终态。 */
export function isTerminal(phase: GamePhaseValue): boolean {
  return phase === GamePhase.FINISHED;
}

/** 当前阶段是否允许接收游戏操作（对局进行中才允许）。 */
export function canAcceptGameActions(phase: GamePhaseValue): boolean {
  return phase === GamePhase.PLAYING;
}

/**
 * 计算 `PLAYERS_CHANGED` 后应处的阶段。
 *
 * 条件：人数达到下限且除房主外全部准备 → READY，否则 WAITING。
 */
export function evaluateReadyPhase(ctx: Pick<TransitionContext, 'playerCount' | 'minPlayers' | 'allReady'>): GamePhaseValue {
  return ctx.playerCount >= ctx.minPlayers && ctx.allReady ? GamePhase.READY : GamePhase.WAITING;
}

function fail(code: ErrorCode, message: string, details?: Record<string, unknown>): PhaseResult {
  return { ok: false, error: protocolError(code, message, details) };
}

function succeed(phase: GamePhaseValue, changed: boolean): PhaseResult {
  return { ok: true, phase, changed };
}

function requireHost(ctx: TransitionContext, action: string): ProtocolError | null {
  if (ctx.actorPlayerId !== ctx.hostPlayerId) {
    return protocolError(ErrorCode.NotHost, `仅房主可以${action}`, {
      actorPlayerId: ctx.actorPlayerId,
      hostPlayerId: ctx.hostPlayerId,
    });
  }
  return null;
}

/**
 * 纯函数状态转换。
 *
 * 校验优先级（错误码可预期）：
 * 1. 终态 → INVALID_TRANSITION
 * 2. 权限（房主）→ NOT_HOST
 * 3. 前置条件（人数 / 准备）→ NOT_ENOUGH_PLAYERS / PLAYERS_NOT_READY
 * 4. 阶段合法性（转换表）→ INVALID_TRANSITION
 */
export function transition(
  current: GamePhaseValue,
  trigger: LifecycleTrigger,
  ctx: TransitionContext,
): PhaseResult {
  if (isTerminal(current)) {
    return fail(ErrorCode.InvalidTransition, '对局已结束，不再接受任何操作', { current });
  }

  switch (trigger) {
    case LifecycleTrigger.PlayersChanged: {
      const next = evaluateReadyPhase(ctx);
      return succeed(next, next !== current);
    }

    case LifecycleTrigger.Start: {
      const hostError = requireHost(ctx, '开始游戏');
      if (hostError) {
        return { ok: false, error: hostError };
      }
      if (ctx.playerCount < ctx.minPlayers) {
        return fail(
          ErrorCode.NotEnoughPlayers,
          `人数不足，至少需要 ${ctx.minPlayers} 人（当前 ${ctx.playerCount} 人）`,
          { playerCount: ctx.playerCount, minPlayers: ctx.minPlayers },
        );
      }
      if (!ctx.allReady) {
        return fail(ErrorCode.PlayersNotReady, '仍有玩家未准备');
      }
      if (!allowedTriggers(current).includes(LifecycleTrigger.Start)) {
        return fail(ErrorCode.InvalidTransition, `当前阶段 ${current} 不能开始游戏`, { current });
      }
      return succeed(GamePhase.PLAYING, current !== GamePhase.PLAYING);
    }

    case LifecycleTrigger.Pause: {
      const hostError = requireHost(ctx, '暂停游戏');
      if (hostError) {
        return { ok: false, error: hostError };
      }
      if (!allowedTriggers(current).includes(LifecycleTrigger.Pause)) {
        return fail(ErrorCode.InvalidTransition, `仅 PLAYING 阶段可暂停，当前阶段 ${current}`, {
          current,
        });
      }
      return succeed(GamePhase.PAUSED, true);
    }

    case LifecycleTrigger.Resume: {
      const hostError = requireHost(ctx, '继续游戏');
      if (hostError) {
        return { ok: false, error: hostError };
      }
      if (!allowedTriggers(current).includes(LifecycleTrigger.Resume)) {
        return fail(ErrorCode.InvalidTransition, `仅 PAUSED 阶段可继续，当前阶段 ${current}`, {
          current,
        });
      }
      return succeed(GamePhase.PLAYING, true);
    }

    case LifecycleTrigger.End: {
      const hostError = requireHost(ctx, '结束游戏');
      if (hostError) {
        return { ok: false, error: hostError };
      }
      if (!allowedTriggers(current).includes(LifecycleTrigger.End)) {
        return fail(ErrorCode.InvalidTransition, `仅 PLAYING / PAUSED 阶段可结束，当前阶段 ${current}`, {
          current,
        });
      }
      return succeed(GamePhase.FINISHED, true);
    }

    default: {
      return fail(ErrorCode.UnknownMessageType, `未知触发器：${String(trigger)}`);
    }
  }
}
