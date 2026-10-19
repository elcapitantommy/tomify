import { useEffect } from 'react'
import { bindParty } from '../stores/party'

// Keeps a running party in step with this device's player (see src/stores/party.ts).
export function PartyRuntime() {
  useEffect(() => bindParty(), [])
  return null
}
