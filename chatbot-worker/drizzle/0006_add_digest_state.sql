CREATE TABLE `chat_digest_state` (
	`id` integer PRIMARY KEY NOT NULL,
	`last_sent_at` integer NOT NULL,
	`last_status` text
);
