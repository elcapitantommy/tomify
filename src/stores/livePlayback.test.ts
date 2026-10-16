import { beforeEach, describe, expect, it } from 'vitest'
import {
  activeRemoteSession,
  deviceNameFromUserAgent,
  latestCommandRevision,
  nextPollDelay,
  optimisticFields,
  pendingCommands,
  useLivePlayback,
  type LivePlaybackCommand,
  type LivePlaybackSnapshot,
} from './livePlayback'

const NOW = 1_000_000_000
const track = { id: 't1', title: 'Birdhouse in Your Soul', artist: 'They Might Be Giants', album: 'Flood', duration: 200 }

function snapshot(overrides: Partial<LivePlaybackSnapshot> = {}): LivePlaybackSnapshot {
  return { deviceId: 'desktop', deviceName: 'Windows · Chrome', queue: [track], currentIndex: 0, playing: true, currentTime: 30, duration: 200, volume: 0.8, muted: false, shuffle: false, repeat: 'off', updatedAt: NOW - 5000, revision: 7, ...overrides }
}
const online = [{ deviceId: 'desktop', deviceName: 'Windows · Chrome', lastSeen: NOW - 2000 }]

describe('which other device to show', () => {
  it('shows a device that is open and playing', () => {
    expect(activeRemoteSession(snapshot(), online, NOW, 'phone')?.deviceId).toBe('desktop')
  })

  it('never shows this device as remote', () => {
    expect(activeRemoteSession(snapshot(), online, NOW, 'desktop')).toBeNull()
  })

  it('keeps a paused device in control for a minute, then lets this device play on its own', () => {
    expect(activeRemoteSession(snapshot({ playing: false, updatedAt: NOW - 30_000 }), online, NOW, 'phone')).not.toBeNull()
    expect(activeRemoteSession(snapshot({ playing: false, updatedAt: NOW - 90_000 }), online, NOW, 'phone')).toBeNull()
  })

  it('drops a paused device once it is closed', () => {
    expect(activeRemoteSession(snapshot({ playing: false, updatedAt: NOW - 1000 }), [], NOW, 'phone')).toBeNull()
  })

  it('trusts a playing device that went quiet (a backgrounded iPhone) until its track would have ended', () => {
    expect(activeRemoteSession(snapshot({ updatedAt: NOW - 60_000 }), [], NOW, 'desktop-2')).not.toBeNull()
    expect(activeRemoteSession(snapshot({ updatedAt: NOW - 200_000 }), [], NOW, 'desktop-2')).toBeNull()
  })
})

describe('remote commands', () => {
  const command = (revision: number, overrides: Partial<LivePlaybackCommand> = {}): LivePlaybackCommand => ({ revision, action: 'next', targetDeviceId: 'phone', updatedAt: NOW - 1000, ...overrides })

  it('delivers every new command for this device in order, so two quick skips are both applied', () => {
    const response = { state: null, command: command(5), commands: [command(5), command(3), command(4), command(2, { targetDeviceId: 'desktop' })] }
    expect(pendingCommands(response, 2, NOW, 'phone').map((item) => item.revision)).toEqual([3, 4, 5])
    expect(latestCommandRevision(response)).toBe(5)
  })

  it('drops commands that arrive too late to act on', () => {
    const response = { state: null, command: null, commands: [command(4, { updatedAt: NOW - 60_000 })] }
    expect(pendingCommands(response, 0, NOW, 'phone')).toEqual([])
  })

  it('still reads the single command an older Worker returns', () => {
    expect(pendingCommands({ state: null, command: command(9) }, 8, NOW, 'phone')).toHaveLength(1)
  })
})

describe('how often to check', () => {
  const idle = { hidden: false, playingHere: false, remoteActive: false, remotePlaying: false, burst: false, idleRounds: 0 }

  it('keeps checking in a background tab while this device is playing, so it still hears pause from the phone', () => {
    expect(nextPollDelay({ ...idle, hidden: true, playingHere: true })).toBe(2000)
  })

  it('checks rarely in a hidden tab that is not playing', () => {
    expect(nextPollDelay({ ...idle, hidden: true })).toBe(20_000)
  })

  it('checks quickly after a change and backs off to ten seconds when nothing happens', () => {
    expect(nextPollDelay({ ...idle, burst: true })).toBe(1000)
    expect(nextPollDelay({ ...idle, remotePlaying: true, remoteActive: true })).toBe(1500)
    expect(nextPollDelay(idle)).toBe(2000)
    expect(nextPollDelay({ ...idle, idleRounds: 3 })).toBe(6750)
    expect(nextPollDelay({ ...idle, idleRounds: 20 })).toBe(10_000)
  })
})

describe('instant feedback for remote controls', () => {
  beforeEach(() => useLivePlayback.setState({ snapshot: null, optimistic: null, devices: [], serverOffset: 0 }))

  it('predicts what play, pause and seek do', () => {
    expect(optimisticFields(snapshot(), 'pause', NOW)).toEqual({ playing: false, currentTime: 35, updatedAt: NOW })
    expect(optimisticFields(snapshot(), 'seek', NOW, 120)).toEqual({ currentTime: 120, updatedAt: NOW })
    expect(optimisticFields(snapshot(), 'add-to-queue', NOW, undefined, { ...track, id: 't2' })?.queue).toHaveLength(2)
    expect(optimisticFields(snapshot(), 'next', NOW)).toBeNull()
  })

  it('keeps the predicted state until the other device reports back', () => {
    const state = useLivePlayback.getState()
    state.applyServer({ state: snapshot({ updatedAt: Date.now() }), command: null })
    state.applyOptimistic({ playing: false })
    useLivePlayback.getState().applyServer({ state: snapshot({ updatedAt: Date.now() }), command: null })
    expect(useLivePlayback.getState().snapshot?.playing).toBe(false)
    useLivePlayback.getState().applyServer({ state: snapshot({ revision: 8, playing: false, updatedAt: Date.now() }), command: null })
    expect(useLivePlayback.getState().optimistic).toBeNull()
  })
})

describe('device names', () => {
  it('names the platform, browser and the installed app', () => {
    expect(deviceNameFromUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36')).toBe('Windows · Chrome')
    expect(deviceNameFromUserAgent('Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1', true)).toBe('iPhone app')
  })
})
