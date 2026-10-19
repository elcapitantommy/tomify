import type { RouteHandler } from '../env.ts'
import { handlePartyRequest } from '../features/party.ts'

export const partyRoute: RouteHandler = handlePartyRequest
