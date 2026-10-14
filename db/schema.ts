// Canonical D1 schema fragments. The production worker creates these defensively;
// drizzle/ contains the deployable recovery migrations.
export const recoverySchema = {
  items: 'recovery_items',
  candidates: 'recovery_candidates',
  indexes: ['idx_recovery_items_username_status', 'idx_recovery_candidates_recovery'],
} as const

export const catalogueImportSchema = {
  playlists: 'catalogue_playlists',
  items: 'catalogue_playlist_items',
  providerTokens: 'catalogue_provider_tokens',
} as const
