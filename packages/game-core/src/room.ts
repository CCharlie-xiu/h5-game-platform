import { ErrorCode, GamePhase, protocolError } from '@h5/game-protocol';
import type {
  GamePhase as GamePhaseValue,
  PlayerSnapshot,
  ProtocolError,
  RoomSnapshot,
} from '@h5/game-protocol';

import { LifecycleTrigger, evaluateReadyPhase, isTerminal, transition } from './lifecycle';
import type { TransitionContext } from './lifecycle';

/** 房间容量与昵称约束。 */
export const ROOM_LIMITS = {
  /** 最少开局人数下限 */
  minPlayers: 2,
  /** 房间人数上限 */
  maxPlayers: 8,
  /** 默认房间人数上限 */
  defaultMaxPlayers: 4,
  /** 昵称最大长度 */
  nicknameMaxLength: 24,
} as const;

/** 房间内的玩家记录（服务端内部模型）。 */
export interface PlayerRecord {
  readonly playerId: string;
  readonly nickname: string;
  readonly ready: boolean;
  readonly online: boolean;
  /** 当前 WebSocket 连接标识；离线为 null */
  readonly connectionId: string | null;
  readonly seat: number;
  readonly joinedAt: number;
  /** 显式离开时间；null 表示仍在房间 */
  readonly leftAt: number | null;
}

/** 单局对局记录。 */
export interface SessionRecord {
  readonly sessionId: string;
  readonly startedAt: number;
  readonly endedAt: number | null;
}

/**
 * 房间记录（服务端权威状态，持久化到 Durable Object storage）。
 *
 * `authSecret` 仅服务端可见，**不得**进入任何下发给客户端的快照。
 */
export interface RoomRecord {
  readonly roomId: string;
  readonly roomCode: string;
  readonly gameId: string;
  readonly phase: GamePhaseValue;
  readonly hostPlayerId: string;
  readonly minPlayers: number;
  readonly maxPlayers: number;
  readonly sessionId: string | null;
  readonly revision: number;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly lastActivityAt: number;
  readonly authSecret: string;
  readonly players: readonly PlayerRecord[];
  readonly sessions: readonly SessionRecord[];
}

/** 房间操作结果。 */
export type RoomResult =
  | { readonly ok: true; readonly room: RoomRecord }
  | { readonly ok: false; readonly error: ProtocolError };

function fail(code: ErrorCode, message: string, details?: Record<string, unknown>): RoomResult {
  return { ok: false, error: protocolError(code, message, details) };
}

/* -------------------------------------------------------------------------- */
/* 查询                                                                        */
/* -------------------------------------------------------------------------- */

/** 按 playerId 查找玩家。 */
export function findPlayer(room: RoomRecord, playerId: string): PlayerRecord | undefined {
  return room.players.find((player) => player.playerId === playerId);
}

/** 按 connectionId 查找玩家。 */
export function findPlayerByConnection(
  room: RoomRecord,
  connectionId: string,
): PlayerRecord | undefined {
  return room.players.find((player) => player.connectionId === connectionId);
}

/** 房主是否仍在房间内。 */
export function hostPlayer(room: RoomRecord): PlayerRecord | undefined {
  return findPlayer(room, room.hostPlayerId);
}

/** 除房主外的玩家是否全部已准备（房间只有房主时视为 true）。 */
export function allNonHostReady(room: RoomRecord): boolean {
  return room.players
    .filter((player) => player.playerId !== room.hostPlayerId)
    .every((player) => player.ready);
}

/** 当前在线玩家数。 */
export function onlineCount(room: RoomRecord): number {
  return room.players.filter((player) => player.online).length;
}

/** 生成单个玩家的对外快照。 */
export function toPlayerSnapshot(room: RoomRecord, playerId: string): PlayerSnapshot | null {
  const player = findPlayer(room, playerId);
  if (!player) {
    return null;
  }
  return {
    playerId: player.playerId,
    nickname: player.nickname,
    isHost: player.playerId === room.hostPlayerId,
    ready: player.ready,
    online: player.online,
    seat: player.seat,
    joinedAt: player.joinedAt,
  };
}

/** 生成对外的房间快照（剥离 authSecret 等内部字段）。 */
export function toSnapshot(room: RoomRecord): RoomSnapshot {
  const players: PlayerSnapshot[] = [...room.players]
    .sort((a, b) => a.seat - b.seat)
    .map((player) => ({
      playerId: player.playerId,
      nickname: player.nickname,
      isHost: player.playerId === room.hostPlayerId,
      ready: player.ready,
      online: player.online,
      seat: player.seat,
      joinedAt: player.joinedAt,
    }));

  return {
    roomId: room.roomId,
    roomCode: room.roomCode,
    gameId: room.gameId,
    phase: room.phase,
    hostPlayerId: room.hostPlayerId,
    minPlayers: room.minPlayers,
    maxPlayers: room.maxPlayers,
    sessionId: room.sessionId,
    revision: room.revision,
    createdAt: room.createdAt,
    updatedAt: room.updatedAt,
    players,
  };
}

/* -------------------------------------------------------------------------- */
/* 内部工具                                                                    */
/* -------------------------------------------------------------------------- */

function touch(room: RoomRecord, patch: Partial<RoomRecord>, now: number): RoomRecord {
  return {
    ...room,
    ...patch,
    revision: room.revision + 1,
    updatedAt: now,
    lastActivityAt: now,
  };
}

/** 依据人数与准备状态重新评估 WAITING / READY（不改动 revision）。 */
function withEvaluatedPhase(room: RoomRecord): RoomRecord {
  if (isTerminal(room.phase) || room.phase === GamePhase.PLAYING || room.phase === GamePhase.PAUSED) {
    return room;
  }
  const next = evaluateReadyPhase({
    playerCount: room.players.length,
    minPlayers: room.minPlayers,
    allReady: allNonHostReady(room),
  });
  return next === room.phase ? room : { ...room, phase: next };
}

function nextSeat(room: RoomRecord): number {
  return room.players.reduce((max, player) => Math.max(max, player.seat + 1), 0);
}

function transitionContext(room: RoomRecord, actorPlayerId: string): TransitionContext {
  return {
    actorPlayerId,
    hostPlayerId: room.hostPlayerId,
    playerCount: room.players.length,
    minPlayers: room.minPlayers,
    allReady: allNonHostReady(room),
  };
}

/* -------------------------------------------------------------------------- */
/* 操作                                                                        */
/* -------------------------------------------------------------------------- */

/** 创建房间，房主作为 0 号座位玩家直接入座。 */
export function createRoom(params: {
  readonly roomId: string;
  readonly roomCode: string;
  readonly gameId: string;
  readonly hostPlayerId: string;
  readonly hostNickname: string;
  readonly authSecret: string;
  readonly minPlayers?: number;
  readonly maxPlayers?: number;
  readonly now: number;
}): RoomRecord {
  const maxPlayers = Math.min(
    Math.max(params.maxPlayers ?? ROOM_LIMITS.defaultMaxPlayers, ROOM_LIMITS.minPlayers),
    ROOM_LIMITS.maxPlayers,
  );
  const host: PlayerRecord = {
    playerId: params.hostPlayerId,
    nickname: params.hostNickname,
    ready: false,
    online: false,
    connectionId: null,
    seat: 0,
    joinedAt: params.now,
    leftAt: null,
  };

  return {
    roomId: params.roomId,
    roomCode: params.roomCode,
    gameId: params.gameId,
    phase: GamePhase.WAITING,
    hostPlayerId: params.hostPlayerId,
    minPlayers: params.minPlayers ?? ROOM_LIMITS.minPlayers,
    maxPlayers,
    sessionId: null,
    revision: 1,
    createdAt: params.now,
    updatedAt: params.now,
    lastActivityAt: params.now,
    authSecret: params.authSecret,
    players: [host],
    sessions: [],
  };
}

/** 玩家加入房间。已存在的 playerId 视为重连（不重复占座）。 */
export function join(
  room: RoomRecord,
  params: {
    readonly playerId: string;
    readonly nickname: string;
    readonly connectionId: string;
    readonly now: number;
  },
): RoomResult {
  const existing = findPlayer(room, params.playerId);
  if (existing) {
    return {
      ok: true,
      room: touch(
        room,
        {
          players: room.players.map((player) =>
            player.playerId === params.playerId
              ? {
                  ...player,
                  nickname: params.nickname,
                  online: true,
                  connectionId: params.connectionId,
                  leftAt: null,
                }
              : player,
          ),
        },
        params.now,
      ),
    };
  }

  if (room.phase !== GamePhase.WAITING && room.phase !== GamePhase.READY) {
    return fail(ErrorCode.InvalidTransition, '对局已开始，无法加入房间', { phase: room.phase });
  }

  if (room.players.length >= room.maxPlayers) {
    return fail(ErrorCode.RoomFull, `房间已满（上限 ${room.maxPlayers} 人）`, {
      maxPlayers: room.maxPlayers,
    });
  }

  const player: PlayerRecord = {
    playerId: params.playerId,
    nickname: params.nickname,
    ready: false,
    online: true,
    connectionId: params.connectionId,
    seat: nextSeat(room),
    joinedAt: params.now,
    leftAt: null,
  };

  const next = touch(room, { players: [...room.players, player] }, params.now);
  return { ok: true, room: withEvaluatedPhase(next) };
}

/** 玩家显式离开：移除座位；房主离开时移交房主。 */
export function leave(room: RoomRecord, playerId: string, now: number): RoomResult {
  const player = findPlayer(room, playerId);
  if (!player) {
    return fail(ErrorCode.NotInRoom, '玩家不在房间内', { playerId });
  }

  const remaining = room.players.filter((item) => item.playerId !== playerId);

  if (remaining.length === 0) {
    const next = touch(room, { players: [], hostPlayerId: room.hostPlayerId }, now);
    return { ok: true, room: next };
  }

  const hostPlayerId =
    playerId === room.hostPlayerId
      ? [...remaining].sort((a, b) => a.seat - b.seat)[0]!.playerId
      : room.hostPlayerId;

  const next = touch(room, { players: remaining, hostPlayerId }, now);
  return { ok: true, room: withEvaluatedPhase(next) };
}

/** 标记玩家离线（保留座位以便重连）。 */
export function detachConnection(
  room: RoomRecord,
  playerId: string,
  connectionId: string,
  now: number,
): RoomResult {
  const player = findPlayer(room, playerId);
  if (!player) {
    return fail(ErrorCode.NotInRoom, '玩家不在房间内', { playerId });
  }
  if (player.connectionId !== connectionId) {
    return { ok: true, room };
  }

  const next = touch(
    room,
    {
      players: room.players.map((item) =>
        item.playerId === playerId ? { ...item, online: false, connectionId: null } : item,
      ),
    },
    now,
  );
  return { ok: true, room: withEvaluatedPhase(next) };
}

/** 绑定新的 WebSocket 连接（加入或重连）。 */
export function attachConnection(
  room: RoomRecord,
  playerId: string,
  connectionId: string,
  now: number,
): RoomResult {
  const player = findPlayer(room, playerId);
  if (!player) {
    return fail(ErrorCode.NotInRoom, '玩家不在房间内', { playerId });
  }

  const next = touch(
    room,
    {
      players: room.players.map((item) =>
        item.playerId === playerId
          ? { ...item, online: true, connectionId, leftAt: null }
          : item,
      ),
    },
    now,
  );
  return { ok: true, room: next };
}

/** 设置准备状态。房主无需准备。 */
export function setReady(
  room: RoomRecord,
  playerId: string,
  ready: boolean,
  now: number,
): RoomResult {
  if (playerId === room.hostPlayerId) {
    return fail(ErrorCode.InvalidTransition, '房主无需准备');
  }
  if (room.phase !== GamePhase.WAITING && room.phase !== GamePhase.READY) {
    return fail(ErrorCode.InvalidTransition, '对局已开始，无法修改准备状态', { phase: room.phase });
  }

  const player = findPlayer(room, playerId);
  if (!player) {
    return fail(ErrorCode.NotInRoom, '玩家不在房间内', { playerId });
  }
  if (player.ready === ready) {
    return fail(
      ErrorCode.DuplicateMessage,
      ready ? '玩家已处于准备状态' : '玩家已处于未准备状态',
      { playerId },
    );
  }

  const next = touch(
    room,
    {
      players: room.players.map((item) =>
        item.playerId === playerId ? { ...item, ready } : item,
      ),
    },
    now,
  );
  return { ok: true, room: withEvaluatedPhase(next) };
}

/** 应用一次生命周期转换（START / PAUSE / RESUME / END）。 */
export function applyTrigger(
  room: RoomRecord,
  trigger: LifecycleTrigger,
  actorPlayerId: string,
  now: number,
): RoomResult {
  const result = transition(room.phase, trigger, transitionContext(room, actorPlayerId));
  if (!result.ok) {
    return { ok: false, error: result.error };
  }
  if (!result.changed) {
    return { ok: true, room };
  }

  const patch: {
    phase: GamePhaseValue;
    sessionId?: string;
    sessions?: readonly SessionRecord[];
    players?: readonly PlayerRecord[];
  } = { phase: result.phase };

  if (trigger === LifecycleTrigger.Start) {
    const sessionId = `${room.roomCode}-${now.toString(36)}`;
    patch.sessionId = sessionId;
    patch.sessions = [...room.sessions, { sessionId, startedAt: now, endedAt: null }];
    // 开局后清空准备状态
    patch.players = room.players.map((player) => ({ ...player, ready: false }));
  }

  if (trigger === LifecycleTrigger.End) {
    patch.sessions = room.sessions.map((session) =>
      session.sessionId === room.sessionId && session.endedAt === null
        ? { ...session, endedAt: now }
        : session,
    );
  }

  return { ok: true, room: touch(room, patch, now) };
}

/** 是否应当销毁房间（无玩家）。 */
export function isEmpty(room: RoomRecord): boolean {
  return room.players.length === 0;
}
