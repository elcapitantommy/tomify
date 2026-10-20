import { describe, expect, it } from 'vitest'
import { castElementState, castErrorMessage, castKind, type CastableElement } from './cast'

const element = (fields: Record<string, unknown>) => Object.assign(document.createElement('audio'), fields) as unknown as CastableElement

describe('casting', () => {
  it('uses AirPlay in Safari and Cast where the Remote Playback API exists', () => {
    expect(castKind(element({ webkitShowPlaybackTargetPicker: () => undefined }))).toBe('airplay')
    const withRemote = document.createElement('audio') as unknown as CastableElement
    Object.defineProperty(withRemote, 'remote', { value: { state: 'connected', prompt: async () => undefined } })
    expect(castKind(withRemote)).toBe('cast')
    expect(castElementState(withRemote, 'cast')).toBe('connected')
    expect(castKind(document.createElement('audio') as unknown as CastableElement)).toBeNull()
    expect(castKind(null)).toBeNull()
    expect(castElementState(element({ webkitCurrentPlaybackTargetIsWireless: true }), 'airplay')).toBe('connected')
  })

  it('explains failures and says nothing when the picker is just closed', () => {
    expect(castErrorMessage(new DOMException('x', 'NotFoundError'))).toBe('No speakers or TVs were found on this network.')
    expect(castErrorMessage(new DOMException('x', 'NotSupportedError'))).toBe('This song can’t be cast from this browser.')
    expect(castErrorMessage(new DOMException('x', 'AbortError'))).toBeNull()
    expect(castErrorMessage(new Error('boom'))).toBe('Casting didn’t start. Try again.')
  })
})
