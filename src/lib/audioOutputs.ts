// Headphones, a car or a speaker connecting or dropping out shows up as a 'devicechange' event.
// When Bluetooth headphones disconnect, Android often sends a "play" to the media session at the
// same moment, exactly as if the listener had pressed play, and the music comes back out of the
// phone's speaker. A play that close to a device change is taken as that, not as the listener.
export const OUTPUT_CHANGE_GUARD_MS = 4000

export type AudioOutputWatcher = {
  // True while a device change happened in the last OUTPUT_CHANGE_GUARD_MS.
  changedRecently(now?: number): boolean
  stop(): void
}

type Devices = Pick<MediaDevices, 'addEventListener' | 'removeEventListener'> & Partial<Pick<MediaDevices, 'enumerateDevices'>>

function mediaDevices(): Devices | undefined {
  if (typeof navigator === 'undefined') return undefined
  const devices = (navigator as { mediaDevices?: Devices }).mediaDevices
  return devices && typeof devices.addEventListener === 'function' ? devices : undefined
}

// Ids of the audio devices the browser shows. Without microphone permission they are blank,
// so a removal can only be told apart from an addition when the ids are known.
async function audioDeviceIds(devices: Devices): Promise<Set<string> | null> {
  if (!devices.enumerateDevices) return null
  try {
    const list = await devices.enumerateDevices()
    const ids = list.filter((device) => device.kind !== 'videoinput').map((device) => `${device.kind}:${device.deviceId}`)
    return ids.every((id) => !id.endsWith(':')) ? new Set(ids) : null
  } catch {
    return null
  }
}

// onChange runs on every device change; `removed` is true only when a device is known to have gone.
export function watchAudioOutputs(onChange: (removed: boolean) => void): AudioOutputWatcher {
  const devices = mediaDevices()
  let lastChangeAt = -Infinity
  let known: Set<string> | null = null
  let stopped = false
  if (!devices) return { changedRecently: () => false, stop: () => undefined }

  void audioDeviceIds(devices).then((ids) => { if (!stopped) known = ids })

  const changed = () => {
    lastChangeAt = Date.now()
    const before = known
    onChange(false)
    void audioDeviceIds(devices).then((ids) => {
      if (stopped) return
      known = ids
      if (before && ids && [...before].some((id) => !ids.has(id))) onChange(true)
    })
  }
  devices.addEventListener('devicechange', changed)

  return {
    changedRecently: (now = Date.now()) => now - lastChangeAt < OUTPUT_CHANGE_GUARD_MS,
    stop: () => {
      stopped = true
      devices.removeEventListener('devicechange', changed)
    },
  }
}
