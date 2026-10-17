import type { RouteHandler } from '../env.ts'
import { handleLivePlaybackRequest } from '../features/live-playback.ts'

export const livePlaybackRoute: RouteHandler = handleLivePlaybackRequest
