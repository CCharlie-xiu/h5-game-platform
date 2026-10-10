import { generateRandomBytes, generateRoomCode, isValidRoomCode } from '@h5/game-core';
import { ErrorCode, createRoomPayloadSchema } from '@h5/game-protocol';

import { GameRoom } from './durable-objects/game-room';
import type { Env } from './env';
import { buildHealthPayload } from './health';

// Durable Object 类必须以命名导出暴露给 Workers 运行时
export { GameRoom };

/** 房间码冲突时的最大重试次数。 */
const ROOM_CODE_ATTEMPTS = 5;

/** 默认游戏标识（当前平台只有扩散大师一个游戏）。 */
const DEFAULT_GAME_ID = 'diffusion-master';

const CORS_HEADERS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      ...CORS_HEADERS,
    },
  });
}

function fail(code: string, message: string, status: number): Response {
  return json({ error: code, message }, status);
}

/**
 * 创建房间。
 *
 * 房间码由服务端生成，通过 Durable Object 的原子创建保证不冲突：
 * DO 已存在则返回 409，这里换码重试。
 *
 * 入参复用 `@h5/game-protocol` 的共享 Zod Schema（与 WebSocket `CREATE_ROOM` 同一套规则），
 * 非法输入在服务端入口即被拒绝，不会产生服务端自己都无法解析的房间快照。
 */
async function createRoom(request: Request, env: Env): Promise<Response> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return fail(ErrorCode.InvalidMessage, '请求体不是合法 JSON', 400);
  }

  const input = (body ?? {}) as Record<string, unknown>;
  const parsed = createRoomPayloadSchema.safeParse({
    gameId: input.gameId ?? DEFAULT_GAME_ID,
    nickname: input.nickname,
    ...(input.maxPlayers === undefined ? {} : { maxPlayers: input.maxPlayers }),
  });

  if (!parsed.success) {
    return json(
      {
        error: ErrorCode.InvalidMessage,
        message: '创建房间参数不合法',
        details: parsed.error.issues.map((issue) => ({
          path: issue.path.join('.'),
          message: issue.message,
        })),
      },
      400,
    );
  }

  const { gameId, nickname, maxPlayers } = parsed.data;

  for (let attempt = 0; attempt < ROOM_CODE_ATTEMPTS; attempt += 1) {
    const roomCode = generateRoomCode(generateRandomBytes(8));
    const stub = env.GAME_ROOM.get(env.GAME_ROOM.idFromName(roomCode));
    const response = await stub.fetch('https://room.internal/create', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ gameId, nickname, maxPlayers }),
    });

    if (response.status === 409) {
      continue;
    }
    if (!response.ok) {
      return fail(ErrorCode.InternalError, '创建房间失败', 500);
    }
    return json(await response.json(), 201);
  }

  return fail(ErrorCode.InternalError, '房间码分配失败，请重试', 503);
}

/** 阶段 2 路由表。 */
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    // 健康检查
    if (url.pathname === '/api/health') {
      if (request.method !== 'GET') {
        return fail(ErrorCode.InvalidMessage, '仅支持 GET', 405);
      }
      return json(buildHealthPayload(env.ENVIRONMENT ?? 'unknown'));
    }

    // 创建房间
    if (url.pathname === '/api/rooms') {
      if (request.method !== 'POST') {
        return fail(ErrorCode.InvalidMessage, '仅支持 POST', 405);
      }
      return createRoom(request, env);
    }

    // 房间相关：/api/rooms/:code 与 /api/rooms/:code/ws
    const match = /^\/api\/rooms\/([A-Z0-9]+)(\/ws)?$/.exec(url.pathname);
    if (match) {
      const roomCode = match[1] ?? '';
      const isSocket = Boolean(match[2]);
      if (!isValidRoomCode(roomCode)) {
        return fail(ErrorCode.RoomNotFound, '房间码格式不合法', 400);
      }

      const stub = env.GAME_ROOM.get(env.GAME_ROOM.idFromName(roomCode));

      if (isSocket) {
        if (request.headers.get('Upgrade') !== 'websocket') {
          return fail(ErrorCode.InvalidMessage, '该端点需要 WebSocket 升级', 426);
        }
        return stub.fetch(request);
      }

      if (request.method !== 'GET') {
        return fail(ErrorCode.InvalidMessage, '仅支持 GET', 405);
      }
      return stub.fetch('https://room.internal/snapshot');
    }

    return fail('NOT_FOUND', `未找到路由：${url.pathname}`, 404);
  },
} satisfies ExportedHandler<Env>;
