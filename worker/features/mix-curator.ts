// Asks Claude to turn a pool of candidate songs from the library into named mixes.
// Claude only sees song references (t1, t2, ...) from the pool, so every song it picks is one you own.
// This calls the Messages API with fetch rather than the Anthropic SDK: the SDK would more than triple the
// Worker bundle, which is kept under 150 KB.
import type { Env } from '../env.ts'

const MESSAGES_URL = 'https://api.anthropic.com/v1/messages'

export const DEFAULT_MIXES_MODEL = 'claude-sonnet-5-5'

export interface CuratorRequest { profile: string, candidates: string }
export interface CuratedMix { title: string, description: string, trackRefs: string[] }

export const CURATOR_SYSTEM = `You build the "Made for you" mixes for Tomify, a personal music player for one household's own music library.

You get a listener profile and a pool of candidate songs from their library. Each candidate line is:
ref | artist - title | album (year, genre) | listening history | why it is in the pool

Build 5 or 6 mixes of 15 to 25 songs each, using only refs from the pool.
- Give each mix a distinct purpose: for example what they have on repeat, a mix around an artist they love, old favourites they haven't played in a while, unplayed songs from new or loved artists, or a mood or era running through the pool.
- Order each mix so it flows, and avoid the same artist twice in a row.
- Leave out songs the history shows they skip.
- A song can appear in more than one mix, but keep overlap small.
- Titles are short and warm (at most 5 words). Descriptions are one plain sentence saying what the mix is and why it suits them, in British English.`

const MIX_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['mixes'],
  properties: {
    mixes: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['title', 'description', 'trackRefs'],
        properties: {
          title: { type: 'string' },
          description: { type: 'string' },
          trackRefs: { type: 'array', items: { type: 'string' } },
        },
      },
    },
  },
} as const

export function parseCuratedMixes(text: string): CuratedMix[] {
  const parsed = JSON.parse(text) as { mixes?: unknown }
  if (!parsed || !Array.isArray(parsed.mixes)) throw new Error('Claude did not return any mixes.')
  return parsed.mixes.filter((mix): mix is CuratedMix => Boolean(mix && typeof mix.title === 'string' && typeof mix.description === 'string' && Array.isArray(mix.trackRefs)))
    .map((mix) => ({ title: mix.title, description: mix.description, trackRefs: mix.trackRefs.filter((ref): ref is string => typeof ref === 'string') }))
}

interface MessagesResponse { stop_reason?: string, content?: { type: string, text?: string }[], error?: { message?: string } }

// Models that accept the server-side refusal fallback ("default" form); others (such as Haiku) don't.
const FALLBACK_MODELS = /^claude-(sonnet-5-5|opus-5|opus-5-5|fable-5-1)$/

export async function curateMixesWithClaude(env: Env, request: CuratorRequest, fetcher: typeof fetch = fetch): Promise<CuratedMix[]> {
  const model = env.TOMIFY_MIXES_MODEL || DEFAULT_MIXES_MODEL
  const fallback = FALLBACK_MODELS.test(model)
  const response = await fetcher(MESSAGES_URL, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': env.ANTHROPIC_API_KEY || '',
      'anthropic-version': '2023-06-01',
      // If the model declines, the API retries on a fallback model it picks, inside the same call.
      ...(fallback ? { 'anthropic-beta': 'server-side-fallback-2026-07-01' } : {}),
    },
    body: JSON.stringify({
      model,
      max_tokens: 16000,
      ...(fallback ? { fallbacks: 'default' } : {}),
      output_config: { effort: 'low', format: { type: 'json_schema', schema: MIX_SCHEMA } },
      system: CURATOR_SYSTEM,
      messages: [{ role: 'user', content: `Listener profile:\n${request.profile}\n\nCandidate songs:\n${request.candidates}` }],
    }),
  })
  const body = await response.json().catch(() => ({})) as MessagesResponse
  if (!response.ok) throw new Error(`Claude API ${response.status}${body.error?.message ? `: ${body.error.message}` : ''}`)
  if (body.stop_reason === 'refusal') throw new Error('Claude declined to build mixes.')
  if (body.stop_reason === 'max_tokens') throw new Error('Claude ran out of room before finishing the mixes.')
  return parseCuratedMixes((body.content ?? []).map((block) => block.type === 'text' ? block.text ?? '' : '').join(''))
}
