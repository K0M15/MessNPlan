DELETE h1 FROM `holidays` h1
JOIN `holidays` h2
  ON (h1.`project_id` <=> h2.`project_id`) AND h1.`date` = h2.`date` AND h1.`id` > h2.`id`;
--> statement-breakpoint
ALTER TABLE `holidays` ADD CONSTRAINT `holidays_project_date_uq` UNIQUE(`project_id`,`date`);