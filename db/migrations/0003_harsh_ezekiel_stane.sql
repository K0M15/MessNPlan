CREATE TABLE `absences` (
	`id` bigint unsigned AUTO_INCREMENT NOT NULL,
	`resource_id` bigint unsigned NOT NULL,
	`start_date` date NOT NULL,
	`end_date` date NOT NULL,
	`type` enum('vacation','sick','other') NOT NULL DEFAULT 'vacation',
	`name` varchar(160),
	`created_by` bigint unsigned,
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `absences_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
ALTER TABLE `absences` ADD CONSTRAINT `absences_resource_id_resources_id_fk` FOREIGN KEY (`resource_id`) REFERENCES `resources`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `absences` ADD CONSTRAINT `absences_created_by_users_id_fk` FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `absences_resource_start_idx` ON `absences` (`resource_id`,`start_date`);