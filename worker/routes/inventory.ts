import type { RouteHandler } from '../env.ts'
import { handleInventoryRequest } from '../features/inventory.ts'

export const inventoryRoute: RouteHandler = handleInventoryRequest
