import type { RouteHandler } from '../env.ts'
import { handleListeningRequest } from '../features/listening.ts'

export const listeningRoute: RouteHandler = handleListeningRequest
