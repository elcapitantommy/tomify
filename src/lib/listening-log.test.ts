import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAuth } from '../stores/auth'
import { ListeningTracker, primaryGenre, sendListeningEvent } from './listening-log'

const track = { id: 't1', title: 'Dreams', artist: 'Fleetwood Mac', album: 'Rumours', albumId: 'al1', duration: 257 }
const session = { serverUrl: 'https://music.example', username: 'tom', salt: 'salt', token: 'token' }

function listen(tracker: ListeningTracker, seconds: number, from = 0) {
  for (let time = from; time <= from + seconds; time += 1) tracker.progress(time, 257, true)
}

describe('ListeningTracker', () => {
  it('counts a finished track as completed, not skipped', () => {
    const tracker = new ListeningTracker(() => 1000)
    tracker.begin(track); listen(tracker, 256)
    expect(tracker.finish(true, 'Mac')).toEqual(expect.objectContaining({ trackId: 't1', listenedSeconds: 256, completed: true, skipped: false, playedAt: 1000, durationSeconds: 257, device: 'Mac' }))
    expect(tracker.trackId).toBeUndefined()
  })

  it('counts moving on early as a skip and ignores a flick past the track', () => {
    const tracker = new ListeningTracker()
    tracker.begin(track); listen(tracker, 12)
    expect(tracker.finish(false)).toEqual(expect.objectContaining({ skipped: true, completed: false, listenedSeconds: 12 }))
    tracker.begin(track); listen(tracker, 3)
    expect(tracker.finish(false)).toBeNull()
  })

  it('does not count seeking or paused time as listening', () => {
    const tracker = new ListeningTracker()
    tracker.begin(track); listen(tracker, 10)
    tracker.progress(200, 257, true)
    tracker.progress(201, 257, false)
    tracker.progress(202, 257, true)
    listen(tracker, 40, 203)
    expect(tracker.finish(false)?.listenedSeconds).toBe(52)
  })
})

describe('primaryGenre', () => {
  it('uses the first genre so plays can be grouped by genre', () => {
    expect(primaryGenre({ ...track, genres: [{ name: 'Soft Rock' }, { name: 'Pop' }], genre: 'Pop' })).toBe('Soft Rock')
    expect(primaryGenre({ ...track, genre: 'Rock; Jazz' })).toBe('Rock')
    expect(primaryGenre(track)).toBeUndefined()
  })

  it('is sent with each play', () => {
    const tracker = new ListeningTracker()
    tracker.begin({ ...track, genre: 'Rock' }); listen(tracker, 60)
    expect(tracker.finish(false)?.genre).toBe('Rock')
  })
})

describe('sendListeningEvent', () => {
  beforeEach(() => { localStorage.clear(); useAuth.setState({ session }) })
  afterEach(() => { useAuth.setState({ session: null }) })
  const event = { trackId: 't1', title: 'Dreams', artist: 'Fleetwood Mac', album: 'Rumours', listenedSeconds: 60, completed: false, skipped: false, playedAt: 1 }

  it('posts plays with the account headers and keeps them for later when the server is down', async () => {
    const down = vi.fn().mockResolvedValue(new Response('{}', { status: 503 }))
    await sendListeningEvent(event, down)
    expect(down).toHaveBeenCalledWith('/api/listening', expect.objectContaining({ method: 'POST', headers: expect.objectContaining({ 'x-tomify-user': 'tom' }) }))
    expect(JSON.parse(localStorage.getItem('tomify.listening.pending') ?? '[]')).toHaveLength(1)

    const up = vi.fn().mockResolvedValue(new Response('{"recorded":2}', { status: 200 }))
    await sendListeningEvent({ ...event, trackId: 't2' }, up)
    expect(JSON.parse(String(up.mock.calls[0][1].body)).events.map((sent: { trackId: string }) => sent.trackId)).toEqual(['t1', 't2'])
    expect(localStorage.getItem('tomify.listening.pending')).toBeNull()
  })
})
