import type { RouteHandler } from '../env.ts'
import { handlePushRequest } from '../features/push.ts'

export const pushRoute: RouteHandler = handlePushRequest
