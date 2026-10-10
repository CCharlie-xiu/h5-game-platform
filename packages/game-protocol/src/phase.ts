import { z } from 'zod';

/**
 * 房间 / 对局生命周期阶段（协议层权威定义）。
 *
 * `@h5/game-core` 在此基础上实现状态转换规则。
 */
export const gamePhaseSchema = z.enum(['WAITING', 'READY', 'PLAYING', 'PAUSED', 'FINISHED']);

/** 生命周期阶段字面量联合。 */
export type GamePhase = z.infer<typeof gamePhaseSchema>;

/** 生命周期阶段常量（供业务代码使用）。 */
export const GamePhase = gamePhaseSchema.enum;

/** 玩家离开原因。 */
export const leaveReasonSchema = z.enum(['LEFT', 'DISCONNECTED', 'KICKED']);

/** 玩家离开原因类型。 */
export type LeaveReason = z.infer<typeof leaveReasonSchema>;
