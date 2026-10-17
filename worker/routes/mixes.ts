import type { RouteHandler } from '../env.ts'
import { handleMixesRequest } from '../features/mixes.ts'

export const mixesRoute: RouteHandler = handleMixesRequest
