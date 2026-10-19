// Short-lived media sessions (roadmap 3.5). After sign-in the player asks for a media token: the
// listener's Navidrome login sealed with TOMIFY_MEDIA_KEY, with an expiry. Media URLs then carry
// `mt=<token>` instead of the long-lived login. The Worker's /navidrome stream proxy and /api/hls,
// and the box's LAN listener (recovery-agent/lan.mjs), open it again. Without the key nothing changes.
import type { Env } from '../env.ts'
import { seal, unseal } from '../lib/seal.ts'

export const MEDIA_TOKEN_MS = 4 * 3600_000

export async function mediaToken(env: Env, login: string[], now = Date.now()) {
  const expiresAt = now + MEDIA_TOKEN_MS
  return { token: await seal(env.TOMIFY_MEDIA_KEY!, JSON.stringify([expiresAt, ...login])), expiresAt }
}

// [user, token, salt] from an unexpired media token; null for anything else.
export async function openMediaToken(env: Env, value: string | null): Promise<string[] | null> {
  if (!env.TOMIFY_MEDIA_KEY) return null
  try {
    const [expiresAt, ...login] = JSON.parse(await unseal(env.TOMIFY_MEDIA_KEY, value!))
    return expiresAt > Date.now() ? login : null
  } catch { return null }
}
