-- Index names, brought into line with what the schema file says.
--
-- Not part of any feature. Several earlier migrations named their indexes by
-- hand and the schema's implicit names differ, so every `prisma migrate dev`
-- since has offered these renames as a side dish to whatever was actually
-- being changed — which is how an unrelated rename eventually rides into
-- production inside a migration nobody read to the end. Doing them once, in a
-- migration whose name says what it is, ends that.
--
-- A rename touches no rows and no data. `IF EXISTS` so a database that already
-- carries the new name (created after the schema changed) is not an error.

ALTER INDEX IF EXISTS "break_glass_grants_actor_expires_idx" RENAME TO "break_glass_grants_actor_id_expires_at_idx";
ALTER INDEX IF EXISTS "break_glass_grants_subject_created_idx" RENAME TO "break_glass_grants_subject_user_id_created_at_idx";
ALTER INDEX IF EXISTS "reconciliation_items_account_subject_created_idx" RENAME TO "reconciliation_items_account_id_subject_created_at_idx";
ALTER INDEX IF EXISTS "reconciliation_items_status_created_idx" RENAME TO "reconciliation_items_status_created_at_idx";
ALTER INDEX IF EXISTS "resolution_records_finding_decided_idx" RENAME TO "resolution_records_finding_id_decided_at_idx";
ALTER INDEX IF EXISTS "resolution_records_item_decided_idx" RENAME TO "resolution_records_item_id_decided_at_idx";
ALTER INDEX IF EXISTS "tenant_ip_rules_tenant_cidr_scope_key" RENAME TO "tenant_ip_rules_tenant_id_cidr_scope_key";
ALTER INDEX IF EXISTS "tenant_ip_rules_tenant_enabled_idx" RENAME TO "tenant_ip_rules_tenant_id_enabled_idx";
