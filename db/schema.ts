// Canonical D1 schema fragments. The production worker creates these defensively;
// drizzle/0001_recovery.sql is the deployable migration.
export const recoverySchema = {
  items: 'recovery_items',
  candidates: 'recovery_candidates',
  indexes: ['idx_recovery_items_username_status', 'idx_recovery_candidates_recovery'],
} as const
