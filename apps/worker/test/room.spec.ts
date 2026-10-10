import { ErrorCode } from '@h5/game-protocol';
import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

import {
  connectSocket,
  createRoom,
  fetchSnapshot,
  joinAsPlayer,
  nicknames,
  setupHost,
} from './harness';

/** 轮询等待 D1 记录出现（DO 通过 `waitUntil` 异步写入）。 */
async function waitForRow<T>(query: () => Promise<T | null>, timeoutMs = 5000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const row = await query();
    if (row) {
      return row;
    }
    if (Date.now() > deadline) {
      throw new Error('等待 D1 记录超时');
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

function database(): D1Database {
  return (env as unknown as { DB: D1Database }).DB;
}

describe('房间集成：创建与加入', () => {
  it('创建房间返回 6 位房间码与房主身份', async () => {
    const created = await createRoom('房主');
    expect(created.roomCode).toMatch(/^[23456789ABCDEFGHJKMNPQRSTUVWXYZ]{6}$/);
    expect(created.playerId).toMatch(/^p_/);
    expect(created.token).toHaveLength(64);
    expect(created.room.phase).toBe('WAITING');
    expect(created.room.players).toHaveLength(1);
  });

  it('房主连接后收到 SESSION_GRANTED，房间码可由快照接口读取', async () => {
    const { created, granted } = await setupHost();
    expect(granted.payload.roomCode).toBe(created.roomCode);

    const snapshot = await fetchSnapshot(created.roomCode);
    expect(snapshot.status).toBe(200);
    const body = snapshot.body as { room: { roomCode: string; players: unknown[] } };
    expect(body.room.roomCode).toBe(created.roomCode);
    expect(body.room.players).toHaveLength(1);
  });

  it('不存在的房间返回 404', async () => {
    const snapshot = await fetchSnapshot('ZZZZZZ');
    expect(snapshot.status).toBe(404);
  });
});

describe('房间集成：双客户端状态同步', () => {
  it('两个客户端看到相同的玩家列表', async () => {
    const { created, socket: host } = await setupHost('房主');
    const { socket: guest } = await joinAsPlayer(created.roomCode, '玩家B');

    const hostRoom = await host.waitForState((room) => (room.players as unknown[]).length === 2);
    const guestRoom = await guest.waitForState((room) => (room.players as unknown[]).length === 2);

    expect(nicknames(hostRoom)).toEqual(['房主', '玩家B']);
    expect(nicknames(guestRoom)).toEqual(['房主', '玩家B']);
    expect(hostRoom.revision).toBe(guestRoom.revision);

    host.close();
    guest.close();
  });

  it('玩家准备后房主能看到变化', async () => {
    const { created, socket: host } = await setupHost('房主');
    const { socket: guest } = await joinAsPlayer(created.roomCode, '玩家B');

    await host.waitForState((room) => (room.players as unknown[]).length === 2);
    guest.send('PLAYER_READY', {});

    const room = await host.waitForState(
      (state) => (state.players as Array<{ ready: boolean }>).some((player) => player.ready),
    );
    expect(room.phase).toBe('READY');

    host.close();
    guest.close();
  });

  it('未准备时不能开始；全员准备后房主可以开始', async () => {
    const { created, socket: host } = await setupHost('房主');
    const { socket: guest } = await joinAsPlayer(created.roomCode, '玩家B');
    await host.waitForState((room) => (room.players as unknown[]).length === 2);

    host.send('GAME_START', {});
    const error = await host.waitFor('SYSTEM_ERROR');
    expect(error.payload.code).toBe(ErrorCode.PlayersNotReady);

    guest.send('PLAYER_READY', {});
    await host.waitForState((room) => room.phase === 'READY');

    host.send('GAME_START', {});
    const playing = await host.waitForState((room) => room.phase === 'PLAYING');
    expect(playing.sessionId).toBeTruthy();

    host.close();
    guest.close();
  });

  it('人数不足时拒绝开始', async () => {
    const { socket: host } = await setupHost('房主');
    host.send('GAME_START', {});
    const error = await host.waitFor('SYSTEM_ERROR');
    expect(error.payload.code).toBe(ErrorCode.NotEnoughPlayers);
    host.close();
  });

  it('非房主发起开始被拒绝', async () => {
    const { created, socket: host } = await setupHost('房主');
    const { socket: guest } = await joinAsPlayer(created.roomCode, '玩家B');
    await host.waitForState((room) => (room.players as unknown[]).length === 2);

    guest.send('GAME_START', {});
    const error = await guest.waitFor('SYSTEM_ERROR');
    expect(error.payload.code).toBe(ErrorCode.NotHost);

    host.close();
    guest.close();
  });

  it('暂停 / 继续 / 结束在双方保持一致', async () => {
    const { created, socket: host } = await setupHost('房主');
    const { socket: guest } = await joinAsPlayer(created.roomCode, '玩家B');
    await host.waitForState((room) => (room.players as unknown[]).length === 2);

    guest.send('PLAYER_READY', {});
    await host.waitForState((room) => room.phase === 'READY');
    host.send('GAME_START', {});
    await host.waitForState((room) => room.phase === 'PLAYING');
    await guest.waitForState((room) => room.phase === 'PLAYING');

    host.send('GAME_PAUSE', {});
    expect((await host.waitForState((room) => room.phase === 'PAUSED')).phase).toBe('PAUSED');
    expect((await guest.waitForState((room) => room.phase === 'PAUSED')).phase).toBe('PAUSED');

    host.send('GAME_RESUME', {});
    expect((await host.waitForState((room) => room.phase === 'PLAYING')).phase).toBe('PLAYING');
    expect((await guest.waitForState((room) => room.phase === 'PLAYING')).phase).toBe('PLAYING');

    host.send('GAME_END', {});
    expect((await host.waitForState((room) => room.phase === 'FINISHED')).phase).toBe('FINISHED');
    expect((await guest.waitForState((room) => room.phase === 'FINISHED')).phase).toBe('FINISHED');

    host.close();
    guest.close();
  });
});

describe('房间集成：非法输入与重复请求', () => {
  it('非 JSON 文本返回 INVALID_MESSAGE', async () => {
    const { socket } = await setupHost();
    socket.sendRaw('not-json');
    const error = await socket.waitFor('SYSTEM_ERROR');
    expect(error.payload.code).toBe(ErrorCode.InvalidMessage);
    socket.close();
  });

  it('未知消息类型返回 UNKNOWN_MESSAGE_TYPE', async () => {
    const { socket } = await setupHost();
    socket.send('NOT_A_REAL_TYPE', {});
    const error = await socket.waitFor('SYSTEM_ERROR');
    expect(error.payload.code).toBe(ErrorCode.UnknownMessageType);
    socket.close();
  });

  it('协议版本不匹配返回 PROTOCOL_VERSION_MISMATCH', async () => {
    const { socket } = await setupHost();
    socket.sendRaw(
      JSON.stringify({ protocolVersion: 99, messageId: 'm-1', type: 'PLAYER_READY', payload: {} }),
    );
    const error = await socket.waitFor('SYSTEM_ERROR');
    expect(error.payload.code).toBe(ErrorCode.ProtocolVersionMismatch);
    socket.close();
  });

  it('负载不合法返回 INVALID_MESSAGE', async () => {
    const { socket } = await setupHost();
    socket.send('PLAYER_READY', { unexpected: true });
    const error = await socket.waitFor('SYSTEM_ERROR');
    expect(error.payload.code).toBe(ErrorCode.InvalidMessage);
    socket.close();
  });

  it('未加入房间就操作返回 NOT_IN_ROOM', async () => {
    const created = await createRoom('房主');
    const socket = await connectSocket(created.roomCode);
    socket.send('GAME_START', {});
    const error = await socket.waitFor('SYSTEM_ERROR');
    expect(error.payload.code).toBe(ErrorCode.NotInRoom);
    socket.close();
  });

  it('重复 messageId 被拒绝', async () => {
    const { socket } = await setupHost();
    const messageId = 'fixed-message-id';
    socket.send('PLAYER_READY', {}, messageId);
    await socket.waitFor('SYSTEM_ERROR');

    socket.send('PLAYER_READY', {}, messageId);
    const duplicate = await socket.waitFor('SYSTEM_ERROR');
    expect(duplicate.payload.code).toBe(ErrorCode.DuplicateMessage);
    socket.close();
  });

  it('重复准备同一状态返回 DUPLICATE_MESSAGE', async () => {
    const { created, socket: host } = await setupHost('房主');
    const { socket: guest } = await joinAsPlayer(created.roomCode, '玩家B');
    await host.waitForState((room) => (room.players as unknown[]).length === 2);

    guest.send('PLAYER_READY', {});
    await host.waitForState((room) => room.phase === 'READY');
    guest.send('PLAYER_READY', {});
    const error = await guest.waitFor('SYSTEM_ERROR');
    expect(error.payload.code).toBe(ErrorCode.DuplicateMessage);

    host.close();
    guest.close();
  });
});

describe('房间集成：断线与重连', () => {
  it('断开后座位保留并标记离线，重连后恢复', async () => {
    const { created, socket: host } = await setupHost('房主');
    const { socket: guest, granted } = await joinAsPlayer(created.roomCode, '玩家B');
    await host.waitForState((room) => (room.players as unknown[]).length === 2);

    guest.close();

    const offline = await host.waitForState((room) =>
      (room.players as Array<{ online: boolean }>).some((player) => !player.online),
    );
    expect((offline.players as unknown[]).length).toBe(2);

    // 使用服务端签发的身份令牌重连
    const reconnected = await connectSocket(created.roomCode);
    reconnected.send('JOIN_ROOM', {
      roomCode: created.roomCode,
      nickname: '玩家B',
      playerId: granted.payload.playerId,
      token: granted.payload.token,
    });
    const regranted = await reconnected.waitFor('SESSION_GRANTED');
    expect(regranted.payload.playerId).toBe(granted.payload.playerId);

    const online = await host.waitForState((room) =>
      (room.players as Array<{ online: boolean }>).every((player) => player.online),
    );
    expect((online.players as unknown[]).length).toBe(2);

    host.close();
    reconnected.close();
  });

  it('伪造令牌无法恢复座位', async () => {
    const { created, socket: host } = await setupHost('房主');
    await host.waitForState((room) => room.phase === 'WAITING');

    const socket = await connectSocket(created.roomCode);
    socket.send('JOIN_ROOM', {
      roomCode: created.roomCode,
      nickname: '冒充者',
      playerId: 'p_forged',
      token: 'f'.repeat(64),
    });
    const error = await socket.waitFor('SYSTEM_ERROR');
    expect(error.payload.code).toBe(ErrorCode.Unauthorized);

    host.close();
    socket.close();
  });
});

describe('房间集成：持久化', () => {
  it('房间状态在后续请求中可读取（Durable Object storage 持久化）', async () => {
    const { created, socket: host } = await setupHost('房主');
    const { socket: guest } = await joinAsPlayer(created.roomCode, '玩家B');
    await host.waitForState((room) => (room.players as unknown[]).length === 2);

    guest.send('PLAYER_READY', {});
    await host.waitForState((room) => room.phase === 'READY');

    const snapshot = await fetchSnapshot(created.roomCode);
    const body = snapshot.body as {
      room: { phase: string; revision: number; players: Array<{ ready: boolean }> };
    };
    expect(body.room.phase).toBe('READY');
    expect(body.room.revision).toBeGreaterThan(1);
    expect(body.room.players.some((player) => player.ready)).toBe(true);

    host.close();
    guest.close();
  });
});

describe('房间集成：D1 持久化记录', () => {
  it('房间元数据与玩家参与记录写入 D1', async () => {
    const { created, socket: host } = await setupHost('房主');
    const { socket: guest } = await joinAsPlayer(created.roomCode, '玩家B');
    await host.waitForState((room) => (room.players as unknown[]).length === 2);

    const roomRow = await waitForRow(() =>
      database()
        .prepare('select id, game_id, status, player_count from rooms where id = ?')
        .bind(created.roomCode)
        .first<{ id: string; game_id: string; status: string; player_count: number }>(),
    );
    expect(roomRow.id).toBe(created.roomCode);
    expect(roomRow.game_id).toBe('diffusion-master');
    expect(roomRow.status).toBe('WAITING');

    const playerRow = await waitForRow(() =>
      database()
        .prepare('select count(*) as total from room_players where room_id = ?')
        .bind(created.roomCode)
        .first<{ total: number }>(),
    );
    expect(playerRow.total).toBe(2);

    host.close();
    guest.close();
  });

  it('对局开始与结束写入 game_sessions', async () => {
    const { created, socket: host } = await setupHost('房主');
    const { socket: guest } = await joinAsPlayer(created.roomCode, '玩家B');
    await host.waitForState((room) => (room.players as unknown[]).length === 2);

    guest.send('PLAYER_READY', {});
    const ready = await host.waitForState((room) => room.phase === 'READY');
    expect(ready.sessionId).toBeNull();

    host.send('GAME_START', {});
    const playing = await host.waitForState((room) => room.phase === 'PLAYING');
    const sessionId = String(playing.sessionId);

    const started = await waitForRow(() =>
      database()
        .prepare('select id, room_id, started_at, ended_at from game_sessions where id = ?')
        .bind(sessionId)
        .first<{ id: string; room_id: string; started_at: number; ended_at: number | null }>(),
    );
    expect(started.room_id).toBe(created.roomCode);
    expect(started.ended_at).toBeNull();

    host.send('GAME_END', {});
    await host.waitForState((room) => room.phase === 'FINISHED');

    const ended = await waitForRow(() =>
      database()
        .prepare('select ended_at from game_sessions where id = ?')
        .bind(sessionId)
        .first<{ ended_at: number | null }>(),
    );
    expect(ended.ended_at).not.toBeNull();

    const roomRow = await waitForRow(() =>
      database()
        .prepare('select status from rooms where id = ?')
        .bind(created.roomCode)
        .first<{ status: string }>(),
    );
    expect(roomRow.status).toBe('FINISHED');

    host.close();
    guest.close();
  });
});
