import type { D1Database, Fetcher } from '@cloudflare/workers-types'

export interface Env {
  TOMIFY_DB: D1Database
  ASSETS: Fetcher
  RECOVERY_AGENT_URL?: string
  RECOVERY_AGENT_TOKEN?: string
  SPOTIFY_CLIENT_ID?: string
  SPOTIFY_CLIENT_SECRET?: string
  SPOTIFY_REDIRECT_URI?: string
  SPOTIFY_TOKEN_ENCRYPTION_KEY?: string
  SPOTIFY_MARKET?: string
  APPLE_CATALOGUE_COUNTRY?: string
  APPLE_ARTWORK_EMBEDDING_ENABLED?: string
  SPOTIFY_ARTWORK_EMBEDDING_ENABLED?: string
}

export type RouteHandler = (request: Request, env: Env, url: URL) => Promise<Response | null>
