import type { Ai, D1Database, ExecutionContext, Fetcher } from '@cloudflare/workers-types'

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
  // Optional: the DJ's Deepgram Aura-2 voice (default ophelia, a cheerful, enthusiastic female voice).
  TOMIFY_DJ_VOICE?: string
  TOMIFY_DJ_VOICE_MODEL?: string
  // Optional: seals short-lived media tokens (/api/media-session); the box's agent needs the same value.
  TOMIFY_MEDIA_KEY?: string
  // Optional: the box's HTTPS address on the home network, for LAN-direct streaming.
  TOMIFY_LAN_ORIGIN?: string
  // Optional: a Navidrome account party guests search with. Without it they search as the host (needs TOMIFY_MEDIA_KEY).
  TOMIFY_PARTY_USERNAME?: string
  TOMIFY_PARTY_PASSWORD?: string
  // Optional: Tomifin Downloader's own hostname (a second custom domain on this Worker). Unset, it stays at /tomifin/.
  TOMIFIN_HOSTNAME?: string
}

// `ctx` lets a route finish work after answering (waitUntil).
export type RouteHandler = (request: Request, env: Env, url: URL, ctx?: Pick<ExecutionContext, 'waitUntil'>) => Promise<Response | null>
