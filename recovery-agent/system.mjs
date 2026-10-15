// Remote reboot of the media server, so a lost SSH route (for example a VPN
// misconfiguration) can be recovered from the Tomify site through its tunnel.
// It is off unless TOMIFY_RECOVERY_ALLOW_REBOOT=true, and the service account
// also needs a polkit rule allowing org.freedesktop.login1.reboot (docs/RECOVERY.md).

export const REBOOT_CONFIRMATION = 'reboot'
export const REBOOT_DELAY_MS = 3000

export function rebootConfig(env = process.env) {
  return {
    enabled: String(env.TOMIFY_RECOVERY_ALLOW_REBOOT || '').trim().toLowerCase() === 'true',
    systemctl: String(env.SYSTEMCTL_PATH || '').trim() || '/usr/bin/systemctl',
  }
}

// Validates the request, then schedules the reboot after the response has had time to reach the Worker.
export function scheduleReboot(body, { config, spawn, setTimer = setTimeout, delayMs = REBOOT_DELAY_MS }) {
  if (!config.enabled) throw new Error('Remote reboot is disabled on this server. Set TOMIFY_RECOVERY_ALLOW_REBOOT=true in /etc/tomify/recovery-agent.env to enable it.')
  if (body?.confirm !== REBOOT_CONFIRMATION) throw new Error('Remote reboot requires confirmation.')
  const scheduledAt = new Date(Date.now() + delayMs).toISOString()
  setTimer(() => {
    const child = spawn(config.systemctl, ['reboot'], { detached: true, stdio: 'ignore' })
    child.on?.('error', (error) => process.stderr.write(`Tomify recovery agent could not reboot: ${error.message}\n`))
    child.unref?.()
  }, delayMs)
  return { rebooting: true, scheduledAt }
}
