import { beforeEach, describe, expect, it } from 'vitest'
import { PLAYBACK_LOG_KEY, PLAYBACK_LOG_LIMIT, clearPlaybackLog, formatPlaybackLog, logPlayback, playbackLog } from './playbackLog'

describe('playback log', () => {
  beforeEach(() => clearPlaybackLog())

  it('keeps only the most recent entries', () => {
    for (let index = 0; index < PLAYBACK_LOG_LIMIT + 5; index += 1) logPlayback(`event ${index}`, undefined, index)
    const entries = playbackLog()
    expect(entries).toHaveLength(PLAYBACK_LOG_LIMIT)
    expect(entries[0].event).toBe('event 5')
  })

  it('formats entries as one line each with their detail', () => {
    const at = new Date(2026, 9, 26, 14, 5, 9).getTime()
    logPlayback('Ignored play', 'an audio device had just come or gone', at)
    logPlayback('Pause', undefined, at)
    expect(formatPlaybackLog(playbackLog())).toBe('14:05:09  Ignored play (an audio device had just come or gone)\n14:05:09  Pause')
  })

  it('ignores a damaged log', () => {
    localStorage.setItem(PLAYBACK_LOG_KEY, '{not json')
    expect(playbackLog()).toEqual([])
    logPlayback('Play')
    expect(playbackLog().map((entry) => entry.event)).toEqual(['Play'])
  })
})
