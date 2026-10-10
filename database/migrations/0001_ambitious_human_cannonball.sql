CREATE TABLE `game_sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`room_id` text NOT NULL,
	`game_id` text NOT NULL,
	`started_at` integer NOT NULL,
	`ended_at` integer,
	`result` text
);
--> statement-breakpoint
CREATE INDEX `game_sessions_room_idx` ON `game_sessions` (`room_id`);--> statement-breakpoint
CREATE TABLE `room_players` (
	`id` text PRIMARY KEY NOT NULL,
	`room_id` text NOT NULL,
	`player_id` text NOT NULL,
	`nickname` text NOT NULL,
	`is_host` integer DEFAULT false NOT NULL,
	`joined_at` integer NOT NULL,
	`left_at` integer
);
--> statement-breakpoint
CREATE INDEX `room_players_room_idx` ON `room_players` (`room_id`);--> statement-breakpoint
CREATE TABLE `rooms` (
	`id` text PRIMARY KEY NOT NULL,
	`game_id` text NOT NULL,
	`status` text NOT NULL,
	`host_player_id` text NOT NULL,
	`min_players` integer NOT NULL,
	`max_players` integer NOT NULL,
	`player_count` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`finished_at` integer
);
--> statement-breakpoint
CREATE INDEX `rooms_status_idx` ON `rooms` (`status`);