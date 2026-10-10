import { ErrorCode, GamePhase, protocolError } from '@h5/game-protocol';
import type {
  GamePhase as GamePhaseValue,
  PlayerSnapshot,
  ProtocolError,
  RoomSnapshot,
} from '@h5/game-protocol';

import { LifecycleTrigger, evaluateReadyPhase, isTerminal, transition } from './lifecycle';
import type { TransitionContext } from './lifecycle';

/** 房间容量与昵称约束（与 `@h5/game-protocol` 的 snapshot Schema 保持一致）。 */
export const ROOM_LIMITS = {
  /** 最少开局人数下限 */
  minPlayers: 2,
  /** 房间人数上限 */
  maxPlayers: 8,
  /** 默认房间人数上限 */
  defaultMaxPlayers: 4,
  /** 昵称最大长度 */
  nicknameMaxLength: 24,
  /** 游戏标识最大长度 */
  gameIdMaxLength: 64,
  /** 房间标识 / 房间码最大长度 */
  roomIdMaxLength: 16,
} as const;

/** 把任意输入钳制为合法人数：整数、落在 `[minPlayers, maxPlayers]` 内。 */
function clampPlayerCount(value: number): number {
  if (Number.isNaN(value)) {
    return ROOM_LIMITS.minPlayers;
  }
  const integer = Math.trunc(value);
  return Math.min(Math.max(integer, ROOM_LIMITS.minPlayers), ROOM_LIMITS.maxPlayers);
}

/**
 * 归一化房间人数配置。
 *
 * 保证返回值是合法整数、处于支持范围，且恒有 `minPlayers <= maxPlayers`
 * （即不会产生「最少开局人数大于房间容量」的不可开局房间）。
 */
export function normalizeRoomLimits(params: {
  readonly minPlayers?: number | undefined;
  readonly maxPlayers?: number | undefined;
}): { readonly minPlayers: number; readonly maxPlayers: number } {
  const minPlayers = clampPlayerCount(params.minPlayers ?? ROOM_LIMITS.minPlayers);
  const requestedMax = clampPlayerCount(params.maxPlayers ?? ROOM_LIMITS.defaultMaxPlayers);
  return {
    minPlayers,
    maxPlayers: Math.max(requestedMax, minPlayers),
  };
}

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
/* 清理策略                                                                    */
/* -------------------------------------------------------------------------- */

/** 清理策略常量。 */
export const ROOM_CLEANUP = {
  /** 房间已无任何玩家时的保留时长 */
  emptyRoomTtlMs: 60_000,
  /** 全部玩家离线（座位保留待重连）时的保留时长 */
  reconnectGraceMs: 5 * 60_000,
} as const;

/** 房间清理原因。 */
export type RoomCleanupReason = 'EMPTY' | 'ABANDONED';

/**
 * 判断房间是否应当被清理（纯函数，便于单测与测试时钟驱动）。
 *
 * 规则：
 * - **只要有在线玩家，永不清理**（长时间无状态变更不是清理依据）
 * - 无玩家（全部显式离开）→ 超过 `emptyRoomTtlMs` 后清理
 * - 仅剩离线玩家（座位保留待重连）→ 超过 `reconnectGraceMs` 后清理
 */
export function evaluateRoomCleanup(
  room: RoomRecord,
  now: number,
): { readonly destroy: boolean; readonly reason: RoomCleanupReason | null } {
  if (onlineCount(room) > 0) {
    return { destroy: false, reason: null };
  }

  const idleFor = now - room.lastActivityAt;

  if (room.players.length === 0) {
    return idleFor >= ROOM_CLEANUP.emptyRoomTtlMs
      ? { destroy: true, reason: 'EMPTY' }
      : { destroy: false, reason: null };
  }

  return idleFor >= ROOM_CLEANUP.reconnectGraceMs
    ? { destroy: true, reason: 'ABANDONED' }
    : { destroy: false, reason: null };
}

/* -------------------------------------------------------------------------- */
/* 消息范围校验                                                                */
/* -------------------------------------------------------------------------- */

/**
 * 校验消息封套中的 `roomId` / `sessionId` 是否与当前房间、当前对局一致。
 *
 * - 字段缺省视为「按消息协议定义允许省略」，不做跨局推断
 * - 字段存在时必须严格匹配，不匹配返回明确错误（不静默接受）
 */
export function checkEnvelopeScope(
  message: { readonly roomId?: string | undefined; readonly sessionId?: string | undefined },
  room: RoomRecord,
): ProtocolError | null {
  if (message.roomId !== undefined && message.roomId !== room.roomCode) {
    return protocolError(ErrorCode.RoomNotFound, '消息中的 roomId 与当前房间不一致', {
      received: message.roomId,
      expected: room.roomCode,
    });
  }

  if (message.sessionId !== undefined) {
    if (room.sessionId === null) {
      return protocolError(ErrorCode.SessionMismatch, '当前房间没有进行中的对局', {
        received: message.sessionId,
      });
    }
    if (message.sessionId !== room.sessionId) {
      return protocolError(ErrorCode.SessionMismatch, '消息中的 sessionId 与当前对局不一致', {
        received: message.sessionId,
        expected: room.sessionId,
      });
    }
  }

  return null;
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

/** 归一化昵称：去首尾空白、限长；空白昵称回退为「玩家」。 */
export function normalizeNickname(nickname: string): string {
  const trimmed = nickname.trim().slice(0, ROOM_LIMITS.nicknameMaxLength);
  return trimmed.length > 0 ? trimmed : '玩家';
}

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
  const { minPlayers, maxPlayers } = normalizeRoomLimits({
    minPlayers: params.minPlayers,
    maxPlayers: params.maxPlayers,
  });

  const host: PlayerRecord = {
    playerId: params.hostPlayerId,
    nickname: normalizeNickname(params.hostNickname),
    ready: false,
    online: false,
    connectionId: null,
    seat: 0,
    joinedAt: params.now,
    leftAt: null,
  };

  return {
    roomId: params.roomId.slice(0, ROOM_LIMITS.roomIdMaxLength),
    roomCode: params.roomCode.slice(0, ROOM_LIMITS.roomIdMaxLength),
    gameId: params.gameId.trim().slice(0, ROOM_LIMITS.gameIdMaxLength),
    phase: GamePhase.WAITING,
    hostPlayerId: params.hostPlayerId,
    minPlayers,
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
  const nickname = normalizeNickname(params.nickname);
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
                  nickname,
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
    nickname,
    ready: false,
    online: true,
    connectionId: params.connectionId,
    seat: nextSeat(room),
    joinedAt: params.now,
    leftAt: null,
  };

  // 空房间（例如最后一名玩家已显式离开）由首位加入者接管房主，
  // 避免遗留悬空 hostPlayerId 导致房间永久无法开局。
  const hostPlayerId = room.players.length === 0 ? params.playerId : room.hostPlayerId;

  const next = touch(room, { players: [...room.players, player], hostPlayerId }, params.now);
  return { ok: true, room: withEvaluatedPhase(next) };
}

/**
 * 玩家显式离开：移除座位；房主离开时移交给座位最靠前的剩余玩家。
 *
 * 契约：若离开后房间变为空（`isEmpty` 为 true），`hostPlayerId` 会暂时指向已离开的玩家。
 * 调用方**必须**立即销毁该房间，不要持久化空房间。
 */
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

/**
 * 房间是否已无任何玩家。
 *
 * 契约：返回 true 时调用方**必须**立即销毁房间（关闭连接 + 清空存储），
 * 不得把空房间持久化下来，否则会遗留悬空房主身份。
 * `join()` 对「向空房间加入」做了自愈（首位加入者接管房主）作为兜底。
 */
export function isEmpty(room: RoomRecord): boolean {
  return room.players.length === 0;
}
