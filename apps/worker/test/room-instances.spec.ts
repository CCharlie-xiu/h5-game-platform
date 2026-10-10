import { createRoom, toSnapshot } from '@h5/game-core';
import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

import { createRoomRepository } from '../src/db/repository';
import { connectSocket, roomStub, setupHost, waitForRoomGone } from './harness';

/* -------------------------------------------------------------------------- */
/* D1 测试辅助                                                                  */
/* -------------------------------------------------------------------------- */

function database(): D1Database {
  return (env as unknown as { DB: D1Database }).DB;
}

async function queryAll<T>(sql: string, ...params: unknown[]): Promise<T[]> {
  const statement = database().prepare(sql);
  const bound = params.length > 0 ? statement.bind(...params) : statement;
  const result = await bound.all<T>();
  return (result.results ?? []) as T[];
}

async function queryOne<T>(sql: string, ...params: unknown[]): Promise<T | null> {
  const statement = database().prepare(sql);
  const bound = params.length > 0 ? statement.bind(...params) : statement;
  return ((await bound.first<T>()) ?? null) as T | null;
}

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
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

function repository() {
  return createRoomRepository(database());
}

interface RoomRowView {
  readonly instance_id: string;
  readonly ended_at: number | null;
  readonly status: string;
}

function roomRow(code: string): Promise<RoomRowView | null> {
  return queryOne<RoomRowView>('select instance_id, ended_at, status from rooms where id = ?', code);
}

/** 用指定房间码直接调用 DO 的创建入口（便于构造房间码复用场景）。 */
async function createRoomWithCode(code: string, nickname = '房主') {
  const response = await roomStub(code).fetch('https://room.internal/create', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ gameId: 'diffusion-master', nickname }),
  });
  // DO 内部入口成功即 2xx（对外 201 由 Worker 包装）
  expect(response.ok).toBe(true);
  return (await response.json()) as {
    roomCode: string;
    playerId: string;
    token: string;
    room: unknown;
  };
}

/** 以房主身份加入后立即离开（触发「房间无玩家 → 立即销毁」）。 */
async function joinThenLeave(code: string, playerId: string, token: string): Promise<void> {
  const socket = await connectSocket(code);
  socket.send('JOIN_ROOM', { roomCode: code, nickname: '房主', playerId, token });
  await socket.waitFor('SESSION_GRANTED');
  socket.send('LEAVE_ROOM', {});
  await waitForRoomGone(code);
  socket.close();
}

/** 构造一个纯数据快照（不经过 DO），用于直接驱动仓库层。 */
function buildRoom(code: string, instanceId: string, hostPlayerId = 'p_host') {
  const room = createRoom({
    instanceId,
    roomId: code,
    roomCode: code,
    gameId: 'diffusion-master',
    hostPlayerId,
    hostNickname: '房主',
    authSecret: 'test-secret',
    now: 1_700_000_000_000,
  });
  return { instanceId, snapshot: toSnapshot(room) };
}

/* -------------------------------------------------------------------------- */
/* 1. 房间码复用                                                                */
/* -------------------------------------------------------------------------- */

describe('P2-3：房间码复用', () => {
  it('房间码被复用时可成功登记新实例，且槽位唯一', async () => {
    const code = 'ZQ4W7P';

    const first = await createRoomWithCode(code, '房主A');
    const firstRow = await waitForRow(() => roomRow(code));
    expect(firstRow.instance_id).not.toContain('legacy:');
    expect(firstRow.ended_at).toBeNull();

    await joinThenLeave(code, first.playerId, first.token);
    const endedRow = await waitForRow(async () => {
      const row = await roomRow(code);
      return row && row.ended_at !== null ? row : null;
    });
    expect(endedRow.instance_id).toBe(firstRow.instance_id);

    // 复用同一房间码创建新实例：必须成功登记（旧缺陷下会因主键冲突而静默失败）
    const second = await createRoomWithCode(code, '房主B');
    expect(second.roomCode).toBe(code);

    const secondRow = await waitForRow(async () => {
      const row = await roomRow(code);
      return row && row.instance_id !== firstRow.instance_id ? row : null;
    });
    expect(secondRow.ended_at).toBeNull();

    // 一个房间码在 rooms 中只有一行（槽位唯一）
    const rows = await queryAll<{ instance_id: string }>('select instance_id from rooms where id = ?', code);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.instance_id).toBe(secondRow.instance_id);
  });

  it('房间销毁后 D1 标记实例结束，同码可被新实例接管', async () => {
    const { created, socket } = await setupHost('房主');
    const before = await waitForRow(() => roomRow(created.roomCode));
    expect(before.ended_at).toBeNull();

    socket.send('LEAVE_ROOM', {});
    await waitForRoomGone(created.roomCode);

    const after = await waitForRow(async () => {
      const row = await roomRow(created.roomCode);
      return row && row.ended_at !== null ? row : null;
    });
    expect(after.instance_id).toBe(before.instance_id);

    const reused = await createRoomWithCode(created.roomCode, '新房主');
    expect(reused.roomCode).toBe(created.roomCode);

    const reusedRow = await waitForRow(async () => {
      const row = await roomRow(created.roomCode);
      return row && row.instance_id !== before.instance_id ? row : null;
    });
    expect(reusedRow.ended_at).toBeNull();
  });
});

/* -------------------------------------------------------------------------- */
/* 2. 玩家记录隔离                                                              */
/* -------------------------------------------------------------------------- */

describe('P2-3：玩家记录按实例归属', () => {
  it('新实例不会继承旧实例的玩家记录', async () => {
    const code = 'ZQ4W7Q';

    const first = await createRoomWithCode(code, '房主A');
    const firstRow = await waitForRow(() => roomRow(code));
    await joinThenLeave(code, first.playerId, first.token);

    await createRoomWithCode(code, '房主B');
    const secondRow = await waitForRow(async () => {
      const row = await roomRow(code);
      return row && row.instance_id !== firstRow.instance_id ? row : null;
    });

    // 新实例中加入一名玩家
    const guest = await connectSocket(code);
    guest.send('JOIN_ROOM', { roomCode: code, nickname: '玩家B' });
    await guest.waitFor('SESSION_GRANTED');

    const firstPlayers = await waitForRow(async () => {
      const rows = await queryAll<{ id: string }>(
        'select id from room_players where room_instance_id = ?',
        firstRow.instance_id,
      );
      return rows.length > 0 ? rows : null;
    });
    const secondPlayers = await waitForRow(async () => {
      const rows = await queryAll<{ id: string }>(
        'select id from room_players where room_instance_id = ?',
        secondRow.instance_id,
      );
      return rows.length >= 2 ? rows : null;
    });

    expect(firstPlayers).toHaveLength(1);
    expect(secondPlayers).toHaveLength(2);

    // 两代玩家记录完全不重叠
    const overlap = firstPlayers.filter((row) =>
      secondPlayers.some((other) => other.id === row.id),
    );
    expect(overlap).toHaveLength(0);

    // 每条记录都归属于对应实例
    for (const row of firstPlayers) {
      expect(row.id.startsWith(`${firstRow.instance_id}:`)).toBe(true);
    }
    for (const row of secondPlayers) {
      expect(row.id.startsWith(`${secondRow.instance_id}:`)).toBe(true);
    }

    guest.close();
  });
});

/* -------------------------------------------------------------------------- */
/* 3. 旧实例的迟到写入 / 清理不污染新实例                                        */
/* -------------------------------------------------------------------------- */

describe('P2-3：旧实例迟到写入隔离', () => {
  async function setupReusedCode(code: string) {
    const first = await createRoomWithCode(code, '房主A');
    const firstRow = await waitForRow(() => roomRow(code));
    await joinThenLeave(code, first.playerId, first.token);

    await createRoomWithCode(code, '房主B');
    const secondRow = await waitForRow(async () => {
      const row = await roomRow(code);
      return row && row.instance_id !== firstRow.instance_id ? row : null;
    });

    const guest = await connectSocket(code);
    guest.send('JOIN_ROOM', { roomCode: code, nickname: '玩家B' });
    await guest.waitFor('SESSION_GRANTED');

    return { firstRow, secondRow, guest, first };
  }

  it('旧实例的清理标记不会释放或覆盖新实例', async () => {
    const code = 'ZQ4W7R';
    const { firstRow, secondRow, guest } = await setupReusedCode(code);
    const repo = repository();

    // 模拟旧实例的迟到清理：结束标记 + 状态回写
    await repo.markRoomEnded(firstRow.instance_id, Date.now());
    await repo.recordRoomStatus(
      firstRow.instance_id,
      buildRoom(code, firstRow.instance_id, 'p_stale_host').snapshot,
    );

    const row = await waitForRow(() => roomRow(code));
    expect(row.instance_id).toBe(secondRow.instance_id);
    expect(row.ended_at).toBeNull();
    expect(row.status).toBe(secondRow.status);

    guest.close();
  });

  it('旧实例的迟到写入不会污染新实例的玩家与对局记录', async () => {
    const code = 'ZQ4W7S';
    const { firstRow, secondRow, guest, first } = await setupReusedCode(code);
    const repo = repository();

    const lateAt = Date.now();
    await repo.recordPlayerJoined(firstRow.instance_id, code, {
      playerId: 'p_late',
      nickname: '迟到者',
      isHost: false,
      ready: false,
      online: true,
      seat: 5,
      joinedAt: lateAt,
    });
    await repo.recordPlayerLeft(firstRow.instance_id, first.playerId, lateAt);
    await repo.recordSessionStarted(
      firstRow.instance_id,
      code,
      'diffusion-master',
      `${code}-late`,
      lateAt,
    );

    const secondPlayers = await queryAll<{ id: string }>(
      'select id from room_players where room_instance_id = ?',
      secondRow.instance_id,
    );
    const secondSessions = await queryAll<{ id: string }>(
      'select id from game_sessions where room_instance_id = ?',
      secondRow.instance_id,
    );

    // 新实例完全不受影响
    expect(secondPlayers).toHaveLength(2);
    expect(secondPlayers.every((row) => row.id.startsWith(`${secondRow.instance_id}:`))).toBe(
      true,
    );
    expect(secondSessions).toHaveLength(0);

    // 旧实例的迟到记录写入到旧实例名下（记录不丢失，只是不污染新实例）
    const firstPlayers = await queryAll<{ id: string }>(
      'select id from room_players where room_instance_id = ?',
      firstRow.instance_id,
    );
    expect(firstPlayers).toHaveLength(2);
    expect(firstPlayers.some((row) => row.id === `${firstRow.instance_id}:p_late`)).toBe(true);

    guest.close();
  });
});

/* -------------------------------------------------------------------------- */
/* 4. 重复创建 / 并发创建 / 写入失败                                             */
/* -------------------------------------------------------------------------- */

describe('P2-3：登记语义（幂等 / 冲突 / 失败）', () => {
  it('同一实例重复登记是幂等的', async () => {
    const code = 'ZQ4W7T';
    const { instanceId, snapshot } = buildRoom(code, 'r_dup_instance');
    const repo = repository();

    const first = await repo.recordRoomCreated(instanceId, snapshot);
    const second = await repo.recordRoomCreated(instanceId, snapshot);

    expect(first).toEqual({ ok: true, created: true });
    expect(second).toEqual({ ok: true, created: false });

    const rows = await queryAll<{ instance_id: string }>(
      'select instance_id from rooms where id = ?',
      code,
    );
    expect(rows).toHaveLength(1);
  });

  it('活动实例占用房间码时返回 CODE_IN_USE', async () => {
    const code = 'ZQ4W7V';
    const repo = repository();

    const active = buildRoom(code, 'r_active_instance');
    expect(await repo.recordRoomCreated(active.instanceId, active.snapshot)).toEqual({
      ok: true,
      created: true,
    });

    const challenger = buildRoom(code, 'r_challenger_instance');
    expect(await repo.recordRoomCreated(challenger.instanceId, challenger.snapshot)).toEqual({
      ok: false,
      reason: 'CODE_IN_USE',
    });

    const row = await roomRow(code);
    expect(row?.instance_id).toBe('r_active_instance');
    expect(row?.ended_at).toBeNull();
  });

  it('并发创建同一房间码时只会产生一个活动实例', async () => {
    const code = 'ZQ4W7W';
    const repo = repository();

    const candidates = ['r_race_1', 'r_race_2', 'r_race_3'].map((instanceId) =>
      buildRoom(code, instanceId),
    );

    const results = await Promise.all(
      candidates.map((candidate) =>
        repo.recordRoomCreated(candidate.instanceId, candidate.snapshot),
      ),
    );

    const winners = results.filter((result) => result.ok);
    expect(winners).toHaveLength(1);

    const rows = await queryAll<{ instance_id: string; ended_at: number | null }>(
      'select instance_id, ended_at from rooms where id = ?',
      code,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.ended_at).toBeNull();
    expect(candidates.map((c) => c.instanceId)).toContain(rows[0]?.instance_id);
  });

  it('D1 写入失败时登记不会报告成功', async () => {
    const failingDatabase = {
      prepare() {
        throw new Error('D1_ERROR: simulated failure');
      },
      batch() {
        throw new Error('D1_ERROR: simulated failure');
      },
      exec() {
        throw new Error('D1_ERROR: simulated failure');
      },
      dump() {
        throw new Error('D1_ERROR: simulated failure');
      },
    } as unknown as D1Database;

    const repo = createRoomRepository(failingDatabase);
    const { instanceId, snapshot } = buildRoom('ZQ4W7X', 'r_failing');

    await expect(repo.recordRoomCreated(instanceId, snapshot)).rejects.toThrow();

    // 失败没有被记录成任何行
    const rows = await queryAll<{ instance_id: string }>(
      'select instance_id from rooms where id = ?',
      'ZQ4W7X',
    );
    expect(rows).toHaveLength(0);
  });
});

/* -------------------------------------------------------------------------- */
/* 5. 正常生命周期回归（D1 视角）                                                */
/* -------------------------------------------------------------------------- */

describe('P2-3：正常生命周期在 D1 中的实例归属', () => {
  it('加入 / 离开 / 开局 / 结束的记录都归属于同一房间实例', async () => {
    const { created, socket: host } = await setupHost('房主');
    const row = await waitForRow(() => roomRow(created.roomCode));

    const guest = await connectSocket(created.roomCode);
    guest.send('JOIN_ROOM', { roomCode: created.roomCode, nickname: '玩家B' });
    await guest.waitFor('SESSION_GRANTED');

    await waitForRow(async () => {
      const players = await queryAll<{ id: string }>(
        'select id from room_players where room_instance_id = ?',
        row.instance_id,
      );
      return players.length >= 2 ? players : null;
    });

    guest.send('PLAYER_READY', {});
    await host.waitForState((state) => state.phase === 'READY');
    host.send('GAME_START', {});
    const playing = await host.waitForState((state) => state.phase === 'PLAYING');
    const sessionId = String(playing.sessionId);

    const session = await waitForRow(() =>
      queryOne<{ room_instance_id: string; ended_at: number | null }>(
        'select room_instance_id, ended_at from game_sessions where id = ?',
        sessionId,
      ),
    );
    expect(session.room_instance_id).toBe(row.instance_id);
    expect(session.ended_at).toBeNull();

    host.send('GAME_END', {});
    await host.waitForState((state) => state.phase === 'FINISHED');

    const endedSession = await waitForRow(async () => {
      const current = await queryOne<{ ended_at: number | null }>(
        'select ended_at from game_sessions where id = ?',
        sessionId,
      );
      return current && current.ended_at !== null ? current : null;
    });
    expect(endedSession.ended_at).not.toBeNull();

    // 玩家离开记录仍归属于同一实例，且房间码槽位未被释放
    const playersAfter = await queryAll<{ id: string }>(
      'select id from room_players where room_instance_id = ?',
      row.instance_id,
    );
    expect(playersAfter).toHaveLength(2);
    expect((await roomRow(created.roomCode))?.instance_id).toBe(row.instance_id);

    host.close();
    guest.close();
  });
});
