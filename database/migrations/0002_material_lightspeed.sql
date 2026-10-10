-- 阶段 2.3：为房间 / 玩家 / 对局记录引入房间实例归属。
-- 语句顺序很重要：唯一索引必须在历史行回填之后创建，
-- 否则所有历史行共用默认值 '' 会导致索引创建失败。
ALTER TABLE `game_sessions` ADD `room_instance_id` text DEFAULT '' NOT NULL;--> statement-breakpoint
CREATE INDEX `game_sessions_instance_idx` ON `game_sessions` (`room_instance_id`);--> statement-breakpoint
ALTER TABLE `room_players` ADD `room_instance_id` text DEFAULT '' NOT NULL;--> statement-breakpoint
CREATE INDEX `room_players_instance_idx` ON `room_players` (`room_instance_id`);--> statement-breakpoint
ALTER TABLE `rooms` ADD `instance_id` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `rooms` ADD `ended_at` integer;--> statement-breakpoint
UPDATE `rooms` SET `instance_id` = 'legacy:' || `id` WHERE `instance_id` = '';--> statement-breakpoint
UPDATE `room_players` SET `room_instance_id` = 'legacy:' || `room_id` WHERE `room_instance_id` = '';--> statement-breakpoint
UPDATE `game_sessions` SET `room_instance_id` = 'legacy:' || `room_id` WHERE `room_instance_id` = '';--> statement-breakpoint
UPDATE `room_players` SET `id` = `room_instance_id` || ':' || `player_id`;--> statement-breakpoint
UPDATE `rooms` SET `ended_at` = `updated_at` WHERE `ended_at` IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX `rooms_instance_unique` ON `rooms` (`instance_id`);
