// Hold to talk to the DJ: what the listener says while the mic button is held, as text. The browser's own
// speech recognition is used where there is one (Chrome, Edge, Safari); otherwise, or once it has failed,
// the recording goes to the Worker, which hears it with Whisper on Workers AI.

interface RecognitionResult { isFinal: boolean; 0: { transcript: string } }
interface RecognitionEvent { resultIndex: number; results: ArrayLike<RecognitionResult> }
interface Recognition {
  lang: string
  continuous: boolean
  interimResults: boolean
  onresult: ((event: RecognitionEvent) => void) | null
  onerror: ((event: { error: string }) => void) | null
  onend: (() => void) | null
  start(): void
  stop(): void
  abort(): void
}
type RecognitionConstructor = new () => Recognition

export interface Listening {
  // Stops listening and gives what was heard ('' for nothing).
  finish(): Promise<string>
  cancel(): void
}

export interface ListenOptions {
  // What has been heard so far, for showing while the button is held.
  onHeard?: (text: string) => void
  // Sends a recording to the server and gives back the text.
  transcribe: (audio: Blob) => Promise<string>
}

// Errors after which the browser's recognition won't work this session, so recordings go to the server.
const UNAVAILABLE = new Set(['service-not-allowed', 'network', 'language-not-supported', 'audio-capture'])
let browserFailed = false

export function browserRecognition(): RecognitionConstructor | null {
  if (browserFailed || typeof window === 'undefined') return null
  const scope = window as unknown as { SpeechRecognition?: RecognitionConstructor; webkitSpeechRecognition?: RecognitionConstructor }
  return scope.SpeechRecognition ?? scope.webkitSpeechRecognition ?? null
}

export function canListen() {
  return Boolean(browserRecognition()) || (typeof navigator !== 'undefined' && Boolean(navigator.mediaDevices?.getUserMedia) && typeof MediaRecorder !== 'undefined')
}

// For tests.
export function resetListening() { browserFailed = false }

export class ListenError extends Error {}

export function listen(options: ListenOptions): Listening {
  const Recognizer = browserRecognition()
  return Recognizer ? listenInBrowser(new Recognizer(), options) : record(options)
}

function listenInBrowser(recognition: Recognition, options: ListenOptions): Listening {
  const heard: string[] = []
  let failure: string | null = null
  let ended = false
  let onEnded: (() => void) | null = null
  recognition.lang = 'en-GB'
  recognition.continuous = true
  recognition.interimResults = true
  recognition.onresult = (event) => {
    for (let index = event.resultIndex; index < event.results.length; index++) heard[index] = event.results[index][0].transcript
    options.onHeard?.(heard.join(' ').replace(/\s+/g, ' ').trim())
  }
  recognition.onerror = (event) => {
    if (event.error === 'no-speech' || event.error === 'aborted') return
    if (UNAVAILABLE.has(event.error)) browserFailed = true
    failure = event.error === 'not-allowed'
      ? 'Allow the microphone for Tomify to talk to the DJ.'
      : browserFailed ? 'This browser couldn\'t hear you. Hold the button and try again.' : 'The DJ didn\'t catch that.'
  }
  recognition.onend = () => { ended = true; onEnded?.() }
  try {
    recognition.start()
  } catch {
    browserFailed = true
    failure = 'This browser couldn\'t hear you. Hold the button and try again.'
    ended = true
  }
  return {
    finish: () => new Promise((resolve, reject) => {
      const done = () => failure && !heard.length ? reject(new ListenError(failure)) : resolve(heard.join(' ').replace(/\s+/g, ' ').trim())
      if (ended) { done(); return }
      // Some browsers never report the end; what was heard so far is used then.
      const timer = setTimeout(() => { onEnded = null; done() }, 2500)
      onEnded = () => { clearTimeout(timer); done() }
      try { recognition.stop() } catch { onEnded() }
    }),
    cancel: () => { recognition.onend = null; try { recognition.abort() } catch { /* already stopped */ } },
  }
}

function record(options: ListenOptions): Listening {
  const chunks: Blob[] = []
  let recorder: MediaRecorder | null = null
  let stream: MediaStream | null = null
  let cancelled = false
  const release = () => stream?.getTracks().forEach((track) => track.stop())
  const started = (async () => {
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') throw new ListenError('This browser can\'t record you. Type your request instead.')
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true })
    } catch {
      throw new ListenError('Allow the microphone for Tomify to talk to the DJ.')
    }
    if (cancelled) { release(); return }
    recorder = new MediaRecorder(stream)
    recorder.ondataavailable = (event) => { if (event.data.size) chunks.push(event.data) }
    recorder.start()
    options.onHeard?.('')
  })()
  started.catch(() => undefined)
  return {
    finish: async () => {
      await started
      const active = recorder
      if (!active) return ''
      await new Promise<void>((resolve) => {
        active.onstop = () => resolve()
        if (active.state === 'inactive') resolve()
        else active.stop()
      })
      release()
      const audio = new Blob(chunks, { type: active.mimeType || chunks[0]?.type || 'audio/webm' })
      return audio.size ? (await options.transcribe(audio)).trim() : ''
    },
    cancel: () => {
      cancelled = true
      try { if (recorder && recorder.state !== 'inactive') recorder.stop() } catch { /* already stopped */ }
      release()
    },
  }
}
