import { readFile } from 'node:fs/promises'

export const TOMIFY_AGENT_CONTRACT = 2

export function healthResponse(env = process.env, packageVersion = null) {
  const configured = String(env.TOMIFY_VERSION || '').trim()
  const packaged = String(packageVersion || '').trim()
  return { ok: true, version: configured || packaged || null }
}

export function agentStatusResponse(health, details = {}) {
  return { ...details, version: health?.version ?? null, contract: TOMIFY_AGENT_CONTRACT }
}

export async function recoveryAgentPackageVersion() {
  try {
    const packageJson = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
    return typeof packageJson.version === 'string' && packageJson.version.trim() ? packageJson.version.trim() : null
  } catch { return null }
}
