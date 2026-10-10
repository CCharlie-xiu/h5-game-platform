import { sql } from 'drizzle-orm';
import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';

/**
 * 游戏登记表。
 *
 * 阶段 1 仅建立最小表结构，用于验证 D1 + Drizzle 的迁移链路是否可用。
 * 房间、玩家、对局记录等表在后续阶段补充。
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

export type GameRow = typeof games.$inferSelect;
export type NewGameRow = typeof games.$inferInsert;
