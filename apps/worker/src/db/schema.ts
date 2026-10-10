import { sql } from 'drizzle-orm';
import { index, integer, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';

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
 * 房间元数据表。
 *
 * 数据模型（阶段 2.3 起）：
 * - `id` 是**房间码槽位**：一个房间码在同一时刻最多只有一个活动实例，
 *   由主键约束在数据库层保证。
 * - `instance_id` 是**房间实例标识**：一次房间生命周期的稳定唯一标识。
 *   房间码可复用，但同码的不同生命周期是不同的实例，`instance_id` 必然不同。
 * - `ended_at` 非空表示当前槽位已被释放（该实例已结束），可被新实例接管。
 *
 * 所有写入都以 `instance_id` 过滤，因此旧实例的迟到写入只会命中 0 行，
 * 不会覆盖新实例的数据。
 */
export const rooms = sqliteTable(
  'rooms',
  {
    /** 房间码（可复用；同一时刻最多一个活动实例） */
    id: text('id').primaryKey(),
    /** 占用该房间码槽位的房间实例标识 */
    instanceId: text('instance_id').notNull().default(''),
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
    /** 槽位释放时间；NULL 表示该房间码被某个活动实例占用 */
    endedAt: integer('ended_at'),
  },
  (table) => [
    index('rooms_status_idx').on(table.status),
    // 实例标识必须唯一：防止同一实例占用两个房间码槽位
    uniqueIndex('rooms_instance_unique').on(table.instanceId),
  ],
);

/**
 * 玩家参与记录。
 *
 * 主键 `id` 形如 `${房间实例标识}:${玩家标识}`：归属键包含实例标识，
 * 房间码被复用时新实例的玩家记录不会与旧实例的记录冲突，
 * 也不能只依赖可复用的房间码关联。
 */
export const roomPlayers = sqliteTable(
  'room_players',
  {
    /** `${房间实例标识}:${玩家标识}` */
    id: text('id').primaryKey(),
    /** 所属房间实例（归属键） */
    roomInstanceId: text('room_instance_id').notNull().default(''),
    /** 房间码（冗余保留，便于按业务标识检索；不参与归属判定） */
    roomId: text('room_id').notNull(),
    playerId: text('player_id').notNull(),
    nickname: text('nickname').notNull(),
    isHost: integer('is_host', { mode: 'boolean' }).notNull().default(false),
    joinedAt: integer('joined_at').notNull(),
    leftAt: integer('left_at'),
  },
  (table) => [
    index('room_players_instance_idx').on(table.roomInstanceId),
    index('room_players_room_idx').on(table.roomId),
  ],
);

/** 对局记录（每局一条），按房间实例归属。 */
export const gameSessions = sqliteTable(
  'game_sessions',
  {
    id: text('id').primaryKey(),
    /** 所属房间实例（归属键） */
    roomInstanceId: text('room_instance_id').notNull().default(''),
    roomId: text('room_id').notNull(),
    gameId: text('game_id').notNull(),
    startedAt: integer('started_at').notNull(),
    endedAt: integer('ended_at'),
    /** 结果 JSON；本阶段不实现胜负算法，通常为 null */
    result: text('result'),
  },
  (table) => [
    index('game_sessions_instance_idx').on(table.roomInstanceId),
    index('game_sessions_room_idx').on(table.roomId),
  ],
);

export type GameRow = typeof games.$inferSelect;
export type NewGameRow = typeof games.$inferInsert;

export type RoomRow = typeof rooms.$inferSelect;
export type NewRoomRow = typeof rooms.$inferInsert;

export type RoomPlayerRow = typeof roomPlayers.$inferSelect;
export type NewRoomPlayerRow = typeof roomPlayers.$inferInsert;

export type GameSessionRow = typeof gameSessions.$inferSelect;
export type NewGameSessionRow = typeof gameSessions.$inferInsert;
