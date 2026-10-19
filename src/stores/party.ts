import { create } from 'zustand'
import type { Track } from '../types'
import { nextPartyStep, partyHostApi, type HostParty, type PartyOptions } from '../lib/party'
import { usePlayer } from './player'

// The host's side of party mode. While a party runs, PartyRuntime polls it, reports what is playing for guests,
// and puts the next guest track straight after the current one.
const POLL_MS = 5000

interface PartyState extends HostParty {
  loaded: boolean
  error: string | null
  refresh(): Promise<void>
  start(options: PartyOptions): Promise<void>
  update(options: PartyOptions): Promise<void>
  end(): Promise<void>
  remove(itemId: string): Promise<void>
  removeGuest(guestId: string): Promise<void>
}

const failed = (error: unknown) => error instanceof Error ? error.message : 'Party mode is unavailable.'

export const useParty = create<PartyState>((set) => {
  const apply = (result: HostParty) => set({ party: result.party, nowPlaying: result.nowPlaying ?? null, queue: result.queue ?? [], guests: result.guests ?? [], loaded: true, error: null })
  const run = async (action: () => Promise<HostParty>) => { try { apply(await action()) } catch (error) { set({ error: failed(error), loaded: true }) } }
  return {
    party: null, queue: [], guests: [], nowPlaying: null, loaded: false, error: null,
    refresh: () => run(partyHostApi.load),
    start: (options) => run(async () => { const result = await partyHostApi.start(options); hostHere(result.party?.id); return result }),
    update: (options) => run(() => partyHostApi.update(options)),
    end: async () => { try { await partyHostApi.end(); apply({ party: null }) } catch (error) { set({ error: failed(error) }) } },
    remove: (itemId) => run(() => partyHostApi.remove(itemId)),
    removeGuest: (guestId) => run(() => partyHostApi.removeGuest(guestId)),
  }
})

function playNext(track: Track) {
  const player = usePlayer.getState()
  const finished = !player.playing && player.currentIndex >= player.queue.length - 1 && player.duration > 0 && player.currentTime >= player.duration - 1
  if (!player.queue.length || player.currentIndex < 0 || finished) { player.playTracks([...player.queue, track], player.queue.length, { keepOrder: true }); return }
  const at = player.currentIndex + 1
  usePlayer.setState({ queue: [...player.queue.slice(0, at), track, ...player.queue.slice(at)], unshuffledQueue: player.unshuffledQueue ? [...player.unshuffledQueue, track] : null, activitySerial: player.activitySerial + 1 })
}

// Only the device that is playing (or that started the party) feeds the player, so a second open tab on the
// host's account doesn't add every track twice.
const HOST_KEY = 'tomify-party-host'
function hostHere(id?: string) { try { if (id) sessionStorage.setItem(HOST_KEY, id) } catch { /* private mode */ } }
function isHostHere(id: string) { try { return sessionStorage.getItem(HOST_KEY) === id } catch { return false } }

let syncing = false
let reportedId: string | null | undefined
export async function syncParty() {
  const state = useParty.getState()
  const player = usePlayer.getState()
  if (!state.party || syncing || !(player.playing || isHostHere(state.party.id))) return
  syncing = true
  try {
    const current = player.queue[player.currentIndex] ?? null
    let result: HostParty | null = null
    if ((current?.id ?? null) !== reportedId) { result = await partyHostApi.update({ nowPlaying: current }); reportedId = current?.id ?? null }
    const { played, add } = nextPartyStep(result?.queue ?? state.queue ?? [], player.queue, player.currentIndex)
    for (const item of played) result = await partyHostApi.setState(item.id, 'played')
    if (add) { playNext(add.track); result = await partyHostApi.setState(add.id, 'queued') }
    if (result) useParty.setState({ party: result.party, nowPlaying: result.nowPlaying ?? null, queue: result.queue ?? [], guests: result.guests ?? [] })
  } catch (error) {
    useParty.setState({ error: failed(error) })
  } finally {
    syncing = false
  }
}

// Mounted once in the app shell: finds out whether this account has a party running, then keeps it in step.
export function bindParty() {
  let stopped = false
  const tick = async () => { await useParty.getState().refresh(); if (!stopped) await syncParty() }
  void tick()
  const timer = window.setInterval(() => { if (useParty.getState().party) void tick() }, POLL_MS)
  const unsubscribe = usePlayer.subscribe((next, previous) => { if (next.currentIndex !== previous.currentIndex || next.queue !== previous.queue) void syncParty() })
  return () => { stopped = true; window.clearInterval(timer); unsubscribe() }
}
