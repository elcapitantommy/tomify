import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { browserRecognition, listen, resetListening } from './dj-listen'

class FakeRecognition {
  static last: FakeRecognition
  lang = ''; continuous = false; interimResults = false
  onresult: ((event: unknown) => void) | null = null
  onerror: ((event: { error: string }) => void) | null = null
  onend: (() => void) | null = null
  start = vi.fn()
  stop = vi.fn(() => this.onend?.())
  abort = vi.fn()
  constructor() { FakeRecognition.last = this }
  say(...parts: [string, boolean][]) { this.onresult?.({ resultIndex: 0, results: parts.map(([transcript, isFinal]) => ({ isFinal, 0: { transcript } })) }) }
}

class FakeRecorder {
  static last: FakeRecorder
  state = 'inactive'; mimeType = 'audio/mp4'
  ondataavailable: ((event: { data: Blob }) => void) | null = null
  onstop: (() => void) | null = null
  constructor(public stream: unknown) { FakeRecorder.last = this }
  start() { this.state = 'recording' }
  stop() { this.state = 'inactive'; this.ondataavailable?.({ data: new Blob(['voice'], { type: 'audio/mp4' }) }); this.onstop?.() }
}

describe('hold to talk', () => {
  beforeEach(() => resetListening())
  afterEach(() => { vi.unstubAllGlobals(); delete (window as { webkitSpeechRecognition?: unknown }).webkitSpeechRecognition })

  it('uses the browser\'s speech recognition and shows what it hears', async () => {
    (window as { webkitSpeechRecognition?: unknown }).webkitSpeechRecognition = FakeRecognition
    const heard: string[] = []
    const transcribe = vi.fn()
    const listening = listen({ onHeard: (text) => heard.push(text), transcribe })
    const recognition = FakeRecognition.last
    expect(recognition).toEqual(expect.objectContaining({ lang: 'en-GB', continuous: true, interimResults: true }))
    recognition.say(['something', false])
    recognition.say(['something upbeat', true], [' please', false])
    expect(heard).toEqual(['something', 'something upbeat please'])
    await expect(listening.finish()).resolves.toBe('something upbeat please')
    expect(transcribe).not.toHaveBeenCalled()
  })

  it('records for the server when the browser recognition is unavailable, and remembers that', async () => {
    (window as { webkitSpeechRecognition?: unknown }).webkitSpeechRecognition = FakeRecognition
    const failed = listen({ transcribe: vi.fn() })
    FakeRecognition.last.onerror?.({ error: 'service-not-allowed' })
    await expect(failed.finish()).rejects.toThrow('try again')
    expect(browserRecognition()).toBeNull()

    const track = { stop: vi.fn() }
    vi.stubGlobal('MediaRecorder', FakeRecorder)
    Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: { getUserMedia: vi.fn(async () => ({ getTracks: () => [track] })) } })
    const transcribe = vi.fn(async (audio: Blob) => `heard ${audio.type}`)
    const recording = listen({ transcribe })
    await vi.waitFor(() => expect(FakeRecorder.last?.state).toBe('recording'))
    await expect(recording.finish()).resolves.toBe('heard audio/mp4')
    expect(track.stop).toHaveBeenCalled()
  })

  it('asks for the microphone when it is refused', async () => {
    (window as { webkitSpeechRecognition?: unknown }).webkitSpeechRecognition = FakeRecognition
    const listening = listen({ transcribe: vi.fn() })
    FakeRecognition.last.onerror?.({ error: 'not-allowed' })
    await expect(listening.finish()).rejects.toThrow('Allow the microphone')
    expect(browserRecognition()).not.toBeNull()
  })
})
