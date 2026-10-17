import type { Env } from '../env.ts'

export class NavidromeConfigurationError extends Error {
  constructor() {
    super('NAVIDROME_ORIGIN must be configured as a valid https:// origin.')
    this.name = 'NavidromeConfigurationError'
  }
}

export function navidromeOrigin(env: Pick<Env, 'NAVIDROME_ORIGIN'>): string {
  const origin = String(env?.NAVIDROME_ORIGIN || '').trim().replace(/\/+$/, '')
  try {
    const parsed = new URL(origin)
    if (parsed.protocol !== 'https:' || !parsed.hostname || parsed.username || parsed.password || parsed.pathname !== '/' || parsed.search || parsed.hash) {
      throw new NavidromeConfigurationError()
    }
    return origin
  } catch (error) {
    if (error instanceof NavidromeConfigurationError) throw error
    throw new NavidromeConfigurationError()
  }
}

// Joins the origin and path as text, as the Worker always did. `new URL(path, origin)` would treat a
// proxied path such as `//evil.example/x` as another host and turn /navidrome into an open proxy.
export function navidromeUrl(env: Pick<Env, 'NAVIDROME_ORIGIN'>, path: string): URL {
  const origin = navidromeOrigin(env)
  const url = new URL(origin + (path.startsWith('/') ? path : '/' + path))
  if (url.origin !== new URL(origin).origin) throw new NavidromeConfigurationError()
  return url
}

export function isNavidromeConfigurationError(error: unknown): error is NavidromeConfigurationError {
  return error instanceof NavidromeConfigurationError
}
