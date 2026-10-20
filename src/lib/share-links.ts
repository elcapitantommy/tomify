import { NavidromeError } from './navidrome'

export const EXPIRY_OPTIONS = [
  { value: 'day', label: '1 day', ms: 86_400_000 },
  { value: 'week', label: '1 week', ms: 7 * 86_400_000 },
  { value: 'month', label: '30 days', ms: 30 * 86_400_000 },
  { value: 'never', label: 'Never', ms: 0 },
] as const
export type Expiry = typeof EXPIRY_OPTIONS[number]['value']

export function expiryTime(expiry: Expiry, now = Date.now()) {
  const option = EXPIRY_OPTIONS.find((item) => item.value === expiry)
  return option && option.ms ? now + option.ms : undefined
}

// Navidrome answers share calls with an error while sharing is switched off in its configuration.
export function shareErrorMessage(error: unknown) {
  const text = error instanceof Error ? error.message : ''
  if (error instanceof NavidromeError && (error.code === 70 || error.code === 0 || error.code === 404 || error.code === 501 || /not (enabled|implemented|found)|disabled/i.test(text))) return 'Sharing links are switched off on the music server. An administrator can turn them on with ND_ENABLESHARING=true.'
  return text || 'The link could not be made.'
}

export function expiresLabel(expires: string | undefined, now = Date.now()) {
  if (!expires) return 'Never expires'
  const at = Date.parse(expires)
  if (!Number.isFinite(at) || at <= 0 || new Date(at).getUTCFullYear() < 2000) return 'Never expires'
  if (at < now) return 'Expired'
  return `Expires ${new Date(at).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })}`
}
