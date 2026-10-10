/**
 * @h5/game-sdk —— 游戏插件开发接口
 *
 * 阶段 1 仅定义游戏插件的元信息契约，供 games/* 下的具体游戏实现。
 * 运行时能力（消息收发、状态同步、资源加载）在后续阶段补充。
 */

/** 游戏元信息。每个游戏必须通过 manifest 声明自身身份与人数约束。 */
export interface GameManifest {
  /** 全局唯一标识，建议使用 kebab-case，例如 `diffusion-master`。 */
  readonly id: string;
  /** 展示名称。 */
  readonly name: string;
  /** 游戏自身版本号，遵循 semver。 */
  readonly version: string;
  /** 最少开局人数。 */
  readonly minPlayers: number;
  /** 最多开局人数。 */
  readonly maxPlayers: number;
}

/**
 * 游戏插件。
 *
 * 阶段 1 仅要求提供 manifest；规则、场景、动画等能力
 * 将在后续阶段以可选字段的形式扩展。
 */
export interface GamePlugin {
  readonly manifest: GameManifest;
}
