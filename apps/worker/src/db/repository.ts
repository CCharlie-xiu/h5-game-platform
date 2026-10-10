import { and, eq, isNotNull, isNull } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';

import type { GamePhase, PlayerSnapshot, RoomSnapshot } from '@h5/game-protocol';

import { gameSessions, roomPlayers, rooms } from './schema';

/**
 * 房间实例登记结果。
 *
 * - `ok: true, created: true`  新实例已接管 / 新建房间码槽位
 * - `ok: true, created: false` 同一实例重复登记（幂等，无需重复写入）
 * - `ok: false, reason: 'CODE_IN_USE'` 该房间码槽位仍被另一个**活动**实例占用
 */
export type RegisterRoomResult =
  | { readonly ok: true; readonly created: boolean }
  | { readonly ok: false; readonly reason: 'CODE_IN_USE' };

/**
 * D1 持久化仓库。
 *
 * 只写入**离散生命周期事件**（房间创建 / 玩家加入离开 / 对局开始结束），
 * 不参与实时状态同步。
 *
 * 归属规则：所有写操作都以**房间实例标识**（`instance_id` / `room_instance_id`）过滤。
 * 房间码可复用，但同码的不同生命周期实例标识不同，因此旧实例的迟到写入
 * 只会命中 0 行，不会覆盖、删除新实例的数据。
 */
export interface RoomRepository {
  /** 登记房间实例（原子；区分「接管已释放槽位」「新建」「槽位被占用」「同实例重复」）。 */
  recordRoomCreated(instanceId: string, room: RoomSnapshot): Promise<RegisterRoomResult>;
  /** 回写房间状态（按实例过滤）。 */
  recordRoomStatus(instanceId: string, room: RoomSnapshot): Promise<void>;
  /** 标记房间实例已结束 / 释放房间码槽位（幂等；按实例过滤）。 */
  markRoomEnded(instanceId: string, at: number): Promise<void>;
  /** 记录玩家加入（归属键包含实例标识）。 */
  recordPlayerJoined(
    instanceId: string,
    roomCode: string,
    player: PlayerSnapshot,
  ): Promise<void>;
  /** 记录玩家离开（按实例 + 玩家过滤）。 */
  recordPlayerLeft(instanceId: string, playerId: string, at: number): Promise<void>;
  /** 记录对局开始（归属键包含实例标识）。 */
  recordSessionStarted(
    instanceId: string,
    roomCode: string,
    gameId: string,
    sessionId: string,
    at: number,
  ): Promise<void>;
  /** 记录对局结束（按实例 + 对局过滤）。 */
  recordSessionEnded(
    instanceId: string,
    sessionId: string,
    at: number,
    result?: string | null,
  ): Promise<void>;
}

/** 玩家记录的归属键：`${房间实例标识}:${玩家标识}`。 */
export function playerRecordId(instanceId: string, playerId: string): string {
  return `${instanceId}:${playerId}`;
}

/** 依据房间实例 + 快照生成 rooms 行取值。 */
function roomValues(instanceId: string, room: RoomSnapshot) {
  return {
    id: room.roomCode,
    instanceId,
    gameId: room.gameId,
    status: room.phase satisfies GamePhase,
    hostPlayerId: room.hostPlayerId,
    minPlayers: room.minPlayers,
    maxPlayers: room.maxPlayers,
    playerCount: room.players.length,
    createdAt: room.createdAt,
    updatedAt: room.updatedAt,
    finishedAt: room.phase === 'FINISHED' ? room.updatedAt : null,
    endedAt: null,
  };
}

/** 判断是否为指定列的唯一约束冲突（SQLite 错误信息形如 `UNIQUE constraint failed: rooms.id`）。 */
function isUniqueViolation(error: unknown, column: string): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes('UNIQUE constraint failed') && message.includes(column);
}

/** 基于 D1 构造仓库。 */
export function createRoomRepository(database: D1Database): RoomRepository {
  const db = drizzle(database);

  return {
    async recordRoomCreated(instanceId, room) {
      const { id: roomCode, ...values } = roomValues(instanceId, room);

      // 1) 房间码槽位被**已结束**实例占用 → 由本实例原子接管。
      //    条件里带 `ended_at is not null`，绝不会覆盖仍在活动的实例。
      const takenOver = await db
        .update(rooms)
        .set(values)
        .where(and(eq(rooms.id, roomCode), isNotNull(rooms.endedAt)))
        .returning({ instanceId: rooms.instanceId });

      if (takenOver.length > 0) {
        return { ok: true, created: true };
      }

      // 2) 槽位仍被占用：区分「同一实例重复登记（幂等）」与「被其他活动实例占用」。
      //    这一步只用于**区分语义**，唯一性仍由数据库约束（主键 + 条件更新 + 唯一索引）保证。
      const occupant = await db
        .select({ instanceId: rooms.instanceId })
        .from(rooms)
        .where(eq(rooms.id, roomCode))
        .limit(1);

      const occupantId = occupant[0]?.instanceId;
      if (occupantId !== undefined) {
        return occupantId === instanceId
          ? { ok: true, created: false }
          : { ok: false, reason: 'CODE_IN_USE' };
      }

      // 3) 槽位不存在 → 原子新建；并发下被抢先则报房间码占用
      try {
        const inserted = await db
          .insert(rooms)
          .values({ id: roomCode, ...values })
          .onConflictDoNothing({ target: rooms.id })
          .returning({ instanceId: rooms.instanceId });

        return inserted.length > 0
          ? { ok: true, created: true }
          : { ok: false, reason: 'CODE_IN_USE' };
      } catch (error) {
        if (isUniqueViolation(error, 'instance_id')) {
          // 同一实例已登记（并发 / 重试）：幂等成功
          return { ok: true, created: false };
        }
        throw error;
      }
    },

    async recordRoomStatus(instanceId, room) {
      const values = roomValues(instanceId, room);
      await db
        .update(rooms)
        .set({
          status: values.status,
          playerCount: values.playerCount,
          hostPlayerId: values.hostPlayerId,
          updatedAt: values.updatedAt,
          finishedAt: values.finishedAt,
        })
        .where(eq(rooms.instanceId, instanceId));
    },

    async markRoomEnded(instanceId, at) {
      await db
        .update(rooms)
        .set({ endedAt: at, updatedAt: at })
        .where(and(eq(rooms.instanceId, instanceId), isNull(rooms.endedAt)));
    },

    async recordPlayerJoined(instanceId, roomCode, player) {
      await db
        .insert(roomPlayers)
        .values({
          id: playerRecordId(instanceId, player.playerId),
          roomInstanceId: instanceId,
          roomId: roomCode,
          playerId: player.playerId,
          nickname: player.nickname,
          isHost: player.isHost,
          joinedAt: player.joinedAt,
          leftAt: null,
        })
        .onConflictDoUpdate({
          target: roomPlayers.id,
          set: { nickname: player.nickname, isHost: player.isHost, leftAt: null },
        });
    },

    async recordPlayerLeft(instanceId, playerId, at) {
      await db
        .update(roomPlayers)
        .set({ leftAt: at })
        .where(
          and(eq(roomPlayers.roomInstanceId, instanceId), eq(roomPlayers.playerId, playerId)),
        );
    },

    async recordSessionStarted(instanceId, roomCode, gameId, sessionId, at) {
      await db
        .insert(gameSessions)
        .values({
          id: sessionId,
          roomInstanceId: instanceId,
          roomId: roomCode,
          gameId,
          startedAt: at,
          endedAt: null,
          result: null,
        })
        .onConflictDoNothing();
    },

    async recordSessionEnded(instanceId, sessionId, at, result = null) {
      await db
        .update(gameSessions)
        .set({ endedAt: at, result })
        .where(
          and(eq(gameSessions.id, sessionId), eq(gameSessions.roomInstanceId, instanceId)),
        );
    },
  };
}
