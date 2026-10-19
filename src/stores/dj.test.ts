import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAuth } from './auth'
import { usePlayer } from './player'
import { bindDj, djVoiceElement, DJ_SPEECH_TIMEOUT_MS, fetchHeard, musicLoudness, speechLoudness, voiceGain, DJ_UNTAGGED_LUFS, DJ_VOICE_LIFT_DB, fetchVoice, useDj } from './dj'

const session = { serverUrl: 'https://music.example', username: 'tom', salt: 's', token: 't' }
const track = (id: string) => ({ id, title: `Song ${id}`, artist: `Artist ${id}`, album: 'Album' })
const json = (body: object, status = 200) => new Response(JSON.stringify(body), { status })

describe('Tomify DJ', () => {
  let unbind: () => void
  let play: ReturnType<typeof vi.spyOn>
  beforeEach(() => {
    useAuth.setState({ session })
    usePlayer.setState({ queue: [], currentIndex: -1, playing: false, shuffle: true })
    useDj.setState({ active: false, loading: false, speaking: false, voiceNote: null, script: null, error: null, request: null, pending: null, trackIds: [] })
    play = vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue(undefined)
    vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => undefined)
    vi.stubGlobal('URL', Object.assign(URL, { createObjectURL: vi.fn(() => 'blob:voice'), revokeObjectURL: vi.fn() }))
    unbind = bindDj()
  })
  afterEach(() => { unbind(); vi.restoreAllMocks(); vi.unstubAllGlobals() })

  it('holds the first song while the DJ talks, then plays it', async () => {
    const fetcher = vi.fn<typeof fetch>(async (input) => String(input).endsWith('/voice')
      ? new Response(new Blob(['mp3']), { status: 200 })
      : json({ tracks: [track('a'), track('b'), track('c')], script: 'Morning Tom.', curatedBy: 'claude', voice: true }))
    vi.stubGlobal('fetch', fetcher)
    await useDj.getState().start()

    expect(usePlayer.getState().queue.map((item) => item.id)).toEqual(['a', 'b', 'c'])
    expect(usePlayer.getState().shuffle).toBe(false)
    expect(useDj.getState()).toEqual(expect.objectContaining({ active: true, speaking: true, script: 'Morning Tom.', pending: null }))
    expect(usePlayer.getState().playing).toBe(false)
    expect(djVoiceElement()?.src).toBe('blob:voice')
    expect(JSON.parse(String(fetcher.mock.calls[0][1]?.body))).toEqual({ recentTrackIds: [], recentArtists: [], request: null, first: true })

    djVoiceElement()?.onended?.(new Event('ended'))
    expect(useDj.getState().speaking).toBe(false)
    expect(usePlayer.getState().playing).toBe(true)
    expect(play).toHaveBeenCalled()
  })

  it('fetches the next set near the end of the current one and stops when something else is played', async () => {
    const fetcher = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body))
      return json(body.first ? { tracks: [track('a'), track('b')], script: '', curatedBy: 'tomify', voice: false } : { tracks: [track('d'), track('e')], script: 'Next up.', curatedBy: 'tomify', voice: false })
    })
    vi.stubGlobal('fetch', fetcher)
    await useDj.getState().start()
    expect(usePlayer.getState().playing).toBe(true)
    await vi.waitFor(() => expect(usePlayer.getState().queue.map((item) => item.id)).toEqual(['a', 'b', 'd', 'e']))
    expect(JSON.parse(String(fetcher.mock.calls[1][1]?.body))).toEqual(expect.objectContaining({ recentTrackIds: ['a', 'b'], recentArtists: ['Artist a', 'Artist b'] }))

    usePlayer.getState().playTracks([track('z')])
    expect(useDj.getState().active).toBe(false)
  })

  it('starts while something else is already in the player', async () => {
    usePlayer.setState({ queue: [track('x')], currentIndex: 0, playing: true })
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => String(input).endsWith('/voice')
      ? new Response(new Blob(['mp3']), { status: 200 })
      : json({ tracks: [track('a'), track('b'), track('c')], script: 'Evening Tom.', curatedBy: 'claude', voice: true })))
    const starting = useDj.getState().start()
    usePlayer.getState().setProgress(12, 200)
    await starting

    expect(usePlayer.getState().queue.map((item) => item.id)).toEqual(['a', 'b', 'c'])
    expect(useDj.getState()).toEqual(expect.objectContaining({ active: true, speaking: true, script: 'Evening Tom.' }))
    expect(usePlayer.getState().playing).toBe(false)
  })

  it('reports a failed start without leaving the DJ on', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json({ message: 'The DJ couldn\'t pick the next songs: Navidrome is down.' }, 502)))
    await useDj.getState().start()
    expect(useDj.getState()).toEqual(expect.objectContaining({ active: false, error: 'The DJ couldn\'t pick the next songs: Navidrome is down.' }))
  })
  it('answers a spoken request straight away: the new set starts with the DJ\'s reply', async () => {
    const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).endsWith('/voice')) return new Response(new Blob(['mp3']))
      const body = JSON.parse(String(init?.body))
      return body.request ? json({ tracks: [track('u'), track('v'), track('w')], script: 'Upbeat it is!', curatedBy: 'claude', voice: true }) : json({ tracks: [track('a'), track('b'), track('c')], script: 'Morning Tom.', curatedBy: 'claude', voice: true })
    })
    vi.stubGlobal('fetch', fetcher)
    await useDj.getState().start()
    djVoiceElement()?.onended?.(new Event('ended'))

    expect(await useDj.getState().steer('something upbeat', { now: true })).toBe(true)
    expect(JSON.parse(String(fetcher.mock.calls.at(-2)?.[1]?.body))).toEqual(expect.objectContaining({ request: 'something upbeat', justAsked: true }))
    expect(usePlayer.getState().queue.map((item) => item.id)).toEqual(['a', 'u', 'v', 'w'])
    expect(usePlayer.getState().currentIndex).toBe(1)
    expect(useDj.getState()).toEqual(expect.objectContaining({ speaking: true, script: 'Upbeat it is!', pending: null }))
    djVoiceElement()?.onended?.(new Event('ended'))
    expect(usePlayer.getState().playing).toBe(true)
  })

  it('hears a recording through the server when the browser cannot', async () => {
    const fetcher = vi.fn<typeof fetch>(async () => json({ text: 'Something calmer' }))
    expect(await fetchHeard(new Blob(['audio'], { type: 'audio/mp4' }), fetcher)).toBe('Something calmer')
    expect(fetcher.mock.calls[0][0]).toBe('/api/dj/listen')
    expect(fetcher.mock.calls[0][1]?.headers).toEqual(expect.objectContaining({ 'content-type': 'audio/mp4', 'x-tomify-user': 'tom' }))
    await expect(fetchHeard(new Blob(['a']), async () => json({ message: 'Cloudflare\'s free daily allowance for the DJ\'s hearing is used up.' }, 502))).rejects.toThrow('the DJ\'s hearing')
  })

  describe('making sure the link is spoken', () => {
    class Utterance { onend: (() => void) | null = null; onerror: (() => void) | null = null; lang = ''; constructor(public text: string) {} }
    let spoken: Utterance[]
    const segment = json.bind(null, { tracks: [track('a'), track('b'), track('c')], script: 'Morning Tom.', curatedBy: 'claude', voice: true })
    beforeEach(() => {
      spoken = []
      vi.stubGlobal('SpeechSynthesisUtterance', Utterance)
      vi.stubGlobal('speechSynthesis', { speak: vi.fn((utterance: Utterance) => spoken.push(utterance)), cancel: vi.fn() })
    })
    const said = () => spoken.filter((utterance) => utterance.text).map((utterance) => utterance.text)

    it('tries the voice again when the first request fails', async () => {
      let calls = 0
      const url = await fetchVoice('Hello.', vi.fn(async () => ++calls === 1 ? new Response('busy', { status: 502 }) : new Response(new Blob(['mp3']))))
      expect(url).toBe('blob:voice')
      expect(calls).toBe(2)
    })

    it('reads the link out with the browser voice when the recording will not play', async () => {
      play.mockRejectedValue(Object.assign(new Error('blocked'), { name: 'NotAllowedError' }))
      vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => String(input).endsWith('/voice') ? new Response(new Blob(['mp3'])) : segment()))
      await useDj.getState().start()

      await vi.waitFor(() => expect(said()).toEqual(['Morning Tom.']))
      expect(useDj.getState().speaking).toBe(true)
      expect(usePlayer.getState().playing).toBe(false)
      spoken.at(-1)?.onend?.()
      expect(useDj.getState().speaking).toBe(false)
      expect(usePlayer.getState().playing).toBe(true)
    })

    it('says why the phone voice stood in', async () => {
      vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => String(input).endsWith('/voice') ? json({ message: 'The DJ voice failed: 4006: daily free allocation used up' }, 502) : segment()))
      await useDj.getState().start()
      await vi.waitFor(() => expect(said()).toEqual(['Morning Tom.']))
      expect(useDj.getState().voiceNote).toBe('Your phone\'s voice read this one. The DJ voice failed: 4006: daily free allocation used up')
    })

    it('says when the server\'s backup voice read the link', async () => {
      const backup = () => new Response(new Blob(['mp3']), { headers: { 'x-tomify-voice': 'backup', 'x-tomify-voice-problem': encodeURIComponent('Cloudflare\'s free daily allowance for the DJ voice is used up.') } })
      vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => String(input).endsWith('/voice') ? backup() : segment()))
      await useDj.getState().start()
      await vi.waitFor(() => expect(djVoiceElement()?.src).toBe('blob:voice'))
      expect(useDj.getState().voiceNote).toBe('The backup voice read this one. Cloudflare\'s free daily allowance for the DJ voice is used up.')
      expect(said()).toEqual([])
    })

    it('reads the link out with the browser voice when the recorded voice is unavailable', async () => {
      const fetcher = vi.fn(async (input: RequestInfo | URL) => String(input).endsWith('/voice') ? new Response('down', { status: 502 }) : segment())
      vi.stubGlobal('fetch', fetcher)
      await useDj.getState().start()

      await vi.waitFor(() => expect(said()).toEqual(['Morning Tom.']))
      // Two tries while the set was picked, two more when the link came up.
      expect(fetcher.mock.calls.filter(([input]) => String(input).endsWith('/voice'))).toHaveLength(4)
      expect(usePlayer.getState().playing).toBe(false)
      spoken.at(-1)?.onend?.()
      expect(usePlayer.getState().playing).toBe(true)
    })

    it('never holds the music for good if the speech never reports back', async () => {
      vi.useFakeTimers()
      try {
        play.mockRejectedValue(new Error('blocked'))
        vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => String(input).endsWith('/voice') ? new Response(new Blob(['mp3'])) : segment()))
        await useDj.getState().start()
        await vi.waitFor(() => expect(said()).toEqual(['Morning Tom.']))
        expect(usePlayer.getState().playing).toBe(false)
        vi.advanceTimersByTime(DJ_SPEECH_TIMEOUT_MS)
        expect(useDj.getState().speaking).toBe(false)
        expect(usePlayer.getState().playing).toBe(true)
      } finally {
        vi.useRealTimers()
      }
    })

    it('stops the browser voice when the DJ is stopped', async () => {
      play.mockRejectedValue(new Error('blocked'))
      vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => String(input).endsWith('/voice') ? new Response(new Blob(['mp3'])) : segment()))
      await useDj.getState().start()
      await vi.waitFor(() => expect(said()).toEqual(['Morning Tom.']))
      useDj.getState().stop()
      expect(speechSynthesis.cancel).toHaveBeenCalled()
      expect(usePlayer.getState().playing).toBe(true)
    })
  })
  describe('setting the voice level', () => {
    it('measures speech and matches it to how loud the next song will play', () => {
      const tone = (amplitude: number) => ({ sampleRate: 1000, getChannelData: () => Float32Array.from({ length: 2000 }, (_, index) => amplitude * Math.sin(index)) })
      expect(speechLoudness(tone(0.1))).toBeCloseTo(-23.7, 0)
      expect(speechLoudness(tone(0.2))! - speechLoudness(tone(0.1))!).toBeCloseTo(6, 0)
      expect(speechLoudness(tone(0))).toBeNull()

      const tagged = { ...track('a'), replayGain: { trackGain: -6.6, trackPeak: 0.9 } }
      expect(musicLoudness(tagged, 'track')).toBeCloseTo(-18)
      expect(musicLoudness(tagged, null)).toBeCloseTo(-11.4)
      expect(musicLoudness(track('a'), 'track')).toBe(DJ_UNTAGGED_LUFS)

      expect(voiceGain(-18, -18 - DJ_VOICE_LIFT_DB, 1)).toBeCloseTo(1)
      expect(voiceGain(-12, -18 - DJ_VOICE_LIFT_DB, 1)).toBeCloseTo(0.5, 1)
      expect(voiceGain(-18, -60, 1)).toBeCloseTo(10 ** (-30 / 20), 3)
      expect(voiceGain(null, -18, 0.7)).toBe(0.7)
    })
  })

  describe('playing the recorded voice through Web Audio', () => {
    type FakeSource = { onended: (() => void) | null; start: ReturnType<typeof vi.fn>; stop: ReturnType<typeof vi.fn> }
    let context: { state: string; gains: number[]; sources: FakeSource[]; statechange?: (() => void) | null }
    // The DJ keeps one audio context for the session, so the fake reads whichever test's record is current.
    const node = () => ({ connect: vi.fn((next: unknown) => next) })
    class FakeContext {
      get state() { return context.state }
      set onstatechange(handler: (() => void) | null) { context.statechange = handler }
      destination = {}
      async resume() { return undefined }
      createBuffer() { return {} }
      // Three seconds of a steady tone at amplitude 0.1: about -23.7 LUFS by the ungated formula.
      async decodeAudioData() { return { duration: 3, sampleRate: 1000, getChannelData: () => Float32Array.from({ length: 3000 }, (_, index) => 0.1 * Math.sin(index)) } }
      createBufferSource() { const source = { ...node(), buffer: null, onended: null, start: vi.fn(), stop: vi.fn() }; context.sources.push(source); return source }
      createGain() { const gain = { ...node(), gain: { value: 1 } }; queueMicrotask(() => context.gains.push(gain.gain.value)); return gain }
      createDynamicsCompressor() { return { ...node(), threshold: { value: 0 }, knee: { value: 0 }, ratio: { value: 0 } } }
    }
    beforeEach(() => {
      context = { state: 'running', gains: [], sources: [] }
      vi.stubGlobal('AudioContext', FakeContext)
    })
    const fetcher = () => vi.fn(async (input: RequestInfo | URL) => String(input).startsWith('blob:') ? new Response(new Blob(['mp3']))
      : String(input).endsWith('/voice') ? new Response(new Blob(['mp3'])) : json({ tracks: [track('a'), track('b'), track('c')], script: 'Morning Tom.', curatedBy: 'claude', voice: true }))

    it('plays the voice through the audio context at the music\'s loudness, then the music', async () => {
      usePlayer.setState({ volume: 0.5, muted: false })
      vi.stubGlobal('fetch', fetcher())
      await useDj.getState().start()
      // The tap's unlock blip, then the link itself.
      await vi.waitFor(() => expect(context.sources).toHaveLength(2))
      expect(context.sources[1].start).toHaveBeenCalled()
      // An untagged song: the voice is brought from about -23.7 LUFS to the library average plus the lift, at half volume.
      await vi.waitFor(() => expect(context.gains).toHaveLength(1))
      const expected = 10 ** ((DJ_UNTAGGED_LUFS + DJ_VOICE_LIFT_DB + 23.7) / 20) * 0.5
      expect(context.gains[0]).toBeCloseTo(expected, 1)
      expect(usePlayer.getState().playing).toBe(false)
      expect(play).toHaveBeenCalledTimes(1) // only the unlock, never the voice element

      context.sources[1].onended?.()
      expect(useDj.getState().speaking).toBe(false)
      expect(usePlayer.getState().playing).toBe(true)
    })

    it('falls back to the audio element when the context will not run', async () => {
      context.state = 'suspended'
      vi.stubGlobal('fetch', fetcher())
      await useDj.getState().start()
      await vi.waitFor(() => expect(djVoiceElement()?.src).toBe('blob:voice'))
      expect(context.sources).toHaveLength(1)
      djVoiceElement()?.onended?.(new Event('ended'))
      expect(usePlayer.getState().playing).toBe(true)
    })

    it('leaves the music paused when the phone suspends the voice (headphones or the car disconnecting)', async () => {
      vi.useFakeTimers()
      try {
        vi.stubGlobal('fetch', fetcher())
        await useDj.getState().start()
        await vi.waitFor(() => expect(context.sources).toHaveLength(2))
        context.state = 'interrupted'
        context.statechange?.()
        expect(useDj.getState()).toEqual(expect.objectContaining({ active: true, speaking: false }))
        expect(context.sources[1].stop).toHaveBeenCalled()
        vi.advanceTimersByTime(DJ_SPEECH_TIMEOUT_MS)
        expect(usePlayer.getState().playing).toBe(false)
      } finally {
        vi.useRealTimers()
      }
    })

    it('leaves the music paused when the phone pauses the voice element', async () => {
      vi.useFakeTimers()
      try {
        context.state = 'suspended'
        vi.stubGlobal('fetch', fetcher())
        await useDj.getState().start()
        await vi.waitFor(() => expect(djVoiceElement()?.src).toBe('blob:voice'))
        djVoiceElement()?.onpause?.(new Event('pause'))
        expect(useDj.getState().speaking).toBe(false)
        vi.advanceTimersByTime(DJ_SPEECH_TIMEOUT_MS)
        expect(usePlayer.getState().playing).toBe(false)
      } finally {
        vi.useRealTimers()
      }
    })

    it('leaves the music paused when the listener pauses during the link', async () => {
      vi.stubGlobal('fetch', fetcher())
      await useDj.getState().start()
      await vi.waitFor(() => expect(context.sources).toHaveLength(2))
      useDj.getState().hush()
      expect(context.sources[1].stop).toHaveBeenCalled()
      context.sources[1].onended?.()
      expect(useDj.getState()).toEqual(expect.objectContaining({ active: true, speaking: false }))
      expect(usePlayer.getState().playing).toBe(false)
    })

    it('stops the voice when the DJ is stopped', async () => {
      vi.stubGlobal('fetch', fetcher())
      await useDj.getState().start()
      await vi.waitFor(() => expect(context.sources).toHaveLength(2))
      useDj.getState().stop()
      expect(context.sources[1].stop).toHaveBeenCalled()
      expect(usePlayer.getState().playing).toBe(true)
    })
  })
})
