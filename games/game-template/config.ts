/**
 * 游戏默认配置。
 *
 * 后续阶段可由房间创建时的自定义配置覆盖（覆写逻辑尚未实现）。
 */
export interface GameConfig {
  /** 单回合时长上限（毫秒）。 */
  readonly turnTimeoutMs: number;
}

/** 模板默认配置。 */
export const defaultConfig: GameConfig = {
  turnTimeoutMs: 30_000,
};
