import type { RouteHandler } from '../env.ts'
import { handleCatalogueRequest } from '../features/catalogue.ts'

export const catalogueRoute: RouteHandler = handleCatalogueRequest
