import {
  LifecycleTrigger,
  ROOM_CLEANUP,
  ROOM_LIMITS,
  applyTrigger,
  attachConnection,
  checkEnvelopeScope,
  createRoom,
  detachConnection,
  evaluateRoomCleanup,
  join,
  leave,
  normalizeNickname,
  normalizeRoomLimits,
  setReady,
  toSnapshot,
} from '@h5/game-core';
import type { RoomRecord } from '@h5/game-core';
import { ErrorCode } from '@h5/game-protocol';
import { describe, expect, it } from 'vitest';

const HOST = 'p_host';
const NOW = 1_700_000_000_000;

function newRoom(overrides: { maxPlayers?: number; gameId?: string; nickname?: string } = {}) {
  return createRoom({
    roomId: 'ABC234',
    roomCode: 'ABC234',
    gameId: overrides.gameId ?? 'diffusion-master',
    hostPlayerId: HOST,
    hostNickname: overrides.nickname ?? '房主',
    authSecret: 'test-secret',
    maxPlayers: overrides.maxPlayers,
    now: NOW,
  });
}

function withPlayer(room: RoomRecord, playerId: string, nickname = '玩家'): RoomRecord {
  const result = join(room, { playerId, nickname, connectionId: `c_${playerId}`, now: NOW });
  if (!result.ok) {
    throw new Error(`join failed: ${result.error.message}`);
  }
  return result.room;
}

/* -------------------------------------------------------------------------- */
/* P2-1：人数配置归一化                                                        */
/* -------------------------------------------------------------------------- */

describe('P2-1 normalizeRoomLimits', () => {
  it('缺省时使用默认值', () => {
    expect(normalizeRoomLimits({})).toEqual({
      minPlayers: ROOM_LIMITS.minPlayers,
      maxPlayers: ROOM_LIMITS.defaultMaxPlayers,
    });
  });

  it('小数被截断为整数（不会产生 3.5 这类非法人数）', () => {
    expect(normalizeRoomLimits({ maxPlayers: 3.5 }).maxPlayers).toBe(3);
    expect(normalizeRoomLimits({ minPlayers: 2.9 }).minPlayers).toBe(2);
  });

  it('越界值被钳制到支持范围', () => {
    expect(normalizeRoomLimits({ maxPlayers: 1 }).maxPlayers).toBe(ROOM_LIMITS.minPlayers);
    expect(normalizeRoomLimits({ maxPlayers: 999 }).maxPlayers).toBe(ROOM_LIMITS.maxPlayers);
    expect(normalizeRoomLimits({ minPlayers: -5 }).minPlayers).toBe(ROOM_LIMITS.minPlayers);
    expect(normalizeRoomLimits({ minPlayers: 99 }).minPlayers).toBe(ROOM_LIMITS.maxPlayers);
  });

  it('NaN / Infinity 被处理为合法整数', () => {
    expect(normalizeRoomLimits({ maxPlayers: Number.NaN }).maxPlayers).toBe(
      ROOM_LIMITS.minPlayers,
    );
    expect(normalizeRoomLimits({ maxPlayers: Number.POSITIVE_INFINITY }).maxPlayers).toBe(
      ROOM_LIMITS.maxPlayers,
    );
    expect(normalizeRoomLimits({ maxPlayers: Number.NEGATIVE_INFINITY }).maxPlayers).toBe(
      ROOM_LIMITS.minPlayers,
    );
  });

  it('minPlayers > maxPlayers 时提升 maxPlayers，保证可开局', () => {
    const limits = normalizeRoomLimits({ minPlayers: 8, maxPlayers: 2 });
    expect(limits.minPlayers).toBe(8);
    expect(limits.maxPlayers).toBeGreaterThanOrEqual(limits.minPlayers);
    expect(limits.maxPlayers).toBe(8);
  });

  it('恒满足 minPlayers <= maxPlayers', () => {
    for (const min of [-1, 0, 2, 4, 7, 8, 9]) {
      for (const max of [-1, 0, 1, 2, 4, 8, 20]) {
        const limits = normalizeRoomLimits({ minPlayers: min, maxPlayers: max });
        expect(limits.minPlayers).toBeLessThanOrEqual(limits.maxPlayers);
        expect(Number.isInteger(limits.minPlayers)).toBe(true);
        expect(Number.isInteger(limits.maxPlayers)).toBe(true);
      }
    }
  });
});

describe('P2-1 createRoom 归一化与快照合法性', () => {
  it('小数 maxPlayers 被归一化为整数，快照可被协议 Schema 解析', () => {
    const room = newRoom({ maxPlayers: 3.5 });
    expect(room.maxPlayers).toBe(3);
    expect(Number.isInteger(toSnapshot(room).maxPlayers)).toBe(true);
  });

  it('超长 gameId 被截断到协议上限', () => {
    const room = newRoom({ gameId: 'g'.repeat(200) });
    expect(room.gameId).toHaveLength(ROOM_LIMITS.gameIdMaxLength);
  });

  it('昵称去空白并限长，纯空白回退为默认昵称', () => {
    expect(normalizeNickname('  阿甲  ')).toBe('阿甲');
    expect(normalizeNickname('x'.repeat(50))).toHaveLength(ROOM_LIMITS.nicknameMaxLength);
    expect(normalizeNickname('   ')).toBe('玩家');
    expect(normalizeNickname('')).toBe('玩家');
  });
});

/* -------------------------------------------------------------------------- */
/* P2-2：空房间与房主身份                                                      */
/* -------------------------------------------------------------------------- */

describe('P2-2 空房间的房主自愈', () => {
  it('最后一名玩家离开后房间为空（调用方必须销毁）', () => {
    const room = newRoom();
    const result = leave(room, HOST, NOW + 1);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.room.players).toHaveLength(0);
    }
  });

  it('向空房间加入时，首位加入者接管房主（不会遗留悬空房主）', () => {
    const emptied = leave(newRoom(), HOST, NOW + 1);
    expect(emptied.ok).toBe(true);
    if (!emptied.ok) {
      return;
    }

    const rejoined = withPlayer(emptied.room, 'p_new', '新玩家');
    expect(rejoined.hostPlayerId).toBe('p_new');
    expect(rejoined.players).toHaveLength(1);
    expect(toSnapshot(rejoined).players[0]?.isHost).toBe(true);
  });

  it('接管房主后可正常开局', () => {
    const emptied = leave(newRoom(), HOST, NOW + 1);
    if (!emptied.ok) {
      throw new Error('leave failed');
    }

    let room = withPlayer(emptied.room, 'p_new', '新玩家');
    room = withPlayer(room, 'p_second', '第二人');
    expect(room.hostPlayerId).toBe('p_new');

    const ready = setReady(room, 'p_second', true, NOW + 2);
    if (!ready.ok) {
      throw new Error(`setReady failed: ${ready.error.message}`);
    }
    room = ready.room;

    const started = applyTrigger(room, LifecycleTrigger.Start, 'p_new', NOW + 3);
    expect(started.ok).toBe(true);
    if (started.ok) {
      expect(started.room.phase).toBe('PLAYING');
    }
  });
});

/* -------------------------------------------------------------------------- */
/* P1-2：清理策略判定                                                          */
/* -------------------------------------------------------------------------- */

describe('P1-2 evaluateRoomCleanup', () => {
  it('只要有在线玩家，即使长时间无状态变更也不清理', () => {
    const attached = attachConnection(newRoom(), HOST, 'c_host', NOW);
    expect(attached.ok).toBe(true);
    if (!attached.ok) {
      return;
    }

    const longIdle = NOW + 24 * 60 * 60 * 1000;
    expect(evaluateRoomCleanup(attached.room, longIdle)).toEqual({
      destroy: false,
      reason: null,
    });
  });

  it('空房间在 TTL 内不清理，超过 TTL 后清理（原因 EMPTY）', () => {
    const emptied = leave(newRoom(), HOST, NOW);
    if (!emptied.ok) {
      throw new Error('leave failed');
    }

    const justBefore = NOW + ROOM_CLEANUP.emptyRoomTtlMs - 1;
    expect(evaluateRoomCleanup(emptied.room, justBefore).destroy).toBe(false);
    expect(evaluateRoomCleanup(emptied.room, NOW + ROOM_CLEANUP.emptyRoomTtlMs)).toEqual({
      destroy: true,
      reason: 'EMPTY',
    });
  });

  it('仅剩离线玩家时，重连宽限期内不清理，超期后清理（原因 ABANDONED）', () => {
    const attached = attachConnection(newRoom(), HOST, 'c_host', NOW);
    if (!attached.ok) {
      throw new Error('attach failed');
    }
    const detached = detachConnection(attached.room, HOST, 'c_host', NOW);
    if (!detached.ok) {
      throw new Error('detach failed');
    }

    const withinGrace = NOW + ROOM_CLEANUP.reconnectGraceMs - 1;
    expect(evaluateRoomCleanup(detached.room, withinGrace).destroy).toBe(false);
    expect(evaluateRoomCleanup(detached.room, NOW + ROOM_CLEANUP.reconnectGraceMs)).toEqual({
      destroy: true,
      reason: 'ABANDONED',
    });
  });

  it('重连宽限期长于空房 TTL（断线座位比空房保留更久）', () => {
    expect(ROOM_CLEANUP.reconnectGraceMs).toBeGreaterThan(ROOM_CLEANUP.emptyRoomTtlMs);
  });
});

/* -------------------------------------------------------------------------- */
/* P2-5：封套 roomId / sessionId 一致性                                        */
/* -------------------------------------------------------------------------- */

describe('P2-5 checkEnvelopeScope', () => {
  function playingRoom(): RoomRecord {
    let room = withPlayer(newRoom(), 'p_a', 'A');

    const ready = setReady(room, 'p_a', true, NOW + 1);
    if (!ready.ok) {
      throw new Error(`setReady failed: ${ready.error.message}`);
    }
    room = ready.room;

    const started = applyTrigger(room, LifecycleTrigger.Start, HOST, NOW + 2);
    if (!started.ok) {
      throw new Error(`start failed: ${started.error.message}`);
    }
    return started.room;
  }

  it('缺省 roomId / sessionId 视为允许省略', () => {
    expect(checkEnvelopeScope({}, newRoom())).toBeNull();
    expect(checkEnvelopeScope({}, playingRoom())).toBeNull();
  });

  it('roomId 与当前房间一致时通过', () => {
    expect(checkEnvelopeScope({ roomId: 'ABC234' }, newRoom())).toBeNull();
  });

  it('roomId 与当前房间不一致时返回 ROOM_NOT_FOUND', () => {
    const error = checkEnvelopeScope({ roomId: 'ZZZ999' }, newRoom());
    expect(error?.code).toBe(ErrorCode.RoomNotFound);
  });

  it('房间没有进行中的对局时携带 sessionId 被拒绝', () => {
    const error = checkEnvelopeScope({ sessionId: 's_x' }, newRoom());
    expect(error?.code).toBe(ErrorCode.SessionMismatch);
  });

  it('sessionId 与当前对局不一致时返回 SESSION_MISMATCH', () => {
    const room = playingRoom();
    expect(room.sessionId).toBeTruthy();
    expect(checkEnvelopeScope({ sessionId: room.sessionId ?? '' }, room)).toBeNull();

    const error = checkEnvelopeScope({ sessionId: 's_stale' }, room);
    expect(error?.code).toBe(ErrorCode.SessionMismatch);
  });
});
