CREATE TABLE `chat_throttle_events` (
	`day_window` integer NOT NULL,
	`kind` text NOT NULL,
	`count` integer DEFAULT 0 NOT NULL,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`day_window`, `kind`)
);
