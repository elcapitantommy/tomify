import type { RouteHandler } from '../env.ts'
import { handleNewReleasesRequest } from '../features/new-releases.ts'

export const newReleasesRoute: RouteHandler = handleNewReleasesRequest
