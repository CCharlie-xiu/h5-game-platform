import type { Env } from '../env';

/**
 * 房间 Durable Object。
 *
 * **阶段 1 仅提供占位实现**：不维护房间状态、不广播消息、不做玩家同步。
 * 房间生命周期、玩家席位、消息路由将在后续阶段实现。
 */
export class GameRoom implements DurableObject {
  constructor(
    private readonly state: DurableObjectState,
    _env: Env,
  ) {}

  async fetch(_request: Request): Promise<Response> {
    return Response.json(
      {
        ok: true,
        implemented: false,
        roomId: this.state.id.toString(),
        note: '房间逻辑尚未实现',
      },
      { status: 501 },
    );
  }
}
