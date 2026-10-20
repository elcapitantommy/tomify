import { create } from 'zustand'
import { useAuth } from './auth'
import { usePlayer } from './player'
import { useNormalisation } from './normalisation'
import { gainModeAt } from '../lib/loudness'
import { replayGainDb, type ReplayGainMode } from '../../shared/replaygain.mjs'
import type { Track } from '../types'

// Tomify DJ: plays sets of a few songs, with a short spoken link before each set. The next set is fetched
// while the current one plays; when its first song comes up the music waits while the DJ talks.

export interface DjSegment { tracks: Track[]; script: string; curatedBy: 'claude' | 'tomify'; voice: boolean }
interface PendingLink { firstTrackId: string; script: string; audioUrl: string | null; voice: boolean }

export interface DjState {
  // The DJ panel is showing (opened from the DJ button), whether or not the DJ has started.
  open: boolean
  active: boolean
  loading: boolean
  speaking: boolean
  // Why the phone's own voice stood in for the DJ's, shown under the link.
  voiceNote: string | null
  script: string | null
  error: string | null
  request: string | null
  pending: PendingLink | null
  trackIds: string[]
  // Opens the panel without starting, so the listener can ask for something or let the DJ choose.
  openPanel(): void
  closePanel(): void
  // Starts the DJ; with a request ("some Blur", "something calmer") the first set is picked for it.
  start(request?: string | null): Promise<void>
  stop(): void
  // Replaces the songs after this one with a set for the request. With now, that set starts straight
  // away (the DJ answers first); resolves whether it worked.
  steer(request: string, options?: { now?: boolean }): Promise<boolean>
  // The link was cut off by a pause (the listener's, or the phone's when headphones or a car
  // disconnect): stop talking and leave the music paused rather than bringing it back afterwards.
  hush(): void
}

// Sets are fetched when this many songs or fewer are left after the current one.
export const DJ_PREFETCH_REMAINING = 1

function headers(): HeadersInit {
  const session = useAuth.getState().session
  if (!session) throw new Error('Sign in to use the DJ.')
  return { 'content-type': 'application/json', 'x-tomify-user': session.username, 'x-tomify-token': session.token, 'x-tomify-salt': session.salt }
}

export async function fetchSegment(body: { recentTrackIds: string[]; recentArtists: string[]; request: string | null; justAsked?: boolean; first: boolean }, fetcher: typeof fetch = fetch): Promise<DjSegment> {
  const response = await fetcher('/api/dj/segment', { method: 'POST', headers: headers(), body: JSON.stringify(body) })
  const result = await response.json().catch(() => ({})) as DjSegment & { message?: string; error?: string }
  if (!response.ok) throw new Error(result.message || result.error || 'The DJ could not pick the next songs.')
  return result
}

// The spoken link as a playable URL, or null if the voice isn't available (the DJ then just plays the music).
// A failed request is tried once more, since a missed voice means a silent link. Why the last one
// failed is kept, so the panel can say why the phone's voice stood in.
let voiceProblem: string | null = null
// Links read by the server's backup voice, with why Aura-2 wasn't used, keyed by their audio URL.
const backupNotes = new Map<string, string>()
export async function fetchVoice(script: string, fetcher: typeof fetch = fetch, attempts = 2): Promise<string | null> {
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      const response = await fetcher('/api/dj/voice', { method: 'POST', headers: headers(), body: JSON.stringify({ text: script }) })
      if (!response.ok) {
        const result = await response.json().catch(() => ({})) as { message?: string; error?: string }
        voiceProblem = result.message || result.error || `The DJ voice failed (${response.status}).`
        if (response.status === 503) return null
        continue
      }
      const audio = await response.blob()
      if (audio.size) {
        const url = URL.createObjectURL(audio)
        if (response.headers.get('x-tomify-voice') === 'backup') backupNotes.set(url, `The backup voice read this one. ${decodeURIComponent(response.headers.get('x-tomify-voice-problem') ?? '')}`.trim())
        return url
      }
      voiceProblem = 'The DJ voice came back empty.'
    } catch (reason) {
      voiceProblem = `The DJ voice could not be reached${reason instanceof Error && reason.message ? `: ${reason.message}` : '.'}`
    }
  }
  return null
}

// One shared element for the DJ's voice. Browsers only let audio start from a tap, so it is unlocked
// when the DJ button is pressed and reused for every later link. The browser's own speech is unlocked
// at the same time, as the fallback when the recorded voice is missing or won't play.
let voiceElement: HTMLAudioElement | null = null
// A tenth of a second of real silence: Safari won't count an empty file as having played.
const SILENCE = silentWav(800)
function silentWav(samples: number) {
  const header = [0x46464952, 36 + samples, 0x45564157, 0x20746d66, 16, 0x00010001, 8000, 8000, 0x00080001, 0x61746164, samples]
  const bytes = new Uint8Array(44 + samples).fill(128)
  const view = new DataView(bytes.buffer)
  header.forEach((value, index) => view.setUint32(index * 4, value, true))
  return `data:audio/wav;base64,${btoa(String.fromCharCode(...bytes))}`
}
export function djVoiceElement() {
  if (!voiceElement && typeof Audio !== 'undefined') voiceElement = new Audio()
  return voiceElement
}
// The recorded voice plays through Web Audio when it can: a context started from the DJ tap may play
// later without another tap (an <audio> element is often refused), and its level can be set to sit with
// the music. The voice's loudness is measured and matched to the song it leads into, as that song will
// play (normalised or not), plus DJ_VOICE_LIFT_DB, then scaled by the volume setting. A limiter stops clipping.
export const DJ_VOICE_LIFT_DB = 1
// ReplayGain 2.0's reference loudness: tags say how far each song is from it (replayGainDb adds the pre-amp).
const REFERENCE_LUFS = -18
// An untagged song is taken to be as loud as the library's average (measured 2026-10-18).
export const DJ_UNTAGGED_LUFS = -11.5

/** How loud `track` will play, in LUFS, with the gain `mode` gives it. */
export function musicLoudness(track: Track | undefined, mode: ReplayGainMode | null) {
  const trackGain = track?.replayGain?.trackGain
  if (typeof trackGain !== 'number') return DJ_UNTAGGED_LUFS
  return REFERENCE_LUFS - trackGain + ((mode && replayGainDb(track!.replayGain, mode)) ?? 0)
}

/** Integrated loudness of speech in LUFS (BS.1770 gating, without the K-weighting), or null for silence. */
export function speechLoudness(buffer: Pick<AudioBuffer, 'sampleRate' | 'getChannelData'>) {
  const data = buffer.getChannelData(0)
  const size = Math.max(1, Math.round(buffer.sampleRate * 0.4))
  const blocks: number[] = []
  for (let start = 0; start < data.length; start += size) {
    let sum = 0
    const end = Math.min(data.length, start + size)
    for (let index = start; index < end; index++) sum += data[index] * data[index]
    blocks.push(sum / (end - start))
  }
  const lufs = (power: number) => -0.691 + 10 * Math.log10(power)
  const mean = (values: number[]) => values.reduce((total, value) => total + value, 0) / values.length
  const audible = blocks.filter((power) => power > 0 && lufs(power) > -70)
  if (!audible.length) return null
  const gated = audible.filter((power) => lufs(power) > lufs(mean(audible)) - 10)
  return lufs(mean(gated))
}

/** The multiplier that brings speech at `voiceLufs` to `musicLufs` (plus the lift), at `volume`. */
export function voiceGain(voiceLufs: number | null, musicLufs: number, volume: number) {
  if (voiceLufs === null) return volume
  const db = Math.max(-30, Math.min(15, musicLufs + DJ_VOICE_LIFT_DB - voiceLufs))
  return 10 ** (db / 20) * volume
}

// iPhones play every page at full volume (the volume buttons are the only control), and a page can't change it.
let pageVolume: boolean | null = null
function pageVolumeWorks() {
  if (pageVolume === null) {
    try { const probe = new Audio(); probe.volume = 0.5; pageVolume = Math.abs(probe.volume - 0.5) < 0.01 } catch { pageVolume = false }
  }
  return pageVolume
}

// The level the music is at right now: the song the link leads into, the normalisation setting and the volume.
function musicLevel() {
  const player = usePlayer.getState()
  const volume = player.muted ? 0 : pageVolumeWorks() ? player.volume : 1
  return { lufs: musicLoudness(player.queue[player.currentIndex], gainModeAt(player.queue, player.currentIndex, useNormalisation.getState().setting)), volume }
}

type WebkitWindow = Window & { webkitAudioContext?: typeof AudioContext }
let voiceContext: AudioContext | null = null
let voiceSource: AudioBufferSourceNode | null = null
function djVoiceContext() {
  if (voiceContext || typeof window === 'undefined') return voiceContext
  const Context = window.AudioContext ?? (window as WebkitWindow).webkitAudioContext
  if (!Context) return null
  try { voiceContext = new Context() } catch { return null }
  return voiceContext
}
// Lets Web Audio play with the iPhone's silent switch on, like the music does.
function playbackSession() {
  const session = (navigator as Navigator & { audioSession?: { type: string } }).audioSession
  if (session) try { session.type = 'playback' } catch { /* older Safari */ }
}
async function playThroughContext(url: string, onEnded: () => void, onInterrupted: () => void, music: { lufs: number; volume: number }): Promise<boolean> {
  const context = djVoiceContext()
  if (!context) return false
  try {
    if (context.state !== 'running') await context.resume()
    if (context.state !== 'running') return false
    const decoded = await context.decodeAudioData(await (await fetch(url)).arrayBuffer())
    const source = context.createBufferSource()
    const gain = context.createGain()
    const compressor = context.createDynamicsCompressor()
    source.buffer = decoded
    gain.gain.value = voiceGain(speechLoudness(decoded), music.lufs, music.volume)
    compressor.threshold.value = -3
    compressor.knee.value = 0
    compressor.ratio.value = 20
    source.connect(gain).connect(compressor).connect(context.destination)
    source.onended = () => { if (voiceSource === source) voiceSource = null; onEnded() }
    voiceSource = source
    // An iPhone suspends the context when the audio route goes away; the voice then never ends.
    context.onstatechange = () => { if (voiceSource === source && context.state !== 'running') onInterrupted() }
    source.start()
    return true
  } catch {
    return false
  }
}
function silenceVoice() {
  try { voiceSource?.stop() } catch { /* already stopped */ }
  voiceSource = null
  djVoiceElement()?.pause()
  try { speech()?.cancel() } catch { /* no browser speech */ }
}

const speech = () => typeof window !== 'undefined' && 'speechSynthesis' in window && typeof SpeechSynthesisUtterance !== 'undefined' ? window.speechSynthesis : null
function unlockVoice() {
  playbackSession()
  const context = djVoiceContext()
  if (context) {
    try {
      void context.resume()?.catch(() => undefined)
      const blip = context.createBufferSource()
      blip.buffer = context.createBuffer(1, 1, 22050)
      blip.connect(context.destination)
      blip.start()
    } catch { /* the <audio> element still gets unlocked below */ }
  }
  const element = djVoiceElement()
  if (element) {
    element.src = SILENCE
    void element.play()?.catch(() => undefined)
  }
  try { speech()?.speak(new SpeechSynthesisUtterance('')) } catch { /* no browser speech */ }
}

// True while start() swaps the queue over to the DJ's first set.
let handingOver = false
// Re-runs the bound player check once the hand-over is done (set by bindDj).
let bindDjCheck: (() => void) | null = null

const recentIds = (extra: string[] = []) => [...new Set([...usePlayer.getState().queue.map((track) => track.id), ...extra])].slice(-200)
// Artists from roughly the last three sets, so the DJ rests them for a while.
export const DJ_RECENT_ARTIST_TRACKS = 12
const recentArtists = () => [...new Set(usePlayer.getState().queue.slice(-DJ_RECENT_ARTIST_TRACKS).map((track) => track.artist).filter(Boolean))]

async function loadSet(first: boolean, request: string | null, justAsked = false) {
  const segment = await fetchSegment({ recentTrackIds: recentIds(useDj.getState().trackIds), recentArtists: recentArtists(), request, first, ...(justAsked ? { justAsked } : {}) })
  if (!segment.tracks.length) throw new Error('The DJ could not find anything to play.')
  const audioUrl = segment.voice && segment.script ? await fetchVoice(segment.script) : null
  return { segment, link: { firstTrackId: segment.tracks[0].id, script: segment.script, audioUrl, voice: segment.voice } }
}

export const useDj = create<DjState>((set, get) => ({
  open: false, active: false, loading: false, speaking: false, voiceNote: null, script: null, error: null, request: null, pending: null, trackIds: [],

  openPanel: () => set({ open: true, error: null }),
  closePanel: () => { if (!get().active) set({ open: false, error: null }) },

  start: async (request = null) => {
    unlockVoice()
    const asked = request?.trim() || null
    set({ open: true, active: true, loading: true, error: null, request: asked, pending: null, trackIds: [], script: null, voiceNote: null })
    try {
      const { segment, link } = await loadSet(true, asked, Boolean(asked))
      if (!get().active) return
      set({ pending: link, trackIds: segment.tracks.map((track) => track.id), loading: false })
      // While the player switches over, the old track is still current for a moment; that must not stop the DJ.
      handingOver = true
      try {
        usePlayer.setState({ shuffle: false, repeat: 'off' })
        usePlayer.getState().playTracks(segment.tracks)
      } finally {
        handingOver = false
      }
      bindDjCheck?.()
    } catch (reason) {
      set({ active: false, loading: false, error: reason instanceof Error ? reason.message : 'The DJ could not start.' })
    }
  },

  stop: () => {
    const pending = get().pending
    if (pending?.audioUrl) URL.revokeObjectURL(pending.audioUrl)
    if (get().speaking) {
      silenceVoice()
      usePlayer.getState().setPlaying(true)
    }
    set({ open: false, active: false, loading: false, speaking: false, pending: null, request: null })
  },

  hush: () => {
    if (!get().speaking) return
    set({ speaking: false })
    silenceVoice()
  },

  // Asks for something different: the songs after the current one are replaced by a new set.
  steer: async (request, options = {}) => {
    if (!get().active) return false
    set({ request, loading: true, error: null })
    try {
      const { segment, link } = await loadSet(false, request, true)
      if (!get().active) return false
      const replaced = get().pending
      if (replaced?.audioUrl) URL.revokeObjectURL(replaced.audioUrl)
      const player = usePlayer.getState()
      usePlayer.setState({ queue: [...player.queue.slice(0, player.currentIndex + 1), ...segment.tracks], activitySerial: player.activitySerial + 1 })
      set((state) => ({ pending: link, trackIds: [...state.trackIds, ...segment.tracks.map((track) => track.id)], loading: false }))
      // Moving on to the new set's first song is what makes the DJ speak its link.
      if (options.now) usePlayer.getState().next()
      return true
    } catch (reason) {
      set({ loading: false, error: reason instanceof Error ? reason.message : 'The DJ could not change direction.' })
      return false
    }
  },
}))

// What the listener said, heard by the server (for browsers without their own speech recognition).
export async function fetchHeard(audio: Blob, fetcher: typeof fetch = fetch): Promise<string> {
  const response = await fetcher('/api/dj/listen', { method: 'POST', headers: { ...headers(), 'content-type': audio.type || 'application/octet-stream' }, body: audio })
  const result = await response.json().catch(() => ({})) as { text?: string; message?: string; error?: string }
  if (!response.ok) throw new Error(result.message || result.error || `The DJ couldn't hear you (${response.status}).`)
  return result.text ?? ''
}

// Holds the music while the link is spoken: the recorded voice if there is one (fetched again if it
// went missing), otherwise, or if it won't play, the browser's own speech. The music always comes back.
export const DJ_SPEECH_TIMEOUT_MS = 30_000
function speakLink(link: PendingLink) {
  useDj.setState({ speaking: true })
  usePlayer.getState().setPlaying(false)
  const element = djVoiceElement()
  let done = false
  const finish = () => {
    if (done) return
    done = true
    clearTimeout(timer)
    if (element) { element.onended = null; element.onerror = null; element.onpause = null }
    if (link.audioUrl) URL.revokeObjectURL(link.audioUrl)
    if (!useDj.getState().speaking) return
    useDj.setState({ speaking: false })
    if (useDj.getState().active) usePlayer.getState().setPlaying(true)
  }
  const stillSpeaking = () => !done && useDj.getState().speaking
  const browserSpeech = (problem: string | null) => {
    if (!stillSpeaking()) return
    useDj.setState({ voiceNote: `Your phone's voice read this one. ${problem ?? 'The DJ voice wouldn\'t play.'}` })
    const synth = speech()
    if (!synth) { finish(); return }
    try {
      const utterance = new SpeechSynthesisUtterance(link.script)
      utterance.lang = 'en-GB'
      utterance.onend = finish
      utterance.onerror = finish
      synth.cancel()
      synth.speak(utterance)
    } catch {
      finish()
    }
  }
  const playElement = (url: string) => {
    if (!stillSpeaking()) return
    const refused = (reason: unknown) => {
      if (element) { element.onended = null; element.onerror = null; element.onpause = null }
      const name = reason && typeof reason === 'object' && 'name' in reason ? String((reason as { name: unknown }).name) : ''
      browserSpeech(name === 'NotAllowedError' ? 'The browser wouldn\'t let the DJ voice start.' : 'The DJ voice wouldn\'t play.')
    }
    if (!element) { refused(null); return }
    element.onended = finish
    element.onerror = refused
    // 'pause' also comes just before 'ended'; any other pause means the phone stopped the voice.
    element.onpause = () => { if (!element.ended) useDj.getState().hush() }
    element.src = url
    void element.play()?.catch(refused)
  }
  const playRecording = (url: string) => {
    if (!stillSpeaking()) { URL.revokeObjectURL(url); return }
    link.audioUrl = url
    useDj.setState({ voiceNote: backupNotes.get(url) ?? null })
    backupNotes.delete(url)
    void playThroughContext(url, finish, () => useDj.getState().hush(), musicLevel()).then((playing) => {
      if (!playing) playElement(url)
      else if (!stillSpeaking()) silenceVoice()
    })
  }
  // Nothing may hold the music for long, whatever the browser does or doesn't report.
  const timer = setTimeout(finish, DJ_SPEECH_TIMEOUT_MS)
  if (link.audioUrl) playRecording(link.audioUrl)
  else if (link.voice) void fetchVoice(link.script).then((url) => url ? playRecording(url) : browserSpeech(voiceProblem))
  else browserSpeech('The DJ voice isn\'t set up on the server (Workers AI).')
}

// Called when the queue moves on. Fetches the next set near the end, and holds the first song of a new
// set while the DJ talks. Returns a cleanup function for tests.
export function bindDj(now: () => number = Date.now): () => void {
  let fetching = false
  let failedAt = 0
  const onPlayer = () => {
    const dj = useDj.getState()
    if (!dj.active) return
    const player = usePlayer.getState()
    const track = player.queue[player.currentIndex]
    // Playing something else (an album, a playlist) ends the DJ. Until the first set is playing, whatever
    // was already in the player is still current, so that doesn't count.
    if (!dj.trackIds.length) return
    if (track && !handingOver && !dj.trackIds.includes(track.id)) { dj.stop(); return }

    if (track && dj.pending && dj.pending.firstTrackId === track.id && !dj.speaking && player.playing) {
      const link = dj.pending
      useDj.setState({ pending: null, script: link.script })
      if (link.script) {
        speakLink(link)
        return
      }
    }

    const remaining = player.queue.length - 1 - player.currentIndex
    const current = useDj.getState()
    if (!fetching && !current.pending && !current.loading && remaining <= DJ_PREFETCH_REMAINING && now() - failedAt > 30_000) {
      fetching = true
      useDj.setState({ loading: true })
      loadSet(false, current.request).then(({ segment, link }) => {
        if (!useDj.getState().active) return
        useDj.setState((state) => ({ pending: link, trackIds: [...state.trackIds, ...segment.tracks.map((item) => item.id)], loading: false, error: null }))
        for (const item of segment.tracks) usePlayer.getState().addToQueue(item)
      }).catch((reason) => {
        failedAt = now()
        useDj.setState({ loading: false, error: reason instanceof Error ? reason.message : 'The DJ could not pick the next songs.' })
      }).finally(() => { fetching = false })
    }
  }
  const unsubscribePlayer = usePlayer.subscribe(onPlayer)
  const unsubscribeDj = useDj.subscribe((state, previous) => { if (state.active && !previous.active) onPlayer() })
  bindDjCheck = onPlayer
  return () => { unsubscribePlayer(); unsubscribeDj(); if (bindDjCheck === onPlayer) bindDjCheck = null }
}

