/** Worker 运行时绑定（与 wrangler.toml 中的 binding 名称一一对应）。 */
export interface Env {
  /** D1 数据库绑定。 */
  readonly DB: D1Database;
  /** 房间 Durable Object 命名空间。 */
  readonly GAME_ROOM: DurableObjectNamespace;
  /** 运行环境标识，来自 `[vars]`。 */
  readonly ENVIRONMENT: string;
}
