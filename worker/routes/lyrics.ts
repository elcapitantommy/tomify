import type { RouteHandler } from '../env.ts'
import { handleLyricsRequest } from '../features/lyrics.ts'

export const lyricsRoute: RouteHandler = handleLyricsRequest
