import type { RouteHandler } from '../env.ts'
import { handleLibraryMovesRequest } from '../features/library-moves.ts'

export const libraryMovesRoute: RouteHandler = handleLibraryMovesRequest
