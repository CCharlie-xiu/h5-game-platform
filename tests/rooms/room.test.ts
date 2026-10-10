import {
  LifecycleTrigger,
  applyTrigger,
  attachConnection,
  createRoom,
  detachConnection,
  findPlayer,
  join,
  leave,
  onlineCount,
  setReady,
  toSnapshot,
} from '@h5/game-core';
import type { RoomRecord } from '@h5/game-core';
import { ErrorCode, GamePhase } from '@h5/game-protocol';
import { describe, expect, it } from 'vitest';

const HOST = 'p_host';
const NOW = 1_700_000_000_000;

function newRoom(maxPlayers = 4): RoomRecord {
  return createRoom({
    roomId: 'ABC123',
    roomCode: 'ABC123',
    gameId: 'diffusion-master',
    hostPlayerId: HOST,
    hostNickname: '房主',
    authSecret: 'test-secret',
    maxPlayers,
    now: NOW,
  });
}

function withPlayer(room: RoomRecord, playerId: string, nickname: string): RoomRecord {
  const result = join(room, {
    playerId,
    nickname,
    connectionId: `c_${playerId}`,
    now: NOW,
  });
  if (!result.ok) {
    throw new Error(`join failed: ${result.error.message}`);
  }
  return result.room;
}

function withReady(room: RoomRecord, playerId: string): RoomRecord {
  const result = setReady(room, playerId, true, NOW);
  if (!result.ok) {
    throw new Error(`setReady failed: ${result.error.message}`);
  }
  return result.room;
}

describe('房间：创建', () => {
  it('房主入座 0 号位，初始阶段为 WAITING', () => {
    const room = newRoom();
    expect(room.phase).toBe(GamePhase.WAITING);
    expect(room.players).toHaveLength(1);
    expect(room.players[0]?.playerId).toBe(HOST);
    expect(room.players[0]?.seat).toBe(0);
    expect(room.revision).toBe(1);
    expect(room.sessionId).toBeNull();
  });

  it('房间快照不泄露 authSecret', () => {
    const snapshot = toSnapshot(newRoom());
    expect('authSecret' in snapshot).toBe(false);
    expect(snapshot.roomCode).toBe('ABC123');
    expect(snapshot.players[0]?.isHost).toBe(true);
  });
});

describe('房间：加入', () => {
  it('新玩家按加入顺序分配座位', () => {
    const room = withPlayer(newRoom(), 'p_a', 'A');
    expect(room.players).toHaveLength(2);
    expect(findPlayer(room, 'p_a')?.seat).toBe(1);
    expect(room.revision).toBe(2);
  });

  it('重复加入同一 playerId 视为重连，不重复占座', () => {
    const room = withPlayer(newRoom(), 'p_a', 'A');
    const again = withPlayer(room, 'p_a', 'A2');
    expect(again.players).toHaveLength(2);
    expect(findPlayer(again, 'p_a')?.nickname).toBe('A2');
  });

  it('房间已满时拒绝加入', () => {
    let room = newRoom(2);
    room = withPlayer(room, 'p_a', 'A');
    const result = join(room, {
      playerId: 'p_b',
      nickname: 'B',
      connectionId: 'c_b',
      now: NOW,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe(ErrorCode.RoomFull);
    }
  });

  it('对局进行中拒绝新玩家加入', () => {
    let room = withPlayer(newRoom(), 'p_a', 'A');
    room = withReady(room, 'p_a');
    const started = applyTrigger(room, LifecycleTrigger.Start, HOST, NOW);
    expect(started.ok).toBe(true);
    if (!started.ok) {
      return;
    }

    const result = join(started.room, {
      playerId: 'p_b',
      nickname: 'B',
      connectionId: 'c_b',
      now: NOW,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe(ErrorCode.InvalidTransition);
    }
  });
});

describe('房间：准备', () => {
  it('房主无需准备', () => {
    const result = setReady(newRoom(), HOST, true, NOW);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe(ErrorCode.InvalidTransition);
    }
  });

  it('重复设置同一准备状态返回重复消息错误', () => {
    const room = withReady(withPlayer(newRoom(), 'p_a', 'A'), 'p_a');
    const result = setReady(room, 'p_a', true, NOW);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe(ErrorCode.DuplicateMessage);
    }
  });

  it('全员准备后进入 READY，取消准备后回到 WAITING', () => {
    let room = withPlayer(newRoom(), 'p_a', 'A');
    room = withReady(room, 'p_a');
    expect(room.phase).toBe(GamePhase.READY);

    const unready = setReady(room, 'p_a', false, NOW);
    expect(unready.ok).toBe(true);
    if (unready.ok) {
      expect(unready.room.phase).toBe(GamePhase.WAITING);
    }
  });

  it('人数不足时即使全部准备也保持 WAITING', () => {
    const room = newRoom();
    expect(room.players).toHaveLength(1);
    expect(room.phase).toBe(GamePhase.WAITING);
  });
});

describe('房间：离开与房主移交', () => {
  it('普通玩家离开后从列表移除', () => {
    const room = withPlayer(newRoom(), 'p_a', 'A');
    const result = leave(room, 'p_a', NOW);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.room.players).toHaveLength(1);
      expect(findPlayer(result.room, 'p_a')).toBeUndefined();
    }
  });

  it('房主离开后移交给座位最靠前的玩家', () => {
    let room = withPlayer(newRoom(), 'p_a', 'A');
    room = withPlayer(room, 'p_b', 'B');
    const result = leave(room, HOST, NOW);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.room.hostPlayerId).toBe('p_a');
      expect(toSnapshot(result.room).players.find((p) => p.playerId === 'p_a')?.isHost).toBe(true);
    }
  });

  it('离开不存在的玩家返回错误', () => {
    const result = leave(newRoom(), 'p_missing', NOW);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe(ErrorCode.NotInRoom);
    }
  });
});

describe('房间：连接与重连', () => {
  it('断开连接标记离线但保留座位', () => {
    const attached = attachConnection(newRoom(), HOST, 'c_host', NOW);
    expect(attached.ok).toBe(true);
    if (!attached.ok) {
      return;
    }

    const room = withPlayer(attached.room, 'p_a', 'A');
    expect(onlineCount(room)).toBe(2);

    const result = detachConnection(room, 'p_a', 'c_p_a', NOW + 1);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(findPlayer(result.room, 'p_a')?.online).toBe(false);
      expect(result.room.players).toHaveLength(2);
      expect(onlineCount(result.room)).toBe(1);
    }
  });

  it('重连恢复在线状态', () => {
    const room = withPlayer(newRoom(), 'p_a', 'A');
    const offline = detachConnection(room, 'p_a', 'c_p_a', NOW + 1);
    expect(offline.ok).toBe(true);
    if (!offline.ok) {
      return;
    }
    const online = attachConnection(offline.room, 'p_a', 'c_new', NOW + 2);
    expect(online.ok).toBe(true);
    if (online.ok) {
      const player = findPlayer(online.room, 'p_a');
      expect(player?.online).toBe(true);
      expect(player?.connectionId).toBe('c_new');
    }
  });

  it('旧连接的断开事件不会影响已被新连接替换的玩家', () => {
    const room = withPlayer(newRoom(), 'p_a', 'A');
    const replaced = attachConnection(room, 'p_a', 'c_new', NOW + 1);
    expect(replaced.ok).toBe(true);
    if (!replaced.ok) {
      return;
    }
    const stale = detachConnection(replaced.room, 'p_a', 'c_p_a', NOW + 2);
    expect(stale.ok).toBe(true);
    if (stale.ok) {
      expect(findPlayer(stale.room, 'p_a')?.online).toBe(true);
    }
  });
});

describe('房间：生命周期触发', () => {
  function readyRoom(): RoomRecord {
    let room = withPlayer(newRoom(), 'p_a', 'A');
    room = withReady(room, 'p_a');
    return room;
  }

  it('开始游戏写入 sessionId 并清空准备状态', () => {
    const result = applyTrigger(readyRoom(), LifecycleTrigger.Start, HOST, NOW + 10);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.room.phase).toBe(GamePhase.PLAYING);
      expect(result.room.sessionId).toBeTruthy();
      expect(result.room.sessions).toHaveLength(1);
      expect(result.room.players.every((player) => !player.ready)).toBe(true);
    }
  });

  it('非房主开始游戏被拒绝', () => {
    const result = applyTrigger(readyRoom(), LifecycleTrigger.Start, 'p_a', NOW + 10);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe(ErrorCode.NotHost);
    }
  });

  it('暂停 / 继续 / 结束完整闭环', () => {
    const started = applyTrigger(readyRoom(), LifecycleTrigger.Start, HOST, NOW + 10);
    expect(started.ok).toBe(true);
    if (!started.ok) {
      return;
    }

    const paused = applyTrigger(started.room, LifecycleTrigger.Pause, HOST, NOW + 11);
    expect(paused.ok).toBe(true);
    if (!paused.ok) {
      return;
    }
    expect(paused.room.phase).toBe(GamePhase.PAUSED);

    const resumed = applyTrigger(paused.room, LifecycleTrigger.Resume, HOST, NOW + 12);
    expect(resumed.ok).toBe(true);
    if (!resumed.ok) {
      return;
    }
    expect(resumed.room.phase).toBe(GamePhase.PLAYING);

    const ended = applyTrigger(resumed.room, LifecycleTrigger.End, HOST, NOW + 13);
    expect(ended.ok).toBe(true);
    if (!ended.ok) {
      return;
    }
    expect(ended.room.phase).toBe(GamePhase.FINISHED);
    expect(ended.room.sessions[0]?.endedAt).toBe(NOW + 13);
  });

  it('结束后的房间拒绝继续操作', () => {
    const started = applyTrigger(readyRoom(), LifecycleTrigger.Start, HOST, NOW + 10);
    if (!started.ok) {
      throw new Error('start failed');
    }
    const ended = applyTrigger(started.room, LifecycleTrigger.End, HOST, NOW + 11);
    if (!ended.ok) {
      throw new Error('end failed');
    }
    const resumed = applyTrigger(ended.room, LifecycleTrigger.Resume, HOST, NOW + 12);
    expect(resumed.ok).toBe(false);
    if (!resumed.ok) {
      expect(resumed.error.code).toBe(ErrorCode.InvalidTransition);
    }
  });

  it('每次成功操作都会推进 revision', () => {
    const room = readyRoom();
    const result = applyTrigger(room, LifecycleTrigger.Start, HOST, NOW + 10);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.room.revision).toBe(room.revision + 1);
    }
  });
});
