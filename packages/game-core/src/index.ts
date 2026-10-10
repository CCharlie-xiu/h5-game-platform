/**
 * @h5/game-core —— 游戏生命周期
 *
 * 阶段 1 仅定义生命周期阶段枚举与类型。
 * 状态机、计时器、回合计时等实现留待后续阶段。
 */

/** 房间 / 对局的通用生命周期阶段。 */
export const GamePhase = {
  /** 等待玩家加入 */
  Waiting: 'waiting',
  /** 人数满足，准备开始 */
  Ready: 'ready',
  /** 对局进行中 */
  Playing: 'playing',
  /** 结算中 */
  Settling: 'settling',
  /** 已结束 */
  Finished: 'finished',
} as const;

/** 生命周期阶段类型。 */
export type GamePhase = (typeof GamePhase)[keyof typeof GamePhase];
