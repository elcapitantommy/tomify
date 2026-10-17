import { act, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ApiProvider } from '../lib/api-context'
import { useAuth } from '../stores/auth'
import { usePlayer } from '../stores/player'
import { useDj, djVoiceElement } from '../stores/dj'
import { PlayerRuntime } from './PlayerRuntime'
import { DjRuntime } from './DjPanel'
import { useStreamQuality } from '../stores/streamQuality'

const session = { serverUrl: 'https://music.example', username: 'tom', salt: 's', token: 't' }
const t = (id: string) => ({ id, title: id, artist: 'A' + id, album: 'X', duration: 200 })
const log: string[] = []
beforeEach(() => {
  log.length = 0
  useAuth.setState({ session, status: 'signed-in', error: null, isAdmin: false })
  useStreamQuality.setState({ quality: 'original' })
  usePlayer.setState({ queue: [t('x')], currentIndex: 0, playing: false, currentTime: 0, duration: 200, shuffle: false, repeat: 'off' })
  vi.spyOn(HTMLMediaElement.prototype, 'load').mockImplementation(() => {})
  vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(function (this: HTMLMediaElement) { const id = this === djVoiceElement() ? 'voice' : (this.src.match(/id=(\w+)/)?.[1] ?? '?'); log.push('pause ' + id); Object.defineProperty(this, 'paused', { configurable: true, value: true }); this.dispatchEvent(new Event('pause')) })
  vi.spyOn(HTMLMediaElement.prototype, 'play').mockImplementation(function (this: HTMLMediaElement) { const id = this === djVoiceElement() ? 'voice' : (this.src.match(/id=(\w+)/)?.[1] ?? '?'); log.push('play ' + id); Object.defineProperty(this, 'paused', { configurable: true, value: false }); this.dispatchEvent(new Event('play')); return Promise.resolve() })
  vi.stubGlobal('URL', Object.assign(URL, { createObjectURL: vi.fn(() => 'blob:voice'), revokeObjectURL: vi.fn() }))
  vi.stubGlobal('fetch', vi.fn(async (url: string | URL) => {
    const u = String(url)
    if (u.endsWith('/api/dj/segment')) return Response.json({ tracks: [t('a'), t('b'), t('c')], script: 'Hi', curatedBy: 'claude', voice: true })
    if (u.endsWith('/api/dj/voice')) return new Response(new Blob(['mp3']))
    return Response.json({ 'subsonic-response': { status: 'ok' } })
  }))
})
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals() })

describe('DJ with the real player', () => {
  it('keeps the first song silent until the DJ has spoken, then plays it once, and pause still works', async () => {
    await act(async () => { render(<ApiProvider><PlayerRuntime/><DjRuntime/></ApiProvider>) })
    await act(async () => { await useDj.getState().start() })
    expect(log).toEqual(['play voice', 'play voice'])

    await act(async () => { djVoiceElement()!.onended?.(new Event('ended')) })
    expect(log.slice(2)).toEqual(['play a'])
    expect(usePlayer.getState().playing).toBe(true)

    await act(async () => { usePlayer.getState().setPlaying(false) })
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)) })
    expect(log.slice(3)).toEqual(['pause a'])
    expect(usePlayer.getState().playing).toBe(false)
  })
})
