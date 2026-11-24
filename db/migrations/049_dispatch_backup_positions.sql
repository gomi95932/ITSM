ALTER TABLE automatic_dispatch_policies ADD COLUMN backup_position_ids text[] NOT NULL DEFAULT '{}'
  CHECK(cardinality(backup_position_ids)<=20);
ALTER TABLE automatic_dispatch_attempts ADD COLUMN position_id text;
ALTER TABLE automatic_dispatch_policies ADD COLUMN backup_employee_ids text[] NOT NULL DEFAULT '{}'
  CHECK(cardinality(backup_employee_ids)<=50);
