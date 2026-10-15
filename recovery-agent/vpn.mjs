// NordVPN status and connect/disconnect for the Settings page. Off unless
// TOMIFY_RECOVERY_ALLOW_VPN_CONTROL=true, and the service account must be in the
// `nordvpn` group so the CLI can reach nordvpnd (docs/RECOVERY.md).
//
// Tom reaches the box over Tailscale and the site reaches this agent over a
// Cloudflare tunnel, so a change must never cut either. Both survive a connect
// or disconnect only while NordVPN's firewall and kill switch are off (a kill
// switch blocks all traffic after a disconnect; the firewall drops tailscaled),
// so every change is refused unless both read as disabled.

export const VPN_ACTIONS = ['connect', 'disconnect']
const TARGET_PATTERN = /^[A-Za-z0-9_]{1,64}$/

export function vpnConfig(env = process.env) {
  return {
    enabled: String(env.TOMIFY_RECOVERY_ALLOW_VPN_CONTROL || '').trim().toLowerCase() === 'true',
    nordvpn: String(env.NORDVPN_PATH || '').trim() || '/usr/bin/nordvpn',
    target: String(env.TOMIFY_VPN_CONNECT_TARGET || '').trim() || 'United_Kingdom',
  }
}

// The CLI draws a spinner with carriage returns and may colour its output; keep what is left on each line.
function cleanLines(text) {
  return String(text || '')
    .replace(/\u001b\[[0-9;]*[A-Za-z]/g, '')
    .split(/\n/)
    .map((line) => line.slice(line.lastIndexOf('\r') + 1).replace(/^[\s\-\\|/]+/, '').trim())
    .filter(Boolean)
}

function fields(text) {
  const result = {}
  for (const line of cleanLines(text)) {
    const match = line.match(/^([^:]+):\s*(.*)$/)
    if (match) result[match[1].trim().toLowerCase().replace(/[\s_-]+/g, '')] = match[2].trim()
  }
  return result
}

function onOff(value) {
  if (value === undefined) return null
  const normalised = value.toLowerCase()
  if (['enabled', 'on', 'true'].includes(normalised)) return true
  if (['disabled', 'off', 'false'].includes(normalised)) return false
  return null
}

export function parseNordStatus(text) {
  const values = fields(text)
  const status = (values.status || '').toLowerCase()
  const state = status === 'connected' ? 'connected' : status === 'disconnected' ? 'disconnected' : status === 'connecting' ? 'connecting' : 'unknown'
  return {
    state,
    server: values.server || values.hostname || null,
    country: values.country || null,
    city: values.city || null,
    ip: values.ip || null,
    technology: values.currenttechnology || values.technology || null,
    uptime: values.uptime || null,
  }
}

export function parseNordSettings(text) {
  const values = fields(text)
  return { firewall: onOff(values.firewall), killSwitch: onOff(values.killswitch), autoConnect: onOff(values.autoconnect) }
}

// Unknown counts as unsafe: a CLI that stops printing these lines must not be trusted blindly.
export function vpnSafetyProblem(settings) {
  if (settings.firewall !== false) return 'NordVPN\'s firewall is not off, so changing the VPN could cut Tailscale. Run `nordvpn set firewall off` on the server first.'
  if (settings.killSwitch !== false) return 'NordVPN\'s kill switch is not off, so changing the VPN could cut the server off the internet. Run `nordvpn set killswitch off` on the server first.'
  return null
}

export function createVpnController({ config, run }) {
  let busy = false

  async function readSettings() { return parseNordSettings((await run(config.nordvpn, ['settings'])).stdout) }

  async function status() {
    if (!config.enabled) return { control: 'disabled', state: 'unknown' }
    try {
      const [current, settings] = await Promise.all([run(config.nordvpn, ['status']), readSettings()])
      return { control: 'enabled', ...parseNordStatus(current.stdout), target: config.target, firewall: settings.firewall, killSwitch: settings.killSwitch, autoConnect: settings.autoConnect, busy }
    } catch (error) {
      return { control: 'enabled', state: 'unavailable', message: error instanceof Error ? error.message : 'NordVPN did not answer.', busy }
    }
  }

  async function change(action) {
    if (!config.enabled) throw new Error('VPN control is disabled on this server. Set TOMIFY_RECOVERY_ALLOW_VPN_CONTROL=true in /etc/tomify/recovery-agent.env to enable it.')
    if (!VPN_ACTIONS.includes(action)) throw new Error('Choose connect or disconnect.')
    if (action === 'connect' && !TARGET_PATTERN.test(config.target)) throw new Error('TOMIFY_VPN_CONNECT_TARGET must be a NordVPN country, city or group name such as United_Kingdom.')
    if (busy) throw new Error('A VPN change is already in progress.')
    busy = true
    try {
      const problem = vpnSafetyProblem(await readSettings())
      if (problem) throw new Error(problem)
      await run(config.nordvpn, action === 'connect' ? ['connect', config.target] : ['disconnect'])
    } finally {
      busy = false
    }
    return status()
  }

  return { status, change }
}
