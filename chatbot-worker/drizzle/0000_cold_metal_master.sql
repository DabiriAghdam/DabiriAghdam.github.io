CREATE TABLE `chat_rate_limits` (
	`visitor_hash` text PRIMARY KEY NOT NULL,
	`minute_window` integer NOT NULL,
	`minute_count` integer DEFAULT 0 NOT NULL,
	`day_window` integer NOT NULL,
	`day_count` integer DEFAULT 0 NOT NULL,
	`updated_at` integer NOT NULL
);
