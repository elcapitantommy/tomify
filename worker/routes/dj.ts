import type { RouteHandler } from '../env.ts'
import { handleDjRequest } from '../features/dj.ts'

export const djRoute: RouteHandler = handleDjRequest
