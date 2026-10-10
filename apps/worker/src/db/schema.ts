import { sql } from 'drizzle-orm';
import { index, integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';

/**
 * 游戏登记表。
 *
 * 阶段 1 建立，用于登记平台支持的游戏。
 */
export const games = sqliteTable('games', {
  id: text('id').primaryKey(),
  slug: text('slug').notNull().unique(),
  name: text('name').notNull(),
  status: text('status').notNull().default('planned'),
  createdAt: integer('created_at')
    .notNull()
    .default(sql`(unixepoch())`),
});

/**
 * 房间元数据。
 *
 * 仅保存「需要跨房间生命周期持久化」的字段；
 * 房间的实时状态（玩家席位、准备状态）由 Durable Object 作为权威来源，
 * **不**在每次 WebSocket 消息时写入本表。
 */
export const rooms = sqliteTable(
  'rooms',
  {
    /** 房间码，同时作为房间标识 */
    id: text('id').primaryKey(),
    gameId: text('game_id').notNull(),
    /** 当前生命周期阶段（由服务端在关键节点回写） */
    status: text('status').notNull(),
    hostPlayerId: text('host_player_id').notNull(),
    minPlayers: integer('min_players').notNull(),
    maxPlayers: integer('max_players').notNull(),
    playerCount: integer('player_count').notNull().default(0),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
    finishedAt: integer('finished_at'),
  },
  (table) => [index('rooms_status_idx').on(table.status)],
);

/** 玩家参与记录。 */
export const roomPlayers = sqliteTable(
  'room_players',
  {
    /** `${roomId}:${playerId}` */
    id: text('id').primaryKey(),
    roomId: text('room_id').notNull(),
    playerId: text('player_id').notNull(),
    nickname: text('nickname').notNull(),
    isHost: integer('is_host', { mode: 'boolean' }).notNull().default(false),
    joinedAt: integer('joined_at').notNull(),
    leftAt: integer('left_at'),
  },
  (table) => [index('room_players_room_idx').on(table.roomId)],
);

/** 对局记录（每局一条）。 */
export const gameSessions = sqliteTable(
  'game_sessions',
  {
    id: text('id').primaryKey(),
    roomId: text('room_id').notNull(),
    gameId: text('game_id').notNull(),
    startedAt: integer('started_at').notNull(),
    endedAt: integer('ended_at'),
    /** 结果 JSON；本阶段不实现胜负算法，通常为 null */
    result: text('result'),
  },
  (table) => [index('game_sessions_room_idx').on(table.roomId)],
);

export type GameRow = typeof games.$inferSelect;
export type NewGameRow = typeof games.$inferInsert;

export type RoomRow = typeof rooms.$inferSelect;
export type NewRoomRow = typeof rooms.$inferInsert;

export type RoomPlayerRow = typeof roomPlayers.$inferSelect;
export type NewRoomPlayerRow = typeof roomPlayers.$inferInsert;

export type GameSessionRow = typeof gameSessions.$inferSelect;
export type NewGameSessionRow = typeof gameSessions.$inferInsert;
