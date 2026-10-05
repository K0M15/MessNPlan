CREATE TABLE `project_api_keys` (
	`id` bigint unsigned AUTO_INCREMENT NOT NULL,
	`project_id` bigint unsigned NOT NULL,
	`name` varchar(120) NOT NULL,
	`public_key` text NOT NULL,
	`key_type` enum('ssh-ed25519','ssh-rsa') NOT NULL,
	`fingerprint` varchar(160) NOT NULL,
	`expires_at` datetime(3),
	`is_active` boolean NOT NULL DEFAULT true,
	`last_used_at` datetime(3),
	`created_by` bigint unsigned,
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `project_api_keys_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
ALTER TABLE `project_api_keys` ADD CONSTRAINT `project_api_keys_project_id_projects_id_fk` FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `project_api_keys` ADD CONSTRAINT `project_api_keys_created_by_users_id_fk` FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `project_api_keys_project_idx` ON `project_api_keys` (`project_id`);