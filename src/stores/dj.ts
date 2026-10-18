import { create } from 'zustand'
import { useAuth } from './auth'
import { usePlayer } from './player'
import type { Track } from '../types'

// Tomify DJ: plays sets of a few songs, with a short spoken link before each set. The next set is fetched
// while the current one plays; when its first song comes up the music waits while the DJ talks.

export interface DjSegment { tracks: Track[]; script: string; curatedBy: 'claude' | 'tomify'; voice: boolean }
interface PendingLink { firstTrackId: string; script: string; audioUrl: string | null }

export interface DjState {
  active: boolean
  loading: boolean
  speaking: boolean
  script: string | null
  error: string | null
  request: string | null
  pending: PendingLink | null
  trackIds: string[]
  start(): Promise<void>
  stop(): void
  steer(request: string): Promise<void>
}

// Sets are fetched when this many songs or fewer are left after the current one.
export const DJ_PREFETCH_REMAINING = 1

function headers(): HeadersInit {
  const session = useAuth.getState().session
  if (!session) throw new Error('Sign in to use the DJ.')
  return { 'content-type': 'application/json', 'x-tomify-user': session.username, 'x-tomify-token': session.token, 'x-tomify-salt': session.salt }
}

export async function fetchSegment(body: { recentTrackIds: string[]; recentArtists: string[]; request: string | null; first: boolean }, fetcher: typeof fetch = fetch): Promise<DjSegment> {
  const response = await fetcher('/api/dj/segment', { method: 'POST', headers: headers(), body: JSON.stringify(body) })
  const result = await response.json().catch(() => ({})) as DjSegment & { message?: string; error?: string }
  if (!response.ok) throw new Error(result.message || result.error || 'The DJ could not pick the next songs.')
  return result
}

// The spoken link as a playable URL, or null if the voice isn't available (the DJ then just plays the music).
export async function fetchVoice(script: string, fetcher: typeof fetch = fetch): Promise<string | null> {
  try {
    const response = await fetcher('/api/dj/voice', { method: 'POST', headers: headers(), body: JSON.stringify({ text: script }) })
    if (!response.ok) return null
    return URL.createObjectURL(await response.blob())
  } catch {
    return null
  }
}

// One shared element for the DJ's voice. Browsers only let audio start from a tap, so it is unlocked
// when the DJ button is pressed and reused for every later link.
let voiceElement: HTMLAudioElement | null = null
const SILENCE = 'data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAQB8AAIA+AAACABAAZGF0YQAAAAA='
export function djVoiceElement() {
  if (!voiceElement && typeof Audio !== 'undefined') voiceElement = new Audio()
  return voiceElement
}
function unlockVoice() {
  const element = djVoiceElement()
  if (!element) return
  element.src = SILENCE
  void element.play()?.catch(() => undefined)
}

// True while start() swaps the queue over to the DJ's first set.
let handingOver = false
// Re-runs the bound player check once the hand-over is done (set by bindDj).
let bindDjCheck: (() => void) | null = null

const recentIds = (extra: string[] = []) => [...new Set([...usePlayer.getState().queue.map((track) => track.id), ...extra])].slice(-200)
// Artists from roughly the last three sets, so the DJ rests them for a while.
export const DJ_RECENT_ARTIST_TRACKS = 12
const recentArtists = () => [...new Set(usePlayer.getState().queue.slice(-DJ_RECENT_ARTIST_TRACKS).map((track) => track.artist).filter(Boolean))]

async function loadSet(first: boolean, request: string | null) {
  const segment = await fetchSegment({ recentTrackIds: recentIds(useDj.getState().trackIds), recentArtists: recentArtists(), request, first })
  if (!segment.tracks.length) throw new Error('The DJ could not find anything to play.')
  const audioUrl = segment.voice && segment.script ? await fetchVoice(segment.script) : null
  return { segment, link: { firstTrackId: segment.tracks[0].id, script: segment.script, audioUrl } }
}

export const useDj = create<DjState>((set, get) => ({
  active: false, loading: false, speaking: false, script: null, error: null, request: null, pending: null, trackIds: [],

  start: async () => {
    unlockVoice()
    set({ active: true, loading: true, error: null, request: null, pending: null, trackIds: [], script: null })
    try {
      const { segment, link } = await loadSet(true, null)
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
    const element = djVoiceElement()
    if (get().speaking && element) { element.pause(); usePlayer.getState().setPlaying(true) }
    set({ active: false, loading: false, speaking: false, pending: null, request: null })
  },

  // Asks for something different: the songs after the current one are replaced by a new set.
  steer: async (request) => {
    if (!get().active) return
    set({ request, loading: true, error: null })
    try {
      const { segment, link } = await loadSet(false, request)
      if (!get().active) return
      const replaced = get().pending
      if (replaced?.audioUrl) URL.revokeObjectURL(replaced.audioUrl)
      const player = usePlayer.getState()
      usePlayer.setState({ queue: [...player.queue.slice(0, player.currentIndex + 1), ...segment.tracks], activitySerial: player.activitySerial + 1 })
      set((state) => ({ pending: link, trackIds: [...state.trackIds, ...segment.tracks.map((track) => track.id)], loading: false }))
    } catch (reason) {
      set({ loading: false, error: reason instanceof Error ? reason.message : 'The DJ could not change direction.' })
    }
  },
}))

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
      const element = djVoiceElement()
      if (link.audioUrl && element) {
        useDj.setState({ speaking: true })
        usePlayer.getState().setPlaying(false)
        const finish = () => {
          element.onended = null; element.onerror = null
          URL.revokeObjectURL(link.audioUrl!)
          if (!useDj.getState().speaking) return
          useDj.setState({ speaking: false })
          if (useDj.getState().active) usePlayer.getState().setPlaying(true)
        }
        element.onended = finish
        element.onerror = finish
        element.src = link.audioUrl
        void element.play()?.catch(finish)
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

