import type { Ai, D1Database, Fetcher } from '@cloudflare/workers-types'

export interface Env {
  TOMIFY_DB: D1Database
  ASSETS: Fetcher
  NAVIDROME_ORIGIN?: string
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
  // Optional: lets Claude pick and name the "Made for you" mixes. Without it Tomify builds simpler mixes itself.
  ANTHROPIC_API_KEY?: string
  // Optional: the Claude model for mixes and the DJ (default claude-sonnet-5-5).
  TOMIFY_MIXES_MODEL?: string
  // Workers AI, used for the DJ's voice.
  AI?: Ai
  // Optional: the DJ's Deepgram Aura-2 voice (default draco, a British male voice).
  TOMIFY_DJ_VOICE?: string
}

export type RouteHandler = (request: Request, env: Env, url: URL) => Promise<Response | null>
