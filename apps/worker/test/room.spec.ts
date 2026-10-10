import { ROOM_CLEANUP } from '@h5/game-core';
import {
  ErrorCode,
  createClientMessage,
  createMessageId,
  serializeMessage,
} from '@h5/game-protocol';
import {
  env,
  evictDurableObject,
  runDurableObjectAlarm,
  runInDurableObject,
} from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

import {
  connectSocket,
  createRoom,
  fetchSnapshot,
  joinAsPlayer,
  nicknames,
  postCreateRoom,
  revisionOf,
  roomStub,
  setupHost,
  waitForRoomGone,
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

/* -------------------------------------------------------------------------- */
/* P2-1：创建房间参数校验                                                       */
/* -------------------------------------------------------------------------- */

describe('房间集成：P2-1 创建房间参数校验', () => {
  it('合法参数返回 201 与房间码', async () => {
    const result = await postCreateRoom({
      gameId: 'diffusion-master',
      nickname: '房主',
      maxPlayers: 4,
    });
    expect(result.status).toBe(201);
    const body = result.body as { roomCode: string; room: { maxPlayers: number } };
    expect(body.roomCode).toMatch(/^[23456789ABCDEFGHJKMNPQRSTUVWXYZ]{6}$/);
    expect(body.room.maxPlayers).toBe(4);
  });

  it('小数 maxPlayers 被入口拒绝', async () => {
    expect((await postCreateRoom({ nickname: '房主', maxPlayers: 3.5 })).status).toBe(400);
  });

  it('越界 maxPlayers 被入口拒绝', async () => {
    expect((await postCreateRoom({ nickname: '房主', maxPlayers: 1 })).status).toBe(400);
    expect((await postCreateRoom({ nickname: '房主', maxPlayers: 99 })).status).toBe(400);
    expect((await postCreateRoom({ nickname: '房主', maxPlayers: -2 })).status).toBe(400);
  });

  it('类型错误的 maxPlayers 被入口拒绝', async () => {
    expect((await postCreateRoom({ nickname: '房主', maxPlayers: 'many' })).status).toBe(400);
    expect((await postCreateRoom({ nickname: '房主', maxPlayers: null })).status).toBe(400);
  });

  it('超长 gameId 被入口拒绝', async () => {
    expect((await postCreateRoom({ gameId: 'g'.repeat(65), nickname: '房主' })).status).toBe(400);
  });

  it('非法昵称被入口拒绝', async () => {
    expect((await postCreateRoom({ nickname: '' })).status).toBe(400);
    expect((await postCreateRoom({ nickname: 'x'.repeat(25) })).status).toBe(400);
    expect((await postCreateRoom({ nickname: 123 })).status).toBe(400);
    expect((await postCreateRoom({})).status).toBe(400);
  });

  it('非法请求体被入口拒绝', async () => {
    expect((await postCreateRoom('not-json')).status).toBe(400);
  });

  it('被拒绝的请求不影响后续合法创建', async () => {
    expect((await postCreateRoom({ nickname: '房主', maxPlayers: 3.5 })).status).toBe(400);
    expect((await postCreateRoom({ nickname: '房主' })).status).toBe(201);
  });
});

/* -------------------------------------------------------------------------- */
/* P2-2：空房间与房主身份                                                       */
/* -------------------------------------------------------------------------- */

describe('房间集成：P2-2 空房间与房主身份', () => {
  it('最后一名玩家离开后房间立即销毁', async () => {
    const { created, socket } = await setupHost('房主');
    socket.send('LEAVE_ROOM', {});
    await waitForRoomGone(created.roomCode);

    const snapshot = await fetchSnapshot(created.roomCode);
    expect(snapshot.status).toBe(404);
  });

  it('房间销毁后再次加入返回 ROOM_NOT_FOUND', async () => {
    const { created, socket } = await setupHost('房主');
    socket.send('LEAVE_ROOM', {});
    await waitForRoomGone(created.roomCode);

    const rejoining = await connectSocket(created.roomCode);
    rejoining.send('JOIN_ROOM', { roomCode: created.roomCode, nickname: '新玩家' });
    const error = await rejoining.waitFor('SYSTEM_ERROR');
    expect(error.payload.code).toBe(ErrorCode.RoomNotFound);

    rejoining.close();
  });

  it('房主离开后由剩余玩家接管，并可正常开局', async () => {
    const { created, socket: host } = await setupHost('房主');
    const { socket: playerB } = await joinAsPlayer(created.roomCode, '玩家B');
    const { socket: playerC } = await joinAsPlayer(created.roomCode, '玩家C');
    await playerB.waitForState((room) => (room.players as unknown[]).length === 3);

    host.send('LEAVE_ROOM', {});
    const afterLeave = await playerB.waitForState(
      (room) => (room.players as unknown[]).length === 2,
    );

    const players = afterLeave.players as Array<{ nickname: string; isHost: boolean }>;
    expect(players.filter((player) => player.isHost)).toHaveLength(1);
    expect(players.find((player) => player.isHost)?.nickname).toBe('玩家B');

    playerC.send('PLAYER_READY', {});
    await playerB.waitForState((room) => room.phase === 'READY');

    playerB.send('GAME_START', {});
    const playing = await playerB.waitForState((room) => room.phase === 'PLAYING');
    expect(playing.sessionId).toBeTruthy();

    playerB.close();
    playerC.close();
  });
});

/* -------------------------------------------------------------------------- */
/* P2-5：封套 roomId / sessionId 与房间码校验                                    */
/* -------------------------------------------------------------------------- */

describe('房间集成：P2-5 房间 / 对局 ID 校验', () => {
  it('roomId 与当前房间一致时操作正常生效', async () => {
    const { created, socket: host } = await setupHost('房主');
    const { socket: guest } = await joinAsPlayer(created.roomCode, '玩家B');
    await guest.waitForState((room) => (room.players as unknown[]).length === 2);

    guest.send('PLAYER_READY', {}, createMessageId(), { roomId: created.roomCode });
    const room = await host.waitForState((state) => state.phase === 'READY');
    expect(room.phase).toBe('READY');

    host.close();
    guest.close();
  });

  it('roomId 与当前房间不一致时被拒绝且状态不变', async () => {
    const { created, socket: host } = await setupHost('房主');
    const { socket: guest } = await joinAsPlayer(created.roomCode, '玩家B');
    await guest.waitForState((room) => (room.players as unknown[]).length === 2);
    const before = await revisionOf(created.roomCode);

    guest.send('PLAYER_READY', {}, createMessageId(), { roomId: 'ZZZ999' });
    const error = await guest.waitFor('SYSTEM_ERROR');
    expect(error.payload.code).toBe(ErrorCode.RoomNotFound);
    expect(await revisionOf(created.roomCode)).toBe(before);

    host.close();
    guest.close();
  });

  it('房间没有进行中的对局时携带 sessionId 被拒绝且状态不变', async () => {
    const { created, socket: host } = await setupHost('房主');
    const { socket: guest } = await joinAsPlayer(created.roomCode, '玩家B');
    await guest.waitForState((room) => (room.players as unknown[]).length === 2);
    const before = await revisionOf(created.roomCode);

    guest.send('PLAYER_READY', {}, createMessageId(), { sessionId: 's_stale' });
    const error = await guest.waitFor('SYSTEM_ERROR');
    expect(error.payload.code).toBe(ErrorCode.SessionMismatch);
    expect(await revisionOf(created.roomCode)).toBe(before);

    host.close();
    guest.close();
  });

  it('sessionId 与当前对局不一致时被拒绝，一致时生效', async () => {
    const { created, socket: host } = await setupHost('房主');
    const { socket: guest } = await joinAsPlayer(created.roomCode, '玩家B');
    await host.waitForState((room) => (room.players as unknown[]).length === 2);

    guest.send('PLAYER_READY', {});
    await host.waitForState((room) => room.phase === 'READY');
    host.send('GAME_START', {});
    const playing = await host.waitForState((room) => room.phase === 'PLAYING');
    const sessionId = String(playing.sessionId);
    const before = await revisionOf(created.roomCode);

    host.send('GAME_PAUSE', {}, createMessageId(), { sessionId: 's_stale' });
    const error = await host.waitFor('SYSTEM_ERROR');
    expect(error.payload.code).toBe(ErrorCode.SessionMismatch);
    expect(await revisionOf(created.roomCode)).toBe(before);

    host.send('GAME_PAUSE', {}, createMessageId(), { sessionId });
    const paused = await host.waitForState((room) => room.phase === 'PAUSED');
    expect(paused.phase).toBe('PAUSED');

    host.close();
    guest.close();
  });

  it('JOIN_ROOM 的房间码与当前房间不一致时被拒绝，且不会占用座位', async () => {
    const { created, socket: host } = await setupHost('房主');
    await host.waitForState((room) => room.phase === 'WAITING');
    const before = await revisionOf(created.roomCode);

    const impostor = await connectSocket(created.roomCode);
    impostor.send('JOIN_ROOM', { roomCode: 'ZZZ999', nickname: '冒充者' });
    const error = await impostor.waitFor('SYSTEM_ERROR');
    expect(error.payload.code).toBe(ErrorCode.RoomNotFound);

    const snapshot = await fetchSnapshot(created.roomCode);
    const body = snapshot.body as { room: { revision: number; players: unknown[] } };
    expect(body.room.players).toHaveLength(1);
    expect(body.room.revision).toBe(before);

    host.close();
    impostor.close();
  });
});

/* -------------------------------------------------------------------------- */
/* P2-7：被替换的旧连接不得操作房间                                              */
/* -------------------------------------------------------------------------- */

describe('房间集成：P2-7 被替换的旧连接不得操作房间', () => {
  it('重连后新连接可正常操作，旧连接被服务端关闭', async () => {
    const { created, socket: host } = await setupHost('房主');
    const { socket: oldSocket, granted } = await joinAsPlayer(created.roomCode, '玩家B');
    await host.waitForState((room) => (room.players as unknown[]).length === 2);

    const newSocket = await connectSocket(created.roomCode);
    newSocket.send('JOIN_ROOM', {
      roomCode: created.roomCode,
      nickname: '玩家B',
      playerId: granted.payload.playerId,
      token: granted.payload.token,
    });
    await newSocket.waitFor('SESSION_GRANTED');
    await oldSocket.waitForClose();

    newSocket.send('PLAYER_READY', {});
    const room = await host.waitForState(
      (state) => (state.players as Array<{ ready: boolean }>).some((player) => player.ready),
    );
    expect(room.phase).toBe('READY');

    host.close();
    newSocket.close();
  });

  it('旧连接（attachment 与服务端绑定不一致）的操作被拒绝且状态不变', async () => {
    const { created, socket: host } = await setupHost('房主');
    const { socket: guest, granted } = await joinAsPlayer(created.roomCode, '玩家B');
    await host.waitForState((room) => (room.players as unknown[]).length === 2);
    const before = await revisionOf(created.roomCode);

    const readyRaw = serializeMessage(
      createClientMessage('PLAYER_READY', {}, { roomId: created.roomCode }),
    );

    await runInDurableObject(roomStub(created.roomCode), async (instance, state) => {
      const target = state
        .getWebSockets()
        .find(
          (socket) =>
            (socket.deserializeAttachment() as { playerId?: string | null } | null)?.playerId ===
            granted.payload.playerId,
        );
      expect(target).toBeDefined();
      if (!target) {
        return;
      }

      // 构造「连接已被替换」的等价状态：attachment 的 connectionId 与服务端绑定不再一致
      const attachment = target.deserializeAttachment() as {
        connectionId: string;
        playerId: string | null;
        connectedAt: number;
      };
      target.serializeAttachment({
        ...attachment,
        connectionId: `stale_${attachment.connectionId}`,
      });

      const room = instance as unknown as {
        webSocketMessage(ws: WebSocket, message: string): Promise<void>;
      };
      await room.webSocketMessage(target, readyRaw);
    });

    const error = await guest.waitFor('SYSTEM_ERROR');
    expect(error.payload.code).toBe(ErrorCode.Unauthorized);
    expect(await revisionOf(created.roomCode)).toBe(before);

    host.close();
    guest.close();
  });
});

/* -------------------------------------------------------------------------- */
/* P1-1：重连期间不得用过期状态覆盖并发变更                                       */
/* -------------------------------------------------------------------------- */

describe('房间集成：P1-1 重连期间的状态竞争', () => {
  it('令牌校验期间的并发合法状态变更不会丢失', async () => {
    const { created, socket: host } = await setupHost('房主');
    const { socket: guestB, granted: grantedB } = await joinAsPlayer(created.roomCode, '玩家B');
    const { socket: guestC, granted: grantedC } = await joinAsPlayer(created.roomCode, '玩家C');
    await host.waitForState((room) => (room.players as unknown[]).length === 3);

    // B 先准备，再掉线（座位与准备状态保留），以便走重连分支
    guestB.send('PLAYER_READY', {});
    await host.waitForState((room) =>
      (room.players as Array<{ playerId: string; ready: boolean }>).some(
        (player) => player.playerId === grantedB.payload.playerId && player.ready,
      ),
    );
    guestB.close();
    await host.waitForState((room) =>
      (room.players as Array<{ playerId: string; online: boolean }>).some(
        (player) => player.playerId === grantedB.payload.playerId && !player.online,
      ),
    );

    const reconnecting = await connectSocket(created.roomCode);

    const joinRaw = serializeMessage(
      createClientMessage('JOIN_ROOM', {
        roomCode: created.roomCode,
        nickname: '玩家B',
        playerId: grantedB.payload.playerId,
        token: grantedB.payload.token,
      }),
    );
    const readyRaw = serializeMessage(
      createClientMessage('PLAYER_READY', {}, { roomId: created.roomCode }),
    );

    await runInDurableObject(roomStub(created.roomCode), async (instance, state) => {
      const attachmentOf = (socket: WebSocket) =>
        socket.deserializeAttachment() as { playerId: string | null } | null;

      const sockets = state.getWebSockets();
      const reconnectSocket = sockets.find(
        (socket) => attachmentOf(socket)?.playerId === null,
      );
      const playerCSocket = sockets.find(
        (socket) => attachmentOf(socket)?.playerId === grantedC.payload.playerId,
      );
      expect(reconnectSocket).toBeDefined();
      expect(playerCSocket).toBeDefined();
      if (!reconnectSocket || !playerCSocket) {
        return;
      }

      const room = instance as unknown as {
        webSocketMessage(ws: WebSocket, message: string): Promise<void>;
      };

      // 刻意并发、且不 await 第一个：让重连在令牌校验处让出事件循环时，
      // C 的准备操作被处理，从而构造出确定的交错时序（不依赖真实计时/睡眠）。
      const reconnect = room.webSocketMessage(reconnectSocket, joinRaw);
      const ready = room.webSocketMessage(playerCSocket, readyRaw);
      await Promise.all([reconnect, ready]);
    });

    const finalRoom = await host.waitForState((room) =>
      (room.players as Array<{ playerId: string; online: boolean }>).some(
        (player) => player.playerId === grantedB.payload.playerId && player.online,
      ),
    );

    const players = finalRoom.players as Array<{
      playerId: string;
      online: boolean;
      ready: boolean;
    }>;

    // 重连成功，且并发写入的 C.ready 没有被重连的过期快照覆盖
    expect(players.find((p) => p.playerId === grantedB.payload.playerId)?.online).toBe(true);
    expect(players.find((p) => p.playerId === grantedB.payload.playerId)?.ready).toBe(true);
    expect(players.find((p) => p.playerId === grantedC.payload.playerId)?.ready).toBe(true);
    expect(finalRoom.phase).toBe('READY');

    host.close();
    reconnecting.close();
    guestC.close();
  });
});

/* -------------------------------------------------------------------------- */
/* P1-2：清理策略                                                              */
/* -------------------------------------------------------------------------- */

/** 把房间的 `lastActivityAt` 回拨，模拟长时间无状态变更（不真实等待）。 */
async function backdateActivity(roomCode: string, idleMs: number): Promise<void> {
  await runInDurableObject(roomStub(roomCode), async (_instance, state) => {
    const room = (await state.storage.get('room')) as Record<string, unknown> | undefined;
    if (!room) {
      throw new Error('房间不存在，无法回拨活动时间');
    }
    await state.storage.put('room', { ...room, lastActivityAt: Date.now() - idleMs });
  });
}

/** 轮询直到房间内所有玩家都离线。 */
async function waitForAllOffline(roomCode: string, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const snapshot = await fetchSnapshot(roomCode);
    if (snapshot.status === 404) {
      return;
    }
    const body = snapshot.body as { room: { players: Array<{ online: boolean }> } };
    if (body.room.players.every((player) => !player.online)) {
      return;
    }
    if (Date.now() > deadline) {
      throw new Error('等待玩家离线超时');
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

describe('房间集成：P1-2 清理策略', () => {
  it('有在线玩家时，长时间无状态变更也不会销毁房间', async () => {
    const { created, socket: host } = await setupHost('房主');
    await host.waitForState((room) =>
      (room.players as Array<{ online: boolean }>).some((player) => player.online),
    );
    const before = await revisionOf(created.roomCode);

    await backdateActivity(created.roomCode, 6 * 60 * 60 * 1000);
    await evictDurableObject(roomStub(created.roomCode));
    expect(await runDurableObjectAlarm(roomStub(created.roomCode))).toBe(true);

    const snapshot = await fetchSnapshot(created.roomCode);
    expect(snapshot.status).toBe(200);
    const body = snapshot.body as {
      room: { revision: number; players: Array<{ online: boolean }> };
    };
    expect(body.room.revision).toBe(before);
    expect(body.room.players.some((player) => player.online)).toBe(true);

    host.close();
  });

  it('无在线玩家且超过重连宽限期后房间被销毁', async () => {
    const { created, socket: host } = await setupHost('房主');
    host.close();
    await waitForAllOffline(created.roomCode);

    await backdateActivity(created.roomCode, ROOM_CLEANUP.reconnectGraceMs + 1000);
    await evictDurableObject(roomStub(created.roomCode));
    expect(await runDurableObjectAlarm(roomStub(created.roomCode))).toBe(true);

    await waitForRoomGone(created.roomCode);
  });

  it('断线玩家仍在重连宽限期内时不会被提前清理', async () => {
    const { created, socket: host } = await setupHost('房主');
    host.close();
    await waitForAllOffline(created.roomCode);

    await backdateActivity(created.roomCode, ROOM_CLEANUP.reconnectGraceMs - 30_000);
    await evictDurableObject(roomStub(created.roomCode));
    expect(await runDurableObjectAlarm(roomStub(created.roomCode))).toBe(true);

    const kept = await fetchSnapshot(created.roomCode);
    expect(kept.status).toBe(200);
    const keptBody = kept.body as { room: { players: Array<{ online: boolean }> } };
    expect(keptBody.room.players).toHaveLength(1);
    expect(keptBody.room.players[0]?.online).toBe(false);

    await backdateActivity(created.roomCode, ROOM_CLEANUP.reconnectGraceMs + 1000);
    await evictDurableObject(roomStub(created.roomCode));
    expect(await runDurableObjectAlarm(roomStub(created.roomCode))).toBe(true);

    await waitForRoomGone(created.roomCode);
  });
});
