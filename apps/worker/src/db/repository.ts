import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';

import type { GamePhase, PlayerSnapshot, RoomSnapshot } from '@h5/game-protocol';

import { gameSessions, roomPlayers, rooms } from './schema';

/**
 * D1 持久化仓库。
 *
 * 只写入**离散生命周期事件**（房间创建 / 玩家加入离开 / 对局开始结束），
 * 不参与实时状态同步。
 */
export interface RoomRepository {
  recordRoomCreated(room: RoomSnapshot): Promise<void>;
  recordRoomStatus(room: RoomSnapshot): Promise<void>;
  recordPlayerJoined(roomId: string, player: PlayerSnapshot): Promise<void>;
  recordPlayerLeft(roomId: string, playerId: string, at: number): Promise<void>;
  recordSessionStarted(
    roomId: string,
    gameId: string,
    sessionId: string,
    at: number,
  ): Promise<void>;
  recordSessionEnded(sessionId: string, at: number, result?: string | null): Promise<void>;
}

/** 依据房间快照创建 / 更新房间行。 */
function roomRow(room: RoomSnapshot) {
  return {
    id: room.roomId,
    gameId: room.gameId,
    status: room.phase satisfies GamePhase,
    hostPlayerId: room.hostPlayerId,
    minPlayers: room.minPlayers,
    maxPlayers: room.maxPlayers,
    playerCount: room.players.length,
    createdAt: room.createdAt,
    updatedAt: room.updatedAt,
    finishedAt: room.phase === 'FINISHED' ? room.updatedAt : null,
  };
}

/** 基于 D1 构造仓库。 */
export function createRoomRepository(database: D1Database): RoomRepository {
  const db = drizzle(database);

  return {
    async recordRoomCreated(room) {
      await db.insert(rooms).values(roomRow(room));
    },

    async recordRoomStatus(room) {
      const row = roomRow(room);
      await db
        .update(rooms)
        .set({
          status: row.status,
          playerCount: row.playerCount,
          hostPlayerId: row.hostPlayerId,
          updatedAt: row.updatedAt,
          finishedAt: row.finishedAt,
        })
        .where(eq(rooms.id, room.roomId));
    },

    async recordPlayerJoined(roomId, player) {
      const row = {
        id: `${roomId}:${player.playerId}`,
        roomId,
        playerId: player.playerId,
        nickname: player.nickname,
        isHost: player.isHost,
        joinedAt: player.joinedAt,
        leftAt: null,
      };
      await db
        .insert(roomPlayers)
        .values(row)
        .onConflictDoUpdate({
          target: roomPlayers.id,
          set: { nickname: row.nickname, isHost: row.isHost, leftAt: null },
        });
    },

    async recordPlayerLeft(roomId, playerId, at) {
      await db
        .update(roomPlayers)
        .set({ leftAt: at })
        .where(eq(roomPlayers.id, `${roomId}:${playerId}`));
    },

    async recordSessionStarted(roomId, gameId, sessionId, at) {
      await db
        .insert(gameSessions)
        .values({ id: sessionId, roomId, gameId, startedAt: at, endedAt: null, result: null })
        .onConflictDoNothing();
    },

    async recordSessionEnded(sessionId, at, result = null) {
      await db
        .update(gameSessions)
        .set({ endedAt: at, result })
        .where(eq(gameSessions.id, sessionId));
    },
  };
}
