// Tomify DJ: plays a few songs at a time from your library with a short spoken link before each set,
// like a radio DJ who knows what you listen to. Claude picks the songs and writes the link; Workers AI
// (MeloTTS, or Deepgram Aura-2 when chosen) reads it out. Without an Anthropic key the DJ still picks songs and reads a plain intro.
import type { Env, RouteHandler } from '../env.ts'
import { authenticate } from '../lib/auth.ts'
import { json } from '../lib/http.ts'
import { subsonicForRequest } from '../lib/subsonic.ts'
import { buildCandidates, gatherLibrary, songsOf, limitPerArtist, listeningStats, seededRandom, toMixTrack, type Candidate, type LibrarySnapshot, type MixTrack, type SubsonicSong } from './mixes.ts'
import { callClaudeJson } from './mix-curator.ts'

const DJ_POOL_SIZE = 150
// No artist gets more than this many songs in a pool, so a few favourite artists can't fill it.
export const DJ_POOL_PER_ARTIST = 3
// Artists from the last few sets are rested while there are at least this many other artists to pick from.
const DJ_MIN_RESTED_ARTISTS = 8
const MAX_SCRIPT_CHARS = 600
const MAX_REQUEST_CHARS = 200
export const DEFAULT_DJ_VOICE = 'ophelia'
export const DJ_TTS_MODEL = '@cf/deepgram/aura-2-en'
// MeloTTS is plainer than Aura-2 but costs about 8 neurons a link against Aura-2's ~1,100, so it is the
// default: the free 10,000 a day are shared by every model, and Aura-2 alone spends them in about nine
// links. TOMIFY_DJ_VOICE_MODEL=aura uses Aura-2 first (for a Workers Paid account), with MeloTTS as backup.
export const DJ_BACKUP_TTS_MODEL = '@cf/myshell-ai/melotts'
// Hears a spoken request when the browser can't (about 47 neurons a minute; a request is a few seconds).
export const DJ_LISTEN_MODEL = '@cf/openai/whisper-large-v3-turbo'
const MAX_LISTEN_BYTES = 2 * 1024 * 1024

export interface DjSegment { tracks: MixTrack[], script: string, curatedBy: 'claude' | 'tomify', voice: boolean }
export interface DjSegmentInput { recentTrackIds: string[], recentArtists: string[], request: string | null, justAsked?: boolean, first: boolean, username: string, now: number }

export const DJ_SYSTEM = `You are the DJ in Tomify, a personal music player: a bubbly, upbeat radio presenter talking to one listener between songs, who knows their taste.

Each time, pick the next 3 to 5 songs from the candidate pool and write the short spoken link that plays before them.
- Only use refs from the pool. Never pick a recently played song. Order them so they flow.
- At most one song per artist in a set. Don't keep returning to the same few artists.
- Mix favourites with songs they haven't played lately or ever.
- If the listener asked for something, honour it. When they have just asked, start the link by answering them in a few words ("Upbeat it is!") before introducing the first song. Never mention an earlier request: it has been answered. Songs show their tempo (bpm), genre and mood when known: when asked for a style, mood or tempo, keep the whole set to it and order it by tempo so it flows.
- The link is 2 to 4 sentences and at most 70 words, read by a text-to-speech voice: plain words, no emojis, lists, stage directions or sound effects. Introduce what's coming (you can name the first song and artist) and give a personal reason when there is one.
- On the first link of a session, greet the listener by name and mention the time of day.
- Never guess what a song sounds like.`

const DJ_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['script', 'trackRefs'],
  properties: {
    script: { type: 'string' },
    trackRefs: { type: 'array', items: { type: 'string' } },
  },
} as const

export function cleanSegmentRequest(body: unknown): { recentTrackIds: string[], recentArtists: string[], request: string | null, justAsked: boolean, first: boolean } {
  const input = body && typeof body === 'object' ? body as Record<string, unknown> : {}
  const strings = (value: unknown, limit: number) => Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string' && item !== '').slice(-limit) : []
  const recentTrackIds = strings(input.recentTrackIds, 200)
  const recentArtists = strings(input.recentArtists, 20).map((artist) => artist.slice(0, MAX_REQUEST_CHARS))
  const request = typeof input.request === 'string' && input.request.trim() ? input.request.trim().slice(0, MAX_REQUEST_CHARS) : null
  return { recentTrackIds, recentArtists, request, justAsked: Boolean(request) && input.justAsked === true, first: input.first === true }
}

export function partOfDay(now: number) {
  const hour = Number(new Intl.DateTimeFormat('en-GB', { hour: 'numeric', hourCycle: 'h23', timeZone: 'Europe/London' }).format(new Date(now)))
  return hour < 5 ? 'late night' : hour < 12 ? 'morning' : hour < 18 ? 'afternoon' : 'evening'
}

// "Saturday 17 October", so the DJ never has to guess the day.
export function ukDate(now: number) {
  return new Date(now).toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'Europe/London' })
}

// A varied pool for one set: anything not played this session, songs with a reason to be there first,
// at most a few songs per artist, and the artists from the last few sets rested when there's enough else.
// The library gathers many songs by the artists played most (their top songs, similar songs, most played
// albums), so without the cap and the rest those few artists fill the pool and every set.
// Songs that fit what the listener asked for: a genre or mood they named, or a tempo ("120 bpm", "120-130 bpm"),
// counting half and double time. Everyday words for the agent's moods ("something calmer") count as that mood.
const MOOD_WORDS: [RegExp, string][] = [[/calm|relax|mellow|chill|quiet|soft/, 'chill'], [/happy|upbeat|cheer|fun/, 'upbeat'], [/energ|party|workout|pump|lively/, 'energetic'], [/sad|melanchol/, 'sad'], [/romantic|love/, 'romantic']]
export function styleMatcher(request: string): (song: SubsonicSong) => boolean {
  const lower = request.toLowerCase()
  const text = [lower, ...MOOD_WORDS.filter(([words]) => words.test(lower)).map(([, mood]) => mood)].join(' ')
  const tempo = text.match(/(\d{2,3})(?:\s*(?:-|to)\s*(\d{2,3}))?\s*bpm/)
  const low = tempo ? Number(tempo[1]) - (tempo[2] ? 0 : 4) : 0
  const high = tempo ? (tempo[2] ? Number(tempo[2]) : low + 8) : 0
  return (song) => (Boolean(song.bpm) && [1, 2, 0.5].some((scale) => song.bpm! * scale >= low && song.bpm! * scale <= high))
    || styleOf(song).some((tag) => tag.length > 2 && text.includes(tag.toLowerCase()))
}

const styleOf = (song: SubsonicSong) => [...new Set([...(song.genres ?? []).map((genre) => genre.name), song.genre ?? '', ...(song.moods ?? [])].filter(Boolean))]

// What to search the library for: "can you play Hangman Jury and some songs like it" tries the whole
// phrase, then "hangman jury" (cut at "and", "like" and the like), then the artist after "by" alone.
// Navidrome needs every word to match, so the first search with results is used.
export function requestSearches(request: string): string[] {
  let text = request.toLowerCase().replace(/[^\p{L}\p{N}' ]+/gu, ' ').replace(/\s+/g, ' ').trim()
  for (let before = ''; before !== text;) {
    before = text
    text = text.replace(/^(?:hey dj|dj|can you|could you|will you|please|play|put on|queue|i want|i'd like|i would like|to hear|let's have|give me|some|me|the song|song) /, '').replace(/ (?:please|now|next|for me)$/, '')
  }
  const [title, artist = ''] = text.split(' by ')
  const short = title.split(/ (?:and|then|with|like|or|plus|followed) /)[0]
  return [...new Set([`${title} ${artist}`, text, `${short} ${artist}`, title, short, artist].map((query) => query.trim()).filter((query) => query.length > 2))].slice(0, 4)
}

export function djPool(candidates: Candidate[], recentTrackIds: string[], seed: string, size = DJ_POOL_SIZE, recentArtists: string[] = [], matches?: (song: SubsonicSong) => boolean): Candidate[] {
  const recent = new Set(recentTrackIds)
  const resting = new Set(recentArtists)
  const random = seededRandom(seed)
  // Songs found by searching for the request go first, whatever the artist caps and rests say,
  // with one copy of each song when the library has several versions of an album.
  const titles = new Set<string>()
  const requested = candidates.filter((candidate) => candidate.sources.includes('request') && !recent.has(candidate.song.id))
    .filter(({ song }) => { const key = `${song.artist}|${song.title}`.toLowerCase(); return !titles.has(key) && Boolean(titles.add(key)) }).slice(0, 12)
  const fresh = candidates.filter((candidate) => !recent.has(candidate.song.id) && !requested.includes(candidate))
    .map((candidate) => ({ candidate, order: random() - (candidate.sources.some((source) => source !== 'library') ? 0.5 : 0) + (resting.has(candidate.song.artist) ? 2 : 0) - (matches?.(candidate.song) ? 2 : 0) }))
    .sort((a, b) => a.order - b.order).map(({ candidate }) => candidate)
  const pool = limitPerArtist(fresh, DJ_POOL_PER_ARTIST)
  const rested = pool.filter((candidate) => !resting.has(candidate.song.artist))
  return [...requested, ...(new Set(rested.map((candidate) => candidate.song.artist)).size >= DJ_MIN_RESTED_ARTISTS ? rested : pool)].slice(0, size)
}

const shortDate = (time: number | null) => time ? new Date(time).toISOString().slice(0, 7) : 'never'

// The song a request names ("play Hangman Jury"), when the library search found one whose title is in it.
export function namedSong(pool: Candidate[], input: DjSegmentInput): Candidate | undefined {
  const words = (text: string) => ` ${text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim()} `
  const request = input.justAsked && input.request ? words(input.request) : ''
  return request ? pool.filter((candidate) => candidate.sources.includes('request') && words(candidate.song.title).trim() && request.includes(words(candidate.song.title)))
    .sort((a, b) => b.song.title.length - a.song.title.length)[0] : undefined
}

export function djPrompt(pool: Candidate[], snapshot: LibrarySnapshot, input: DjSegmentInput): { prompt: string, refs: Map<string, SubsonicSong> } {
  const refs = new Map<string, SubsonicSong>()
  const named = namedSong(pool, input)
  const lines = pool.map((candidate, index) => {
    const ref = `t${index + 1}`
    refs.set(ref, candidate.song)
    const song = candidate.song
    const style = [song.bpm ? `${song.bpm} bpm` : '', ...styleOf(song)].filter(Boolean).join(', ')
    return `${ref} | ${song.artist} - ${song.title} | ${song.album}${song.year ? ` (${song.year})` : ''}${style ? ` | ${style}` : ''} | plays ${candidate.playCount}, last ${shortDate(candidate.lastPlayed)}${candidate.starred ? ', favourite' : ''} | ${candidate.sources.join(', ')}`
  })
  const prompt = [
    `Listener: ${input.username}. It is ${ukDate(input.now)}, ${partOfDay(input.now)} in the UK.`,
    input.first ? 'This is the first link of the session.' : 'The session is already under way.',
    `Artists they play most lately: ${snapshot.topArtists.join(', ') || 'not enough history yet'}.`,
    input.recentArtists.length ? `Played this session, so rest them unless asked: ${input.recentArtists.join(', ')}.` : '',
    input.request ? (input.justAsked ? `The listener just asked: "${input.request}"` : `Earlier the listener asked: "${input.request}". Keep to its style, mood or tempo but don't mention it.`) : '',
    named ? `They named ${named.song.artist} - ${named.song.title} (t${pool.indexOf(named) + 1}). Pick it first and name it.` : '',
    '',
    'Candidate songs:',
    ...lines,
  ].filter((line, index) => line !== '' || index > 0).join('\n')
  return { prompt, refs }
}

// Without Claude: a few songs from the pool, one per artist, and a simple spoken intro.
export function plainSegment(pool: Candidate[], input: DjSegmentInput): { tracks: MixTrack[], script: string } {
  const artists = new Set<string>()
  const named = namedSong(pool, input)
  const picked = (named ? [named, ...pool.filter((candidate) => candidate !== named)] : pool).filter((candidate) => !artists.has(candidate.song.artist) && artists.add(candidate.song.artist)).slice(0, 4).map((candidate) => toMixTrack(candidate.song))
  const first = picked[0]
  const greeting = input.first ? `Good ${partOfDay(input.now) === 'late night' ? 'evening' : partOfDay(input.now)}, ${input.username}. ` : ''
  const script = first ? `${greeting}Coming up, ${first.title} by ${first.artist}${picked.length > 1 ? `, then ${picked.length - 1} more from your library` : ''}.` : ''
  return { tracks: picked, script }
}

export interface DjDependencies { claude?: (env: Env, system: string, prompt: string, schema: object) => Promise<unknown> }

export async function buildSegment(env: Env, candidates: Candidate[], snapshot: LibrarySnapshot, input: DjSegmentInput, deps: DjDependencies = {}): Promise<Omit<DjSegment, 'voice'>> {
  // A request just made ("more Radiohead") may name a resting artist, so nobody is rested for that set; the sets
  // after it keep to its style but rest artists again, or the session would replay the same few. Claude is still told who played.
  const pool = djPool(candidates, input.recentTrackIds, `${input.username}:${input.now}`, DJ_POOL_SIZE, input.justAsked ? [] : input.recentArtists, input.request ? styleMatcher(input.request) : undefined)
  if (!pool.length) throw new Error('There is nothing left in the library the DJ hasn\'t just played.')
  if (env.ANTHROPIC_API_KEY) {
    try {
      const { prompt, refs } = djPrompt(pool, snapshot, input)
      const result = await (deps.claude ?? callClaudeJson)(env, DJ_SYSTEM, prompt, DJ_SCHEMA) as { script?: unknown, trackRefs?: unknown }
      // One song per artist in a set, whatever Claude returns.
      // A song the listener named plays first even if Claude leaves it out.
      const named = namedSong(pool, input)?.song
      const seen = new Set<string>()
      const tracks = [named, ...(Array.isArray(result.trackRefs) ? result.trackRefs : [])
        .map((ref) => typeof ref === 'string' ? refs.get(ref.trim()) : undefined)]
        .filter((song): song is SubsonicSong => Boolean(song) && !seen.has(song!.artist) && Boolean(seen.add(song!.artist)))
        .slice(0, 6).map(toMixTrack)
      let script = typeof result.script === 'string' ? result.script.trim().slice(0, MAX_SCRIPT_CHARS) : ''
      if (named && script && !script.toLowerCase().includes(named.title.toLowerCase())) script = `Here's ${named.title} by ${named.artist}. ${script}`
      if (tracks.length && script) return { tracks, script, curatedBy: 'claude' }
    } catch { /* fall through to the plain DJ */ }
  }
  return { ...plainSegment(pool, input), curatedBy: 'tomify' }
}

// A short reason for the panel: Workers AI errors arrive as long JSON, and running out of the free
// daily allowance (4006) is the common one.
export function voiceFailure(detail: string, status?: number, what = 'the DJ voice') {
  if (/\b4006\b|daily free allocation/i.test(detail)) return `Cloudflare's free daily allowance for ${what} is used up. It resets at midnight UTC, or move to the Workers Paid plan.`
  const parsed = /"message"\s*:\s*"([^"]+)"/.exec(detail)?.[1] ?? detail
  const reason = parsed.replace(/^\w*Error:\s*/, '').trim().slice(0, 120)
  return `${what[0].toUpperCase()}${what.slice(1)} failed${status ? ` (${status})` : ''}${reason ? `: ${reason}` : '.'}`
}

function base64(bytes: Uint8Array) {
  let text = ''
  for (let index = 0; index < bytes.length; index += 0x8000) text += String.fromCharCode(...bytes.subarray(index, index + 0x8000))
  return btoa(text)
}

// MeloTTS answers with base64 MP3 ({ audio }) or raw bytes, depending on the runtime.
export function meloAudio(result: unknown): Uint8Array | null {
  if (result instanceof Uint8Array) return result
  if (result instanceof ArrayBuffer) return new Uint8Array(result)
  const audio = result && typeof result === 'object' ? (result as { audio?: unknown }).audio : null
  if (typeof audio !== 'string' || !audio) return null
  return Uint8Array.from(atob(audio), (char) => char.charCodeAt(0))
}

export function createDjHandler(deps: DjDependencies & { fetcher?: typeof fetch } = {}): RouteHandler {
  return async (request, env, url) => {
    if (!['/api/dj/segment', '/api/dj/voice', '/api/dj/listen'].includes(url.pathname)) return null
    if (request.method !== 'POST') return json({ error: 'method-not-allowed' }, 405)
    const signedIn = await authenticate(request, env)
    if (!signedIn) return json({ error: 'unauthorized' }, 401)

    // A recording of the listener talking to the DJ (hold to talk), as text.
    if (url.pathname === '/api/dj/listen') {
      if (!env.AI) return json({ error: 'dj-listen-unavailable', message: 'Talking to the DJ needs the Workers AI binding (AI).' }, 503)
      const audio = new Uint8Array(await request.arrayBuffer())
      if (!audio.byteLength) return json({ error: 'invalid-dj-audio' }, 400)
      if (audio.byteLength > MAX_LISTEN_BYTES) return json({ error: 'dj-audio-too-long', message: 'That was too long for the DJ. Keep requests to a few seconds.' }, 413)
      try {
        const result = await env.AI.run(DJ_LISTEN_MODEL, { audio: base64(audio), language: 'en' } as never) as { text?: unknown }
        return json({ text: typeof result?.text === 'string' ? result.text.trim().slice(0, MAX_REQUEST_CHARS) : '' })
      } catch (error) {
        console.error('DJ listen failed', error)
        return json({ error: 'dj-listen-failed', message: voiceFailure(error instanceof Error ? error.message : String(error), undefined, 'the DJ\'s hearing') }, 502)
      }
    }

    const body = await request.json().catch(() => ({}))

    if (url.pathname === '/api/dj/voice') {
      if (!env.AI) return json({ error: 'dj-voice-unavailable', message: 'The DJ voice needs the Workers AI binding (AI).' }, 503)
      const text = typeof (body as { text?: unknown }).text === 'string' ? (body as { text: string }).text.trim().slice(0, MAX_SCRIPT_CHARS) : ''
      if (!text) return json({ error: 'invalid-dj-text' }, 400)
      let problem: string | null = null
      if (env.TOMIFY_DJ_VOICE_MODEL === 'aura') {
        try {
          const audio = await env.AI.run(DJ_TTS_MODEL, { text, speaker: env.TOMIFY_DJ_VOICE || DEFAULT_DJ_VOICE, encoding: 'mp3' } as never, { returnRawResponse: true }) as unknown as Response
          if (audio.ok) return new Response(audio.body, { headers: { 'content-type': 'audio/mpeg', 'cache-control': 'no-store', 'x-tomify-voice': 'aura' } })
          const detail = (await audio.text().catch(() => '')).slice(0, 200)
          console.error('DJ voice failed', audio.status, detail)
          problem = voiceFailure(detail, audio.status)
        } catch (error) {
          // Quota, model and binding errors are thrown rather than returned; say which, so the app can show it.
          console.error('DJ voice failed', error)
          problem = voiceFailure(error instanceof Error ? error.message : String(error))
        }
      }
      try {
        const bytes = meloAudio(await env.AI.run(DJ_BACKUP_TTS_MODEL, { prompt: text, lang: 'en' } as never) as unknown)
        if (!bytes?.byteLength) throw new Error('MeloTTS returned no audio.')
        const headers: Record<string, string> = { 'content-type': 'audio/mpeg', 'cache-control': 'no-store', 'x-tomify-voice': problem ? 'backup' : 'melotts' }
        if (problem) headers['x-tomify-voice-problem'] = encodeURIComponent(problem)
        return new Response(bytes, { headers })
      } catch (error) {
        console.error('DJ MeloTTS voice failed', error)
        return json({ error: 'dj-voice-failed', message: problem ?? voiceFailure(error instanceof Error ? error.message : String(error)) }, 502)
      }
    }

    if (!env.TOMIFY_DB) return json({ error: 'dj-store-unavailable' }, 503)
    const username = signedIn.toLowerCase()
    const now = Date.now()
    const input = { ...cleanSegmentRequest(body), username: signedIn, now }
    try {
      const stats = await listeningStats(env, username, now)
      const subsonic = subsonicForRequest(request, signedIn, env, deps.fetcher)
      const snapshot = await gatherLibrary(subsonic, stats)
      // A request naming a song or artist is searched for in the whole library, since the gathered songs are
      // only a sample of it; one naming one of the library's genres ("some deep house") brings in that genre too.
      if (input.request) {
        for (const query of input.justAsked ? requestSearches(input.request) : []) {
          const found = await subsonic<{ searchResult3?: { song?: unknown } }>('search3', { query, songCount: 20, artistCount: 0, albumCount: 0 }).catch(() => ({ searchResult3: undefined }))
          const songs = songsOf(found.searchResult3?.song)
          for (const song of songs) snapshot.songs.push({ song, source: 'request' })
          if (songs.length) break
        }
        const text = input.request.toLowerCase()
        const genres = await subsonic<{ genres?: { genre?: { value?: string }[] } }>('getGenres').catch(() => ({ genres: undefined }))
        const named = (genres.genres?.genre ?? []).map((genre) => genre.value ?? '').filter((genre) => genre.length > 2 && text.includes(genre.toLowerCase())).slice(0, 2)
        for (const genre of named) {
          const found = await subsonic<{ songsByGenre?: { song?: unknown } }>('getSongsByGenre', { genre, count: 100 }).catch(() => ({ songsByGenre: undefined }))
          for (const song of songsOf(found.songsByGenre?.song)) snapshot.songs.push({ song, source: `genre:${genre}` })
        }
      }
      const segment = await buildSegment(env, buildCandidates(snapshot, now), snapshot, input, deps)
      return json({ ...segment, voice: Boolean(env.AI) } satisfies DjSegment)
    } catch (error) {
      return json({ error: 'dj-segment-failed', message: `The DJ couldn't pick the next songs: ${error instanceof Error ? error.message : String(error)}` }, 502)
    }
  }
}

export const handleDjRequest = createDjHandler()
