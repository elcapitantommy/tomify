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

export function navidromeUrl(env: Pick<Env, 'NAVIDROME_ORIGIN'>, path: string): URL {
  return new URL(path, navidromeOrigin(env) + '/')
}

export function isNavidromeConfigurationError(error: unknown): error is NavidromeConfigurationError {
  return error instanceof NavidromeConfigurationError
}
