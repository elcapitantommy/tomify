import { isIP } from 'node:net'

const MINIMUM_RECOVERY_TOKEN_LENGTH = 32

export function isLoopbackHost(value) {
  const host = String(value || '').trim().toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '')
  return host === 'localhost' || host === '::1' || (isIP(host) === 4 && host.startsWith('127.'))
}

export function validateRecoveryAuthConfig(env = process.env) {
  const host = String(env.TOMIFY_RECOVERY_HOST || '127.0.0.1').trim() || '127.0.0.1'
  const token = String(env.TOMIFY_RECOVERY_TOKEN || '')
  const insecureLoopback = String(env.TOMIFY_RECOVERY_ALLOW_INSECURE_LOOPBACK || '').trim().toLowerCase() === 'true'

  if (token) {
    if (token.trim().length < MINIMUM_RECOVERY_TOKEN_LENGTH) throw new Error(`TOMIFY_RECOVERY_TOKEN must contain at least ${MINIMUM_RECOVERY_TOKEN_LENGTH} characters.`)
    return { host, token, insecureLoopback: false }
  }
  if (!insecureLoopback) throw new Error(`TOMIFY_RECOVERY_TOKEN is required and must contain at least ${MINIMUM_RECOVERY_TOKEN_LENGTH} characters.`)
  if (!isLoopbackHost(host)) throw new Error('TOMIFY_RECOVERY_ALLOW_INSECURE_LOOPBACK is permitted only when TOMIFY_RECOVERY_HOST is loopback.')
  return { host, token: '', insecureLoopback: true }
}
