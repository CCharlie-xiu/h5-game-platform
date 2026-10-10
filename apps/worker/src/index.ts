import { GameRoom } from './durable-objects/game-room';
import type { Env } from './env';
import { buildHealthPayload } from './health';

// Durable Object 类必须以命名导出暴露给 Workers 运行时
export { GameRoom };

const CORS_HEADERS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

function json(data: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(data), {
    ...init,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      ...CORS_HEADERS,
      ...(init.headers ?? {}),
    },
  });
}

/**
 * 阶段 1 仅暴露健康检查接口。
 *
 * 房间创建、玩家同步、WebSocket 通道均尚未实现。
 */
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    if (url.pathname === '/api/health') {
      if (request.method !== 'GET') {
        return json({ error: 'method_not_allowed' }, { status: 405 });
      }
      return json(buildHealthPayload(env.ENVIRONMENT ?? 'unknown'));
    }

    return json({ error: 'not_found', path: url.pathname }, { status: 404 });
  },
} satisfies ExportedHandler<Env>;
